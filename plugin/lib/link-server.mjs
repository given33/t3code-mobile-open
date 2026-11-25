import { Relay } from "./sync/handoff.mjs";
import { injectShell } from "./mobile-shell.mjs";
import https from "node:https";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { identity } from "./identity.mjs";
import { Devices, COOKIE, COOKIE_TTL } from "./devices.mjs";
import { endpoint, hosts, Limit, PairCode } from "./pair-link.mjs";
import { familyRoute } from "./family.mjs";
import { probePeer } from "./pinned.mjs";
import { HttpError, readState, writeState } from "./state.mjs";
import { Proxy, checkOrigin, requestUrl } from "./t3-proxy.mjs";
import { shellJs, shellCss } from "./mobile-shell.mjs";
const appVersion = createRequire(import.meta.url)("../package.json").version;
const defaults = {
  enabled: false,
  actions: false,
  terminal: false,
  host: "0.0.0.0",
  port: 3081,
  name: "T3 Code",
  role: "local",
  extraHosts: [],
  tunnels: [],
};
function config(values) {
  const c = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      values[key] ?? fallback,
    ]),
  );
  if (
    ["enabled", "actions", "terminal"].some((k) => typeof c[k] !== "boolean") ||
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    !["local", "cloud"].includes(c.role) ||
    typeof c.name !== "string" ||
    !c.name.trim() ||
    Buffer.byteLength(c.name) > 96 ||
    typeof c.host !== "string" ||
    !c.host ||
    !/^[\w.:-]+$/.test(c.host)
  )
    throw new HttpError(400, "Invalid listener configuration");
  for (const k of ["extraHosts", "tunnels"]) {
    if (!Array.isArray(c[k]) || c[k].length > 6)
      throw new HttpError(400, "Invalid endpoint list");
    c[k] = c[k].map(endpoint);
  }
  if (c.extraHosts.join("").length + c.tunnels.join("").length > 640)
    throw new HttpError(400, "Too many advertised endpoints");
  return c;
}
function send(res, status, value, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(type === "application/json" ? JSON.stringify(value) : value);
}
async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new HttpError(415, "Expected JSON");
  let n = 0;
  const parts = [];
  for await (const chunk of req) {
    if ((n += chunk.length) > 4096) throw new HttpError(413, "Body too large");
    parts.push(chunk);
  }
  try {
    const obj = JSON.parse(Buffer.concat(parts));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw Error();
    return obj;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
export class LinkServer {
  constructor(ctx, initial = {}) {
    this.ctx = ctx;
    this.dir = ctx.stateDir;
    this.cfg = config({
      ...initial,
      ...readState(this.dir, "settings.json", {}),
    });
    this.ident = identity(this.dir);
    this.devices = new Devices(this.dir);
    this.relay = new Relay(ctx, initial.taskSync, undefined, () => this.cfg.enabled && this.cfg.actions);
    this.proxy = new Proxy(ctx, (threadId) => this.relay.mayWrite(threadId));
    this.pair = new PairCode();
    this.helloLimit = new Limit(90, 60000);
    this.pairLimit = new Limit(100, 60000);
    this.tickets = new Map();
    this.sockets = new Set();
    this.queue = Promise.resolve();
  }
  host() {
    return {
      id: this.ident.id,
      name: this.cfg.name,
      role: familyRoute(this.dir)?.role ?? this.cfg.role,
    };
  }
  meta() {
    return {
      host: this.host(),
      actions: this.cfg.actions,
      terminal: this.cfg.actions && this.cfg.terminal,
      family: familyRoute(this.dir),
    };
  }
  async panelState() {
    const meta = this.meta(),
      listening = this.server?.listening ?? false,
      addresses = listening ? hosts(this.cfg, this.cfg.port) : [];
    const key = JSON.stringify(meta.family?.peer);
    if (
      meta.family &&
      (this.peer?.key !== key || this.peer.expires < Date.now())
    )
      this.peer = {
        key,
        expires: Date.now() + 10000,
        probe: probePeer(meta.family.peer),
      };
    const peerOnline = meta.family ? await this.peer.probe : null;
    return {
      ...meta,
      config: this.cfg,
      relay: this.relay.status(),
      listening,
      addresses,
      safetyCode: this.ident.safetyCode,
      pairing: listening
        ? this.pair.link(meta.host, this.ident.fingerprint, addresses)
        : null,
      devices: this.devices.list(),
      peerOnline,
    };
  }
  async start() {
    if (this.server) return;
    const s = https.createServer(
      {
        key: this.ident.key,
        cert: this.ident.cert,
        minVersion: "TLSv1.2",
        headersTimeout: 10000,
        requestTimeout: 30000,
      },
      (req, res) => {
        this.handle(req, res).catch((e) => {
          if (!res.headersSent && !res.destroyed)
            send(res, e.status ?? 502, {
              error: e.status ? e.message : "Mobile service unavailable",
            });
          else res.destroy();
        });
      },
    );
    s.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    s.on("upgrade", (req, socket, head) => {
      Promise.resolve()
        .then(() => {
          const url = requestUrl(req.url);
          checkOrigin(req);
          const d = this.devices.auth(req.headers),
            cfg = this.cfg;
          if (url.searchParams.has("wsTicket")) {
            const ticket = this.tickets.get(d.id);
            this.tickets.delete(d.id);
            if (
              !ticket ||
              ticket.value !== url.searchParams.get("wsTicket") ||
              ticket.until <= Date.now()
            )
              throw new HttpError(401, "Invalid mobile socket ticket");
          }
          return this.proxy.upgrade(req, socket, head, url, cfg, d.id, () =>
            this.validate(req, d, cfg),
          );
        })
        .catch((e) => {
          if (!socket.destroyed)
            socket.end(
              `HTTP/1.1 ${e.status ?? 502} Request rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            );
        });
    });
    await new Promise((resolve, reject) => {
      s.once("error", reject);
      s.listen(this.cfg.port, this.cfg.host, () => {
        s.off("error", reject);
        resolve();
      });
    });
    this.server = s;
    this.pair.refresh();
  }
  validate(req, d, cfg) {
    if (
      !this.server ||
      this.cfg !== cfg ||
      this.devices.auth(req.headers).id !== d.id
    )
      throw new HttpError(401, "Device session changed");
  }
  configure(patch) {
    const run = this.queue.then(async () => {
      if (
        !patch ||
        !Object.keys(patch).length ||
        Object.keys(patch).some(
          (k) =>
            !["enabled", "actions", "terminal"].includes(k) ||
            typeof patch[k] !== "boolean",
        )
      )
        throw new HttpError(400, "Invalid permission update");
      const before = this.cfg,
        next = config({ ...before, ...patch });
      this.cfg = next;
      this.proxy.invalidate();
      try {
        if (next.enabled) await this.start();
        else await this.stop();
        const stored = readState(this.dir, "settings.json", {});
        writeState(this.dir, "settings.json", { ...stored, ...patch });
      } catch (e) {
        this.cfg = before;
        if (!before.enabled) await this.stop();
        else await this.start();
        throw e;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  revoke(id) {
    this.devices.revoke(id);
    this.tickets.delete(id);
    this.proxy.invalidate(id);
  }
  async stop() {
    this.proxy.invalidate();
    this.pair.code = null;
    this.devices.cookies.clear();
    this.tickets.clear();
    const s = this.server;
    this.server = null;
    if (s) {
      const done = new Promise((resolve) => s.close(resolve));
      for (const socket of this.sockets) socket.destroy();
      await done;
    }
  }
  async handle(req, res) {
    const url = requestUrl(req.url);
    checkOrigin(req);
    const path = url.pathname,
      m = req.method,
      address = req.socket.remoteAddress;
    if (m === "GET" && path === "/mobile/v1/hello") {
      this.helloLimit.take(address);
      return send(res, 200, {
        protocol: 1,
        backend: "t3code",
        appVersion,
        host: this.host(),
        fingerprint: this.ident.fingerprint,
      });
    }
    if (m === "POST" && path === "/mobile/v1/pair") {
      this.pairLimit.take("*");
      const b = await body(req);
      this.pair.consume(b.code, address);
      return send(res, 200, {
        ...this.meta(),
        ...this.devices.add(b.name ?? b.deviceName),
      });
    }
    const d = this.devices.auth(req.headers, path === "/mobile/v1/web-session");
    if (path === "/mobile/v1/web-session" && m === "POST") {
      res.setHeader(
        "set-cookie",
        `${COOKIE}=${this.devices.cookie(d)}; Path=/; Max-Age=${COOKIE_TTL / 1000}; Secure; HttpOnly; SameSite=Strict`,
      );
      return send(res, 200, { ...this.meta(), cookieName: COOKIE });
    }
    if (path === "/mobile/v1/relay/status" && m === "GET")
      return send(res, 200, this.relay.status());
    if (
      ["/mobile/v1/relay/handoff", "/mobile/v1/relay/checkpoint"].includes(
        path,
      ) &&
      m === "POST"
    ) {
      const cfg = this.cfg;
      if (!cfg.actions) throw new HttpError(403, "Read-only device");
      const b = await body(req);
      this.validate(req, d, cfg);
      if (!this.relay.enabled) throw new HttpError(409, "Relay disabled");
      const value = path.endsWith("/checkpoint")
        ? this.relay.track(b)
        : await this.relay.handoff(b);
      return send(res, 200, value);
    }
    if (m === "GET" && path.startsWith("/mobile/v1/relay/claims/")) {
      const id = path.slice("/mobile/v1/relay/claims/".length);
      const pack =
        this.relay.enabled && this.relay.lease.read("claims", id)?.pack;
      if (!pack) throw new HttpError(404, "No claimed checkpoint");
      return send(res, 200, {
        ok: true,
        status: "claimed",
        handoffId: id,
        targetRole: this.relay.role,
        ...this.relay.claimResult(id),
        sourceRevision: pack.sourceRevision,
      });
    }
    if (path.startsWith("/relay-inbox/") && m === "GET") {
      const id = path.slice("/relay-inbox/".length);
      const pack =
        this.relay.enabled && this.relay.lease.read("claims", id)?.pack;
      if (!pack) throw new HttpError(404, "No claimed checkpoint");
      const text = (s) =>
        s
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      res.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      return send(
        res,
        200,
        injectShell(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>接力收件箱</title></head><body><h1>${text(pack.title || "会话交接")}</h1><p>${text(pack.threadId)} · ${text(pack.sourceRole)}</p><pre>${text(pack.summary)}</pre><strong>${text(pack.stepBoundary)}</strong><p>${text(pack.continuationPrompt)}</p><a href="/">打开此设备的 T3 工作区</a></body></html>`,
        ),
        "text/html; charset=utf-8",
      );
    }
    if (path === "/mobile/v1/sync" && m === "GET")
      return send(res, 200, {
        ...this.meta(),
        ok: true,
        ...(this.relay.enabled ? { relay: this.relay.status() } : {}),
        upstreamOk: await this.proxy.healthy(this.cfg.actions),
        environmentId: this.ctx.getServerInfo().environmentId,
        serverTimeMs: Date.now(),
      });
    if (path === "/mobile/v1/unpair" && m === "POST") {
      this.revoke(d.id);
      return send(res, 200, { ok: true });
    }
    if (path === "/mobile/v1/shell.css" && m === "GET")
      return send(res, 200, shellCss, "text/css; charset=utf-8");
    if (path === "/mobile/v1/shell.js" && m === "GET")
      return send(res, 200, shellJs, "application/javascript; charset=utf-8");
    if (path.startsWith("/mobile/"))
      throw new HttpError(404, "Unknown mobile endpoint");
    // Some native clients request a WS ticket even with browser cookies. Never
    // release a real T3 ticket: /ws independently authenticates the mobile cookie.
    if (
      m === "POST" &&
      ["/api/auth/websocket-ticket", "/api/auth/websocket-ticket/rpc"].includes(
        path,
      )
    ) {
      const value = randomBytes(24).toString("base64url"),
        until = Date.now() + 30000;
      this.tickets.set(d.id, { value, until });
      return send(res, 200, {
        ticket: value,
        expiresAt: new Date(until).toISOString(),
      });
    }
    const cfg = this.cfg;
    return this.proxy.http(req, res, url, cfg, d.id, () =>
      this.validate(req, d, cfg),
    );
  }
}
