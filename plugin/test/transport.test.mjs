import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { WebSocketServer } from "ws";
import { temp, port, mobile, openWs, deadline } from "./helpers.mjs";
import { LinkServer } from "../lib/link-server.mjs";
import { panel } from "../lib/panel.mjs";
import { writeState } from "../lib/state.mjs";
import { probePeer } from "../lib/pinned.mjs";

test("desktop panel, pinned listener, HTTP and WSS data plane, permission transitions and revocation", async (t) => {
  const home = temp();
  t.after(home.clean);
  let observed, upgrade;
  const scopes = [],
    requests = [];
  const upstream = http.createServer((req, res) => {
    observed = req.headers;
    if (req.url === "/api/auth/session") {
      res.setHeader("content-type", "application/json");
      res.end('{"authenticated":true}');
      return;
    }
    res.setHeader(
      "content-type",
      req.url === "/" ? "text/html; charset=utf-8" : "application/json",
    );
    res.setHeader("set-cookie", "private=upstream; HttpOnly");
    res.end(
      req.url === "/"
        ? "<html><head><title>Original</title></head><body>Original app</body></html>"
        : "{}",
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const localOrigin = "http://127.0.0.1:" + upstream.address().port;
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on("connection", (ws, req) => {
    upgrade = req;
    ws.on("message", (b, isBinary) => {
      requests.push(JSON.parse(b));
      ws.send(b, { binary: isBinary });
    });
  });
  t.after(async () => {
    wsServer.close();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });
  const ctx = {
    stateDir: home.dir,
    getServerInfo: () => ({ localOrigin, environmentId: "test-env" }),
    issueLocalSession: async (opts) => {
      scopes.push(opts);
      return {
        cookieName: "host_sid",
        cookieValue: "host-only-fixture",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    },
  };
  const p = await port(),
    svc = new LinkServer(ctx, { host: "127.0.0.1", port: p }),
    handle = panel(svc);
  t.after(() => svc.stop());
  const panelCall = (path = "", data) =>
    handle(
      new Request("http://localhost/panel" + path, {
        method: data ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: data && JSON.stringify(data),
      }),
      "/panel" + path,
    );
  assert.equal((await (await panelCall("/api/state")).json()).listening, false);
  assert.equal((await panelCall("/api/refresh", {})).status, 409);
  assert.equal(
    (await panelCall("/api/config", { actions: "true" })).status,
    400,
  );
  assert.equal((await panelCall("/api/config", { enabled: true })).status, 200);
  let state = await (await panelCall("/api/state")).json();
  const uri = new URL(state.pairing.uri),
    pin = uri.searchParams.get("pin");
  const req = (path, opts) => mobile(p, pin, path, opts);
  assert.equal((await req("/")).status, 401);
  assert.equal((await req("/mobile/v1/shell.js")).status, 401);
  const hello = await req("/mobile/v1/hello");
  assert.equal(hello.status, 200);
  assert.equal(hello.json().host.id, svc.ident.id);
  const peer = {
    ...hello.json().host,
    hosts: [`127.0.0.1:${p}`],
    fingerprint: pin,
  };
  assert.ok(await probePeer(peer));
  assert.ok(!(await probePeer({ ...peer, fingerprint: "x".repeat(43) })));
  assert.ok(!(await probePeer({ ...peer, id: "other" })));
  const cloud = {
    ...peer,
    id: "other",
    role: "cloud",
    name: "Other",
    displayName: "Cloud",
  };
  writeState(home.dir, "family-route.json", {
    familyId: "shared",
    role: "local",
    peer: cloud,
  });
  const html = await (await panelCall()).text();
  assert.ok(
    html.includes("<svg") && html.includes("Cloud") && html.includes("未连通"),
  );
  await panelCall("/api/refresh", {});
  const newUri = new URL(
    (await (await panelCall("/api/state")).json()).pairing.uri,
  );
  const pair = (code) =>
    req("/mobile/v1/pair", { method: "POST", body: { code, name: "<Phone>" } });
  assert.equal((await pair(uri.searchParams.get("code"))).status, 403);
  const paired = await pair(newUri.searchParams.get("code"));
  assert.equal(paired.status, 200);
  assert.equal(paired.json().family.peer.id, "other");
  assert.equal((await pair(newUri.searchParams.get("code"))).status, 403);
  const authorization = "Bearer " + paired.json().token;
  const session = await req("/mobile/v1/web-session", {
    method: "POST",
    headers: { authorization },
  });
  assert.equal(session.status, 200);
  const line = session.headers["set-cookie"][0];
  assert.ok(
    ["HttpOnly", "Secure", "SameSite=Strict"].every((v) => line.includes(v)),
  );
  const cookie = line.split(";")[0];
  const get = (path) => req(path, { headers: { cookie } });
  assert.equal(
    (
      await req("/mobile/v1/web-session", {
        method: "POST",
        headers: { cookie },
      })
    ).status,
    401,
  );
  const root = await req("/", {
    headers: { cookie, authorization, "x-forwarded-host": "example.com" },
  });
  assert.equal(root.status, 200);
  assert.ok(
    root.text.includes("Original app") &&
      root.text.includes("/mobile/v1/shell.css") &&
      root.text.includes("/mobile/v1/shell.js"),
  );
  assert.ok(!root.headers["set-cookie"]);
  assert.equal(observed.cookie, "host_sid=host-only-fixture");
  assert.equal(observed.authorization, undefined);
  assert.equal(observed["x-forwarded-host"], undefined);
  assert.equal(observed.origin, localOrigin);
  assert.ok(
    (await get("/mobile/v1/shell.js")).text.includes("__T3_MOBILE_BRIDGE__"),
  );
  assert.equal((await get("/api/orchestration/shell")).status, 200);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal(
      (await req("/api/projects/mutate", { method, headers: { cookie } }))
        .status,
      403,
    );
  assert.equal(
    (
      await req("/api/pull-requests/diff", {
        method: "POST",
        headers: { cookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req("/mobile/v1/unpair", {
        method: "POST",
        headers: { cookie, origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal((await get("/api/plugin-ext/t3-mobile-link/panel")).status, 403);
  assert.equal((await get("/api/%70lugins")).status, 400);
  assert.equal((await get("/mobile/v1/sync")).json().upstreamOk, true);
  assert.equal(scopes[0].readOnly, true);
  const ticket = await req("/api/auth/websocket-ticket/rpc", {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(ticket.status, 200);
  const query = "orchestrationProtocol=2&wsTicket=" + ticket.json().ticket;
  const ws = openWs(p, pin, { cookie }, query);
  await once(ws, "open", deadline());
  assert.equal(upgrade.headers.cookie, observed.cookie);
  assert.equal(upgrade.headers.origin, localOrigin);
  assert.equal(upgrade.headers.host, new URL(localOrigin).host);
  assert.equal(upgrade.url, "/ws?orchestrationProtocol=2");
  async function rpc(w, msg) {
    const response = once(w, "message", deadline());
    w.send(JSON.stringify(msg));
    return JSON.parse((await response)[0]);
  }
  const replay = openWs(p, pin, { cookie }, query);
  await assert.rejects(once(replay, "open", deadline()), /401/);
  const ping = { _tag: "Ping" };
  assert.deepEqual(await rpc(ws, ping), ping);
  const command = {
    _tag: "Request",
    id: 1,
    tag: "orchestration.dispatchCommand",
    payload: {},
    headers: [],
  };
  assert.equal((await rpc(ws, command)).exit._tag, "Failure");
  assert.equal(requests.length, 1);
  let closed = once(ws, "close", deadline());
  await panelCall("/api/config", { actions: true, terminal: false });
  await closed;
  assert.equal(
    (await req("/api/projects/mutate", { method: "POST", headers: { cookie } }))
      .status,
    200,
  );
  assert.equal(scopes.at(-1).readOnly, false);
  const ws2 = openWs(p, pin, { cookie });
  await once(ws2, "open", deadline());
  assert.deepEqual(await rpc(ws2, command), command);
  const terminal = { ...command, tag: "terminal.open" };
  assert.equal((await rpc(ws2, terminal)).exit._tag, "Failure");
  assert.equal(requests.length, 2);
  closed = once(ws2, "close", deadline());
  await panelCall("/api/config", { terminal: true });
  await closed;
  const ws3 = openWs(p, pin, { cookie });
  await once(ws3, "open", deadline());
  assert.deepEqual(await rpc(ws3, terminal), terminal);
  assert.equal((await get("/api/plugins")).status, 403);
  closed = once(ws3, "close", deadline());
  await panelCall("/api/revoke", { id: paired.json().deviceId });
  await closed;
  assert.equal((await get("/")).status, 401);
  assert.equal(
    (await req("/mobile/v1/sync", { headers: { authorization } })).status,
    401,
  );
  assert.equal(
    (await panelCall("/api/config", { enabled: false })).status,
    200,
  );
  await assert.rejects(() => get("/"));
  await panelCall("/api/config", { enabled: true });
  const fresh = (await (await panelCall("/api/state")).json()).pairing.uri;
  const next = await pair(new URL(fresh).searchParams.get("code"));
  const auth = "Bearer " + next.json().token;
  assert.equal(
    (
      await req("/mobile/v1/unpair", {
        method: "POST",
        headers: { authorization: auth },
      })
    ).status,
    200,
  );
  assert.equal(
    (await req("/mobile/v1/sync", { headers: { authorization: auth } })).status,
    401,
  );
  await panelCall("/api/config", { enabled: false });
  state = await (await panelCall("/api/state")).json();
  assert.equal(state.devices.length, 0);
  assert.equal(new LinkServer(ctx, { port: p }).cfg.enabled, false);
});
