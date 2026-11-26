// Real-host acceptance probe. Values returned by the host CLI or panel are
// deliberately never included in assertions, subprocess errors, or test output.
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { realpathSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  temp,
  port,
  mobile,
  openWs,
  deadline,
} from "../plugin/test/helpers.mjs";
const bin = realpathSync(process.argv[2]),
  tgz = fileURLToPath(
    new URL("../build/t3-mobile-link-0.4.1.tgz", import.meta.url),
  );
const home = temp(),
  t3Port = await port();
let linkPort = await port();
while (t3Port === linkPort) linkPort = await port();
const origin = `http://127.0.0.1:${t3Port}`,
  host = "127.0.0.1",
  ext = "/api/plugin-ext/t3-mobile-link/panel";
const env = {
  // This test needs the host, not any installed provider CLI or login.
  PATH: [
    dirname(process.execPath),
    ...(process.platform === "win32"
      ? [join(process.env.SystemRoot, "System32")]
      : ["/usr/bin", "/bin"]),
  ].join(delimiter),
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  TEMP: home.dir,
  TMP: home.dir,
  TMPDIR: home.dir,
  HOME: home.dir,
  USERPROFILE: home.dir,
  APPDATA: home.dir,
  LOCALAPPDATA: home.dir,
  T3CODE_HOME: home.dir,
  CI: "1",
  NO_COLOR: "1",
  DO_NOT_TRACK: "1",
};
const opts = { cwd: home.dir, env, windowsHide: true };
async function cli(args) {
  return await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [bin, ...args],
      { ...opts, timeout: 30000 },
      (e, out, err) => {
        if (!e) return resolve(out.trim());
        const missing = (out + err).includes(
          "Missing required flag: --no-enable",
        );
        reject(
          Object.assign(
            Error(`CLI ${args.slice(0, 2).join(" ")} exit ${e.code}`),
            { missing },
          ),
        );
      },
    ),
  );
}
let server, ended, ws, admin;
async function desktop(path, method = "GET", data) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(data ? { "content-type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  assert.ok(r.ok, `${method} ${path}: ${r.status}`);
  return r;
}
try {
  if (process.argv.includes("--mobile-ui")) {
    const { configureMobileUI } = await import("./mobile-ui-e2e.mjs");
    configureMobileUI(home.dir);
  }
  try {
    await cli(["plugin", "add", tgz]);
    console.log("temporary home: plugin add exited 0");
  } catch (e) {
    if (!e.missing) throw e;
    console.log(
      "host CLI: plain add exited 1 (Missing required flag: --no-enable)",
    );
    await cli(["plugin", "add", "--no-enable=false", "--link=false", tgz]);
    console.log(
      "temporary home: plugin add (explicit copy/enable flags) exited 0",
    );
  }
  server = spawn(
    process.execPath,
    [
      bin,
      "serve",
      "--mode",
      "web",
      "--host",
      host,
      "--port",
      String(t3Port),
      "--no-browser",
    ],
    { ...opts, stdio: "ignore" },
  );
  ended = once(server, "exit");
  let bound = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error(`Host exited ${server.exitCode}`);
    try {
      const r = await fetch(origin + "/.well-known/t3/environment", {
        signal: AbortSignal.timeout(800),
      });
      if (r.ok) {
        bound = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  assert.ok(bound, "Real host became ready");
  admin = await cli([
    "auth",
    "session",
    "issue",
    "--ttl",
    "5m",
    "--token-only",
  ]);
  async function active() {
    for (let i = 0; i < 80; i++) {
      const plugins = await (await desktop("/api/plugins")).json();
      if (
        plugins.some((p) => p.id === "t3-mobile-link" && p.status === "active")
      )
        return;
      await delay(100);
    }
    throw Error("Plugin not active");
  }
  await active();
  console.log("GET /api/plugins: t3-mobile-link active");
  await desktop("/api/plugins/t3-mobile-link/config", "PUT", {
    config: { port: linkPort, host },
  });
  await active();
  await desktop(ext + "/api/config", "POST", { enabled: true });
  const page = await (await desktop(ext)).text();
  assert.ok(
    page.includes("<svg") &&
      page.includes("Mobile Link") &&
      page.includes("跨端同步与接力") &&
      page.includes("t3mobile://pair?"),
  );
  console.log("desktop panel: 200 with embedded QR SVG & pairing link");
  const state = await (await desktop(ext + "/api/state")).json(),
    pair = new URL(state.pairing.uri),
    pin = pair.searchParams.get("pin");
  const request = (path, opts) => mobile(linkPort, pin, path, opts);
  await assert.rejects(
    () => mobile(linkPort, "_".repeat(43), "/mobile/v1/hello"),
    /pin/,
  );
  const hello = await request("/mobile/v1/hello");
  assert.equal(hello.status, 200);
  assert.equal(hello.json().backend, "t3code");
  assert.ok(hello.json().fingerprint === pin);
  const paired = await request("/mobile/v1/pair", {
    method: "POST",
    body: { name: "E2E", code: pair.searchParams.get("code") },
  });
  assert.equal(paired.status, 200);
  const authorization = "Bearer " + paired.json().token;
  const session = await request("/mobile/v1/web-session", {
    method: "POST",
    headers: { authorization },
  });
  assert.equal(session.status, 200);
  const cookie = session.headers["set-cookie"][0].split(";")[0];
  const root = await request("/", { headers: { cookie } });
  assert.equal(root.status, 200);
  assert.ok(
    root.text.includes("/mobile/v1/shell.js") &&
      root.text.includes("T3 Code") &&
      root.text.includes("/assets/"),
  );
  assert.ok(!root.headers["set-cookie"]);
  const asset = root.text.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await request(asset, { headers: { cookie } })).status, 200);
  assert.equal(
    (await request("/mobile/v1/shell.js", { headers: { cookie } })).status,
    200,
  );
  console.log(
    "pinned TLS: wrong pin rejected; hello → pair → web-session → native HTML, entry asset & injected shell: 200",
  );
  const sync = await request("/mobile/v1/sync", { headers: { cookie } });
  assert.equal(sync.status, 200);
  assert.ok(sync.json().upstreamOk && sync.json().environmentId);
  console.log("sync: upstreamOk=true, environmentId present");
  assert.equal(hello.json().appVersion, "0.4.1");
  const relay = await request("/mobile/v1/relay/status", {
    headers: { cookie },
  });
  assert.equal(relay.status, 200);
  assert.equal(relay.json().enabled, false);
  assert.equal(
    (
      await request("/mobile/v1/relay/handoff", {
        method: "POST",
        headers: { cookie },
        body: {},
      })
    ).status,
    403,
  );
  console.log(
    "relay: real panel, version 0.4.1, disabled by default, read-only handoff denied",
  );
  const auth = await request("/api/auth/session", { headers: { cookie } });
  assert.ok(auth.json().authenticated);
  assert.deepEqual(auth.json().scopes, ["orchestration:read"]);
  const shell = await request("/api/orchestration/shell", {
    headers: { cookie, "x-t3-orchestration-protocol": "2" },
  });
  assert.equal(shell.status, 200);
  console.log("native HTTP: authenticated read scope, orchestration shell 200");
  if (process.argv.includes("--mobile-ui")) {
    const { mobileUI } = await import("./mobile-ui-e2e.mjs");
    await desktop(ext + "/api/config", "POST", { actions: true });
    await mobileUI({ bin, origin, linkPort, pin, cookie, admin, workspace: home.dir,
      environmentId: sync.json().environmentId });
    await desktop(ext + "/api/config", "POST", { actions: false });
  }
  ws = openWs(linkPort, pin, { cookie });
  await once(ws, "open", deadline());
  const msg = once(ws, "message", deadline());
  ws.send('{"_tag":"Ping"}');
  assert.equal(JSON.parse((await msg)[0])._tag, "Pong");
  console.log("real /ws?orchestrationProtocol=2: 101; Effect RPC Ping → Pong");
  const chunk = once(ws, "message", deadline());
  ws.send(
    JSON.stringify({
      _tag: "Request",
      id: "1",
      tag: "orchestration.subscribeShell",
      payload: {},
      headers: [],
    }),
  );
  const frame = JSON.parse((await chunk)[0]);
  assert.equal(frame._tag, "Chunk");
  assert.ok(Array.isArray(frame.values) && frame.values.length > 0);
  ws.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
  console.log(
    "native orchestration.subscribeShell: received nonempty live RPC Chunk; ACK sent",
  );
  const closed = once(ws, "close", deadline());
  await desktop(ext + "/api/revoke", "POST", { id: paired.json().deviceId });
  await closed;
  assert.equal(
    (await request("/mobile/v1/sync", { headers: { cookie } })).status,
    401,
  );
  console.log("desktop revocation: live WSS closed, old cookie 401");
  await desktop(ext + "/api/config", "POST", { enabled: false });
} finally {
  ws?.terminate();
  if (server && server.exitCode === null && !server.signalCode) {
    if (process.platform === "win32") {
      // Terminate only the child host we spawned and its provider-discovery children.
      await new Promise((resolve, reject) =>
        execFile(
          join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/pid", String(server.pid), "/T", "/F"],
          { windowsHide: true },
          (e) =>
            e && server.exitCode === null
              ? reject(Error("Could not stop isolated host tree"))
              : resolve(),
        ),
      );
    } else server.kill("SIGTERM");
    await ended;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      home.clean();
      break;
    } catch (e) {
      if (attempt >= 8 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(e.code))
        throw e;
      await delay(250 * (attempt + 1));
    }
  }
  assert.ok(!existsSync(home.dir));
  console.log("temporary host stopped; temporary home removed");
}

const { nativeHandoffE2E } = await import("./native-handoff-e2e.mjs");
await nativeHandoffE2E(bin, tgz);
