// Two stock built servers, trusted packaged mobile workers, real ACP/WS/TLS and durable spools.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { createRequire } from "node:module";
import { temp, port, mobile } from "../plugin/test/helpers.mjs";
const WS = createRequire(new URL("../plugin/package.json", import.meta.url))(
  "ws",
);
const exec = promisify(execFile),
  selection = { instanceId: "handoff-fixture", model: "hold" };
const panel = "/api/plugin-ext/t3-mobile-link/panel",
  proto = { "x-t3-orchestration-protocol": "2" };
async function until(label, inspect, ms = 18000) {
  const end = Date.now() + ms;
  do {
    const result = await inspect();
    if (result) return result;
    await wait(75);
  } while (Date.now() < end);
  throw Error("Timed out: " + label);
}
const json = (file, data) => writeFileSync(file, JSON.stringify(data));
async function startHost(bin, tgz, role, cleanup) {
  const h = temp();
  cleanup.push(h.clean);
  const dir = h.dir,
    workspace = mkdtempSync(join(dir, "project-")),
    state = join(dir, "userdata"),
    marker = join(dir, "acp-events");
  const local = await port(),
    link = await port(),
    origin = `http://127.0.0.1:${local}`;
  const env = {
    PATH: [
      dirname(process.execPath),
      ...(process.platform === "win32"
        ? [join(process.env.SystemRoot, "System32")]
        : ["/usr/bin", "/bin"]),
    ].join(delimiter),
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: dir,
    TMP: dir,
    TMPDIR: dir,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: dir,
    LOCALAPPDATA: dir,
    T3CODE_HOME: dir,
    CI: "1",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  };
  const opts = { env, cwd: dir, windowsHide: true };
  const cli = async (args) => {
    try {
      return (
        await exec(process.execPath, [bin, ...args], {
          ...opts,
          timeout: 30000,
        })
      ).stdout.trim();
    } catch {
      throw Error("Isolated CLI failed: " + args.slice(0, 2).join(" "));
    }
  };
  mkdirSync(state, { recursive: true });
  json(join(state, "settings.json"), {
    defaultModelSelection: selection,
    providerInstances: {
      [selection.instanceId]: {
        driver: "acpRegistry",
        displayName: "Handoff fixture",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [
            fileURLToPath(
              new URL("./handoff-acp-fixture.mjs", import.meta.url),
            ),
            marker,
          ],
        },
      },
    },
  });
  await cli(["plugin", "add", "--no-enable=false", "--link=false", tgz]);
  const plugin = join(state, "plugins", "state", "t3-mobile-link");
  mkdirSync(plugin, { recursive: true });
  json(join(plugin, "source-grants.json"), {
    sample: { root: workspace, allow: ["note.txt"], nativeHandoff: true },
  });
  const server = spawn(
      process.execPath,
      [
        bin,
        "serve",
        "--mode",
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        String(local),
        "--no-browser",
      ],
      { ...opts, stdio: "ignore" },
    ),
    ended = once(server, "exit");
  cleanup.push(async () => {
    if (server.exitCode === null && !server.signalCode) {
      if (process.platform === "win32")
        await exec(
          join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/pid", String(server.pid), "/T", "/F"],
          { windowsHide: true },
        );
      else server.kill("SIGTERM");
    }
    await ended;
  });
  await until("isolated host ready", async () => {
    try {
      return (await fetch(origin + "/.well-known/t3/environment")).ok;
    } catch {
      return false;
    }
  });
  const headers = {
    authorization:
      "Bearer " +
      (await cli(["auth", "session", "issue", "--ttl", "5m", "--token-only"])),
  };
  const admin = async (path, method = "GET", data) => {
    const r = await fetch(origin + path, {
      method,
      headers: { ...headers, ...proto, "content-type": "application/json" },
      body: data && JSON.stringify(data),
    });
    assert.ok(r.ok, `${method} ${path}: ${r.status}`);
    return r;
  };
  await admin("/api/plugins/t3-mobile-link/config", "PUT", {
    config: {
      enabled: true,
      actions: true,
      role,
      host: "127.0.0.1",
      port: link,
      taskSync: {
        enabled: true,
        role,
        sourceFenceMs: 2500,
        takeoverDelayMs: 5500,
      },
    },
  });
  const uri = new URL(
      (await (await admin(panel + "/api/state")).json()).pairing.uri,
    ),
    pin = uri.searchParams.get("pin");
  const request = (path, options) => mobile(link, pin, path, options);
  const pair = await request("/mobile/v1/pair", {
    method: "POST",
    body: { code: uri.searchParams.get("code"), name: "Acceptance" },
  });
  assert.equal(pair.status, 200);
  const device = { authorization: "Bearer " + pair.json().token };
  const api = async (path, body) => {
    const r = await request(path, {
      headers: device,
      ...(body ? { method: "POST", body } : {}),
    });
    assert.equal(r.status, 200, `${role} ${path}: ${r.status}`);
    return r.json();
  };
  const ws = new WS(`ws://127.0.0.1:${local}/ws?orchestrationProtocol=2`, {
    headers,
  });
  await once(ws, "open", { signal: AbortSignal.timeout(8000) });
  cleanup.push(() => ws.terminate());
  let seq = 0;
  const rpc = async (tag, payload) => {
    const id = String(++seq);
    ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    for (;;) {
      const [buf] = await once(ws, "message", {
        signal: AbortSignal.timeout(10000),
      });
      const frame = JSON.parse(buf);
      if (frame._tag === "Exit" && frame.requestId === id) {
        if (frame.exit._tag !== "Success")
          throw Error(
            `Native RPC ${tag} refused (${frame.exit.cause?.[0]?.error?._tag ?? "failure"})`,
          );
        return frame.exit.value;
      }
    }
  };
  await rpc("projects.mutate", {
    type: "project.create",
    commandId: "setup-project",
    projectId: "fixture-project",
    title: "E2E",
    workspaceRoot: workspace,
    defaultModelSelection: selection,
  });
  return {
    api,
    rpc,
    admin,
    workspace,
    marker,
    spool: join(plugin, "task-sync", "wire"),
  };
}
// Simulate the restricted transfer helper, not the receiver: each process reads and answers its own mailbox.
function shuttle(a, b) {
  const sent = new Set();
  return () => {
    const outgoing = join(a, "outgoing");
    if (!existsSync(outgoing)) return;
    for (const name of readdirSync(outgoing).filter((n) =>
      /^[a-f0-9-]{36}\.json$/.test(n),
    )) {
      const move = (src, dir) => {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name);
        copyFileSync(src, file + ".tmp");
        renameSync(file + ".tmp", file);
      };
      if (!sent.has(name)) {
        move(join(outgoing, name), join(b, "incoming"));
        sent.add(name);
      }
      const reply = join(b, "replies", name);
      if (existsSync(reply) && !existsSync(join(a, "answers", name)))
        move(reply, join(a, "answers"));
    }
  };
}
export async function nativeHandoffE2E(bin, tgz) {
  const cleanup = [];
  try {
    const a = await startHost(bin, tgz, "local", cleanup),
      b = await startHost(bin, tgz, "cloud", cleanup);
    const ab = shuttle(a.spool, b.spool),
      ba = shuttle(b.spool, a.spool);
    let connected = true;
    const timer = setInterval(() => {
      if (!connected) return;
      ab();
      ba();
    }, 35);
    cleanup.push(() => clearInterval(timer));
    writeFileSync(join(a.workspace, "note.txt"), "authorized checkpoint\n");
    const startTurn = async (threadId) => {
      await a.rpc("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: "setup-" + threadId,
        threadId: threadId,
        projectId: "fixture-project",
        title: "Fixture",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      await a.rpc("orchestration.dispatchCommand", {
        type: "message.dispatch",
        commandId: "start-" + threadId,
        threadId: threadId,
        messageId: "msg-" + threadId,
        text: "Hold this turn",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    };
    await startTurn("fixture-source");
    const markers = (host) =>
      existsSync(host.marker)
        ? readFileSync(host.marker, "utf8").trim().split(/\s+/)
        : [];
    await until("source provider received real ACP prompt", () =>
      markers(a).includes("prompt"),
    );
    const input = {
      targetRole: "cloud",
      handoffId: "fixture-switch",
      threadId: "fixture-source",
      projectKey: "sample",
    };
    await a.api("/mobile/v1/relay/checkpoint", input);
    const r = await a.api("/mobile/v1/relay/handoff", input);
    assert.equal(r.sourceInterrupted, true);
    assert.equal(r.nativeContinued, true);
    assert.equal(r.targetRoute, `/${r.environmentId}/${r.targetThreadId}`);
    assert.ok(markers(a).includes("cancel"));
    await until("target provider received guarded prompt", () =>
      markers(b).includes("guarded-prompt"),
    );
    assert.equal(
      readFileSync(join(b.workspace, "note.txt"), "utf8"),
      "authorized checkpoint\n",
    );
    assert.deepEqual(await a.api("/mobile/v1/relay/handoff", input), r);
    assert.equal(
      (await b.api("/mobile/v1/relay/claims/fixture-switch")).targetRoute,
      r.targetRoute,
    );
    const snapshot = await (
      await b.admin("/api/orchestration/threads/" + r.targetThreadId)
    ).json();
    const projection =
      snapshot.projection ??
      snapshot.snapshot?.projection ??
      snapshot.thread?.projection;
    assert.ok(projection, "Expected a native thread projection");
    assert.equal(projection.runs.length, 1);
    assert.deepEqual(markers(b), ["guarded-prompt"]);
    console.log(
      "native handoff: two isolated built hosts; ACP prompt → confirmed source cancel → synced revision → single guarded target provider turn; stable native route on retry",
    );
    for (const kind of ["partition", "shutdown"]) {
      const next = {
        ...input,
        handoffId: `handoff-${kind}`,
        threadId: `source-${kind}`,
      };
      const prompts = markers(b).length,
        cancels = markers(a).filter((x) => x === "cancel").length;
      await startTurn(next.threadId);
      await until(
        "additional source ACP prompt",
        () => markers(a).filter((x) => x === "prompt").length > cancels,
      );
      await a.api("/mobile/v1/relay/checkpoint", next);
      await until("target armed", async () => {
        const s = await b.api("/mobile/v1/relay/status");
        return (
          s.activeHandoff === next.handoffId && s.leaseState === "peerArmed"
        );
      });
      if (kind === "partition") {
        connected = false;
        await until(
          "isolated source provider cancel",
          () => markers(a).filter((x) => x === "cancel").length > cancels,
        );
        await until("lease-expiry inbox", async () => {
          const s = await b.api("/mobile/v1/relay/status");
          return s.targetRoute === `/relay-inbox/${next.handoffId}`;
        });
        assert.equal(markers(b).length, prompts);
        connected = true;
      } else {
        await a.admin("/api/plugins/t3-mobile-link/disable", "POST");
      }
      await until(
        "additional native target prompt",
        () => markers(b).length > prompts,
        25000,
      );
      const receipt = await b.api("/mobile/v1/relay/claims/" + next.handoffId);
      assert.equal(receipt.nativeContinued, true);
      assert.equal(receipt.sourceInterrupted, true);
      assert.equal(
        receipt.targetRoute,
        `/${receipt.environmentId}/${receipt.targetThreadId}`,
      );
      assert.equal(
        markers(a).filter((x) => x === "cancel").length,
        cancels + 1,
      );
      assert.equal(
        markers(b).filter((x) => x === "guarded-prompt").length,
        prompts + 1,
      );
      console.log(
        `native ${kind}: provider cancel confirmed; unique guarded native continuation`,
      );
    }
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }
}
