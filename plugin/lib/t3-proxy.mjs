import http from "node:http";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";
import { HttpError } from "./state.mjs";
import { injectShell } from "./mobile-shell.mjs";
const read = (method) => method === "GET" || method === "HEAD";
const allowedReadPost = new Set(["/api/pull-requests/diff"]);
function checkHttp(path, method, actions) {
  // Only grant the mobile origin the native UI's data plane. Never forward host
  // administration, OAuth, credential minting, extension panels or alternate tunnels.
  if (path.startsWith("/api/")) {
    if (
      !/^\/api\/(?:auth\/session$|orchestration(?:\/|$)|projects(?:\/|$)|pull-requests\/diff$|attachments(?:\/|$)|assets(?:\/|$)|voice\/(?:transcribe|post-process)$)/.test(
        path,
      )
    )
      throw new HttpError(403, "Desktop-only endpoint");
    if (!read(method) && !actions && !allowedReadPost.has(path))
      throw new HttpError(403, "Read-only device");
  } else if (
    !read(method) ||
    /^\/(?:oauth|mcp|ws|api|mobile|auth|\.well-known(?!\/t3\/environment$))(?:\/|$)/i.test(
      path,
    )
  )
    throw new HttpError(403, "Desktop-only endpoint");
}
export function requestUrl(raw) {
  if (
    typeof raw !== "string" ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[\\#\x00-\x20]/.test(raw)
  )
    throw new HttpError(400, "Invalid path");
  const path = raw.split("?")[0];
  if (/%(?:2f|5c|25|00|2e)|(?:^|\/)\.{1,2}(?:\/|$)|\/\//i.test(path))
    throw new HttpError(400, "Noncanonical path");
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, "Invalid path");
  }
  // Never classify an encoded spelling differently from the upstream router.
  if (
    path !== decoded &&
    (!(path.startsWith("/assets/") || path.startsWith("/api/assets/")) ||
      /[?#\x00-\x1f]/.test(decoded))
  )
    throw new HttpError(400, "Noncanonical path");
  return new URL(raw, "http://localhost");
}
export function checkOrigin(req) {
  if (
    (req.headers.origin &&
      req.headers.origin !== `https://${req.headers.host}`) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    throw new HttpError(403, "Foreign origin");
}
// A deep link is a client-side SPA route, not an arbitrary loopback URL. Serve
// the host index for these paths. Only known data/static namespaces are sent as-is.
function upstreamPath(url) {
  if (
    url.pathname === "/" ||
    /^\/(?:api|assets)\//.test(url.pathname) ||
    url.pathname === "/.well-known/t3/environment" ||
    /^\/(?:index\.html|manifest\.webmanifest|third-party-licenses\.json|favicon(?:-[\dx]+)?\.(?:ico|png)|(?:apple-touch-icon|icon-[\dx]+)\.png)$/.test(
      url.pathname,
    )
  )
    return url.pathname + url.search;
  return "/";
}
const passHeaders = [
  "accept",
  "accept-language",
  "content-type",
  "range",
  "x-t3-orchestration-protocol",
];
const replyHeaders = [
  "content-type",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "content-encoding",
];
const controls = new Set(["Ping", "Ack", "Interrupt", "Eof"]);
// Forward RPC bytes unmodified when allowed. Keep desktop administration out of
// the writable session and deny new methods until explicitly reviewed.
const readRpc = new Set([
  "orchestration.getTurnDiff",
  "orchestration.getFullThreadDiff",
  "orchestration.searchThreads",
  "orchestration.searchThread",
  "orchestration.searchThreadStream",
  "orchestration.getArchivedShellSnapshot",
  "orchestration.getThreadFamily",
  "orchestration.getThreadTitles",
  "orchestration.getThreadLinkMetadata",
  "orchestration.getWorktreeThreadIds",
  "orchestration.getOlderSettledThreads",
  "orchestration.getThreadProjection",
  "orchestration.getWorkflowScript",
  "orchestration.getNativeChildWork",
  "orchestration.getTurnItem",
  "orchestration.subscribeShell",
  "orchestration.subscribeThread",
  "orchestration.subscribeCommandOutput",
  "orchestration.subscribePromptSuggestion",
  "server.getConfig",
  "server.getSettings",
  "server.probe",
  "subscribeServerConfig",
  "subscribeServerLifecycle",
  "projects.listEntries",
  "projects.searchEntries",
  "subscribeVcsStatus",
  "subscribeVcsBranch",
]);
const writeRpc = new Set([
  "orchestration.dispatchCommand",
  "orchestration.launchThread",
  "orchestration.forceStopThread",
  "orchestration.stopWorkflow",
  "assets.createUrl",
  "assets.persistChatAttachments",
  "attachments.createUploadUrl",
  "attachments.delete",
  "projects.ensureScratch",
  "projects.createNew",
  "projects.createFromThread",
  "projects.mutate",
]);
const terminalRpc = new Set([
  "terminal.open",
  "terminal.attach",
  "terminal.observe",
  "terminal.write",
  "terminal.resize",
  "terminal.clear",
  "terminal.close",
  "subscribeTerminalMetadata",
]);
function permitted(method, cfg) {
  return (
    readRpc.has(method) ||
    (cfg.actions &&
      (writeRpc.has(method) || (cfg.terminal && terminalRpc.has(method))))
  );
}
function forwardRpc(bytes, binary, from, to, cfg, mayWrite) {
  const value = JSON.parse(bytes.toString("utf8")),
    batch = Array.isArray(value),
    messages = batch ? value : [value];
  const ok = [];
  for (const msg of messages) {
    if (
      controls.has(msg?._tag) ||
      (msg?._tag === "Request" &&
        permitted(msg.tag, cfg) &&
        (readRpc.has(msg.tag) ||
          mayWrite(msg.payload?.command?.threadId ?? msg.payload?.threadId)))
    )
      ok.push(msg);
    else if (
      msg?._tag === "Request" &&
      (typeof msg.id === "number" || typeof msg.id === "string")
    ) {
      from.send(
        JSON.stringify({
          _tag: "Exit",
          requestId: msg.id,
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Die", defect: "Mobile permission denied" }],
          },
        }),
      );
    } else throw Error("Unsupported RPC envelope");
  }
  if (ok.length)
    to.send(
      ok.length === messages.length
        ? bytes
        : JSON.stringify(batch ? ok : ok[0]),
      { binary },
    );
}
export class Proxy {
  constructor(ctx, mayWrite = () => true) {
    this.mayWrite = mayWrite;
    this.ctx = ctx;
    this.epoch = 0;
    this.links = new Set();
    this.wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: 8 << 20,
    });
  }
  invalidate(id) {
    if (!id) {
      this.epoch++;
      this.cached = null;
      this.pending = null;
    }
    for (const entry of this.links) if (!id || id === entry.id) entry.abort();
  }
  async session(actions) {
    if (
      this.cached?.actions === actions &&
      this.cached.until > Date.now() + 30000
    )
      return this.cached;
    if (this.pending?.actions === actions) return this.pending.task;
    const epoch = this.epoch;
    const entry = { actions };
    this.pending = entry;
    entry.task = (async () => {
      const s = await this.ctx.issueLocalSession({
        label: "t3-mobile-link",
        readOnly: !actions,
      });
      if (!s || epoch !== this.epoch)
        throw new HttpError(503, "Host session unavailable");
      const until = s.expiresAt ? Date.parse(s.expiresAt) : Date.now() + 300000;
      if (!Number.isFinite(until) || until <= Date.now())
        throw new HttpError(503, "Invalid host session expiry");
      return (this.cached = {
        cookie: `${s.cookieName}=${s.cookieValue}`,
        until,
        actions,
      });
    })().finally(() => {
      if (this.pending === entry) this.pending = null;
    });
    return entry.task;
  }
  origin() {
    const u = new URL(this.ctx.getServerInfo().localOrigin);
    if (
      u.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
      throw new HttpError(503, "Expected a loopback host");
    return u;
  }
  async healthy(actions) {
    try {
      const { cookie } = await this.session(actions);
      const r = await fetch(new URL("/api/auth/session", this.origin()), {
        headers: { cookie },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      return r.ok && (await r.json()).authenticated === true;
    } catch {
      return false;
    }
  }
  async http(req, res, url, cfg, id, valid) {
    checkHttp(url.pathname, req.method, cfg.actions);
    if (
      !read(req.method) &&
      !allowedReadPost.has(url.pathname) &&
      !this.mayWrite()
    )
      throw new HttpError(409, "Source fenced");
    const { cookie } = await this.session(cfg.actions);
    valid();
    const origin = this.origin(),
      headers = {
        host: origin.host,
        origin: origin.origin,
        cookie,
        "accept-encoding": "identity",
      };
    for (const key of passHeaders)
      if (req.headers[key]) headers[key] = req.headers[key];
    const upstream = http.request(origin, {
      path: upstreamPath(url),
      method: req.method,
      headers,
      timeout: 30000,
    });
    const link = {
      id,
      abort: () => {
        upstream.destroy();
        res.destroy();
      },
    };
    this.links.add(link);
    res.once("close", () => {
      this.links.delete(link);
      upstream.destroy();
    });
    upstream.on("timeout", () => upstream.destroy(Error("Host timed out")));
    const result = new Promise((resolve, reject) =>
      upstream.once("response", resolve).once("error", reject),
    );
    req.pipe(upstream);
    const response = await result;
    try {
      if (response.statusCode >= 300 && response.statusCode < 400)
        throw new HttpError(502, "Upstream redirect refused");
      const h = {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      };
      for (const k of replyHeaders)
        if (response.headers[k]) h[k] = response.headers[k];
      // Assets/attachments may be untrusted HTML: never install a native bridge there.
      const doc =
        read(req.method) &&
        req.method !== "HEAD" &&
        /^text\/html\b/i.test(h["content-type"] ?? "") &&
        !/^\/(?:api|assets|attachments|\.well-known)(?:\/|$)/.test(
          url.pathname,
        ) &&
        response.statusCode === 200;
      if (doc) {
        if (h["content-encoding"] && h["content-encoding"] !== "identity")
          throw new HttpError(502, "Expected identity encoding");
        const chunks = [];
        let n = 0;
        for await (const chunk of response) {
          if ((n += chunk.length) > 4 << 20)
            throw new HttpError(502, "Document too large");
          chunks.push(chunk);
        }
        res.writeHead(response.statusCode, h);
        res.end(injectShell(Buffer.concat(chunks).toString("utf8")));
      } else {
        res.writeHead(response.statusCode, h);
        await pipeline(response, res);
      }
    } finally {
      response.destroy();
    }
  }
  async upgrade(req, socket, head, url, cfg, id, valid) {
    if (url.pathname !== "/ws") throw new HttpError(404, "Unknown socket");
    const session = await this.session(cfg.actions);
    valid();
    url.searchParams.delete("wsTicket");
    url.searchParams.delete("dpop");
    const origin = this.origin();
    const dest = new URL("/ws" + url.search, origin);
    dest.protocol = "ws:";
    const protocols = req.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((x) => x.trim());
    const upstream = new WebSocket(dest, protocols, {
      headers: { cookie: session.cookie, origin: origin.origin },
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      maxPayload: 16 << 20,
    });
    let client, timer;
    const abort = () => {
      upstream.terminate();
      client?.terminate();
      socket.destroy();
    };
    const link = { id, abort };
    this.links.add(link);
    socket.on("error", abort);
    socket.once("close", () => {
      this.links.delete(link);
      clearInterval(timer);
      upstream.terminate();
    });
    upstream.on("error", () => {
      if (!client && !socket.destroyed)
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      else client?.terminate();
    });
    upstream.on("close", () =>
      client ? client.close(1001, "Host disconnected") : socket.end(),
    );
    upstream.once("open", () => {
      try {
        valid();
        // Only advertise the subprotocol selected by the real host.
        if (upstream.protocol)
          req.headers["sec-websocket-protocol"] = upstream.protocol;
        else delete req.headers["sec-websocket-protocol"];
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          client = ws;
          ws.on("error", abort);
          timer = setInterval(() => {
            try {
              valid();
              if (Date.now() >= session.until) abort();
            } catch {
              abort();
            }
          }, 5000);
          timer.unref();
          ws.on("message", (data, binary) => {
            try {
              valid();
              if (Date.now() >= session.until) throw Error();
              if (upstream.bufferedAmount > 16 << 20) throw Error();
              forwardRpc(data, binary, ws, upstream, cfg, this.mayWrite);
            } catch {
              ws.close(1008, "Mobile policy");
            }
          });
          upstream.on("message", (data, binary) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 16 << 20) abort();
            else ws.send(data, { binary });
          });
        });
      } catch {
        abort();
      }
    });
  }
}
