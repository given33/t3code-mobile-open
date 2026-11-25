import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { temp } from "./helpers.mjs";
import { writeState } from "../lib/state.mjs";
import { SourceSync } from "../lib/sync/source-sync.mjs";
import { Failover, UNKNOWN } from "../lib/sync/failover.mjs";
import { Relay } from "../lib/sync/handoff.mjs";
import { loopback, spoolTransport, drain } from "../lib/sync/transport.mjs";

function setup(t, allow = ["**"]) {
  const h = temp();
  t.after(h.clean);
  const root = path.join(h.dir, "work"),
    dir = path.join(h.dir, "state");
  fs.mkdirSync(root);
  writeState(dir, "source-grants.json", { demo: { root, allow } });
  return {
    root,
    dir,
    s: new SourceSync(dir),
    put(name, value) {
      const f = path.join(root, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, value);
    },
    get(name) {
      return fs.readFileSync(path.join(root, name), "utf8");
    },
  };
}
test("explicit grants, nested ignore, denylist, links and limits apply before reading content", (t) => {
  const a = setup(t, ["src/", "README"]);
  a.put(".gitignore", "src/ignored/\n*.cache\n!important.cache\n");
  a.put("src/.gitignore", "private-*\n");
  for (const p of [
    "README",
    "src/nested/code",
    "unlisted",
    "src/ignored/file",
    "src/test.cache",
    "src/important.cache",
    "src/private-data",
    "src/.git/config",
    "src/.ssh/config",
    "src/.env.prod",
    "src/node_modules/file",
    "src/build/file",
    "src/dist/file",
    "src/cert.P8",
    "src/k.pem",
    "src/k.key",
    "src/id_ed25519",
  ])
    a.put(p, "data");
  a.put("src/large", Buffer.alloc(2 * 1024 * 1024 + 1));
  fs.symlinkSync(
    a.root,
    path.join(a.root, "src", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.linkSync(path.join(a.root, "unlisted"), path.join(a.root, "src", "alias"));
  assert.throws(() => a.s.scan("not-granted"), /authorized/);
  assert.deepEqual(Object.keys(a.s.patch("demo").files).sort(), [
    "README",
    "src/important.cache",
    "src/nested/code",
  ]);
  const revision = a.s.scan("demo").rev;
  assert.equal(a.s.scan("demo").rev, revision);
  for (let i = 0; i < 4096; i++) a.put("src/f" + i, "");
  assert.throws(() => a.s.scan("demo"), /file limit/);
});
test("verified incremental add/modify/delete, corrupted delta and replay", (t) => {
  const a = setup(t),
    b = setup(t);
  a.put("one", "A");
  a.put("dir/two", "B");
  const first = a.s.patch("demo");
  assert.equal(b.s.apply(first).rev, first.rev);
  fs.unlinkSync(path.join(a.root, "dir/two"));
  a.put("one", "AA");
  a.put("three", "C");
  const delta = a.s.patch("demo", first);
  assert.deepEqual(Object.keys(delta.blobs).sort(), ["one", "three"]);
  assert.throws(
    () => b.s.apply({ ...delta, blobs: { ...delta.blobs, three: "YQ==" } }),
    /hash/,
  );
  assert.equal(b.get("one"), "A");
  assert.equal(b.s.apply(delta).status, "applied");
  assert.equal(b.get("one"), "AA");
  assert.equal(b.get("three"), "C");
  assert.ok(!fs.existsSync(path.join(b.root, "dir/two")));
  b.put("one", "new local edit");
  assert.equal(b.s.apply(delta).status, "applied");
  assert.equal(b.get("one"), "new local edit");
  assert.equal(b.s.ready("demo", delta.rev), false);
});
test("non-fast-forward preserves original and remote bytes, delete conflicts carry tombstones", (t) => {
  const a = setup(t),
    b = setup(t);
  a.put("main", "base");
  a.put("notes", "base");
  const base = a.s.patch("demo");
  b.s.apply(base);
  b.put("main", "local");
  b.put("notes", "local");
  a.put("main", "remote");
  fs.unlinkSync(path.join(a.root, "notes"));
  const delta = a.s.patch("demo", base);
  assert.equal(b.s.apply(delta).status, "conflict");
  assert.equal(b.get("main"), "local");
  assert.equal(b.get("notes"), "local");
  assert.equal(b.s.ready("demo", delta.rev), false);
  const at = path.join(b.s.store, "conflicts", "demo", delta.rev),
    list = JSON.parse(fs.readFileSync(path.join(at, "manifest.json")));
  assert.equal(
    fs.readFileSync(
      path.join(at, list.find((e) => e.path === "main").remoteBlob),
      "utf8",
    ),
    "remote",
  );
  assert.equal(list.find((e) => e.path === "notes").remoteBlob, null);
});
test("receiver rechecks narrower grant, links, ignored and oversized targets; never converts excluded files to deletes", (t) => {
  const a = setup(t),
    b = setup(t, ["src/**"]);
  a.put("private", "secret");
  assert.throws(() => b.s.apply(a.s.patch("demo")), /grant/);
  fs.unlinkSync(path.join(a.root, "private"));
  a.put("src/code", "x");
  const first = a.s.patch("demo");
  b.put(".gitignore", "src/");
  assert.throws(() => b.s.apply(first), /Protected/);
  b.put(".gitignore", "");
  const outside = path.join(b.dir, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(
    outside,
    path.join(b.root, "src"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => b.s.apply(first), /Protected/);
  assert.deepEqual(fs.readdirSync(outside), []);
  a.put("src/code", Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => a.s.patch("demo", first), /Protected/);
});
const pack = (k = "a") => ({
  handoffId: k,
  threadId: "t" + k,
  projectKey: null,
  title: "Checkpoint",
  sourceRole: "local",
  sourceRevision: null,
  summary: "Check receipt",
  stepBoundary: UNKNOWN,
  unknownSideEffects: true,
  continuationPrompt: "Inspect outcome; never retry blindly",
  createdAt: 1,
});
test("two-phase offer, durable fence BEFORE peerArmed, expired sources cannot revive; restart and unique claim", async (t) => {
  const h = temp();
  t.after(h.clean);
  let now = 0;
  const clock = () => now,
    a = new Failover(path.join(h.dir, "a"), "local", {}, clock),
    b = new Failover(path.join(h.dir, "b"), "cloud", {}, clock);
  assert.throws(
    () => new Failover(h.dir, "local", { takeoverDelayMs: 14000 }),
    /timings/,
  );
  a.register(pack());
  await a.arm("a", async (m) => {
    if (m.kind === "armed") assert.ok(a.read("active", "a").armed);
    const r = b.receive(m, () => true);
    if (m.kind === "offer") {
      assert.equal(a.read("active", "a").armed, false);
      assert.equal(b.claim("a", () => true).status, "waiting");
    }
    return r;
  });
  now = 3000;
  await a.renew(
    "a",
    loopback((m) => b.receive(m, () => true)),
  );
  assert.equal(b.read("standby", "a").seq, 1);
  assert.throws(
    () =>
      b.receive(
        {
          v: "failover-v1",
          kind: "renew",
          id: "a",
          epoch: a.read("active", "a").epoch,
          seq: 1,
        },
        () => true,
      ),
    /rejected/,
  );
  now = 6000;
  await assert.rejects(
    () =>
      a.renew("a", async (m) => {
        const ack = b.receive(m, () => true);
        now = 15000;
        return ack;
      }),
    /fenced/,
  );
  assert.equal(new Failover(a.dir, "local", {}, clock).canAdvance("a"), false);
  assert.throws(() => a.assertStep("a"), /fenced/);
  now = 25999;
  assert.equal(b.claim("a", () => true).status, "waiting");
  now = 26000;
  assert.equal(b.claim("a", () => false).status, "conflict");
  assert.equal(b.claim("a", () => true).status, "claimed");
  const old = b.read("claims", "a");
  now += 10000;
  assert.equal(b.claim("a", () => true).status, "claimed");
  assert.deepEqual(b.read("claims", "a"), old);
  assert.equal(old.pack.stepBoundary, UNKNOWN);
});
test("graceful shutdown first surrenders every registered session; receiver needs exact applied revision", async (t) => {
  const a = setup(t),
    b = setup(t);
  const left = new Relay({ stateDir: a.dir }, { enabled: true, role: "local" }),
    right = new Relay({ stateDir: b.dir }, { enabled: true, role: "cloud" });
  left.transport = loopback(right.receive);
  right.transport = loopback(left.receive);
  a.put("main", "state");
  left.track({
    handoffId: "a",
    threadId: "th",
    projectKey: "demo",
    targetRole: "cloud",
  });
  await left.tick();
  assert.equal(right.status().leaseState, "peerArmed");
  b.put("main", "dirty");
  await left.shutdown();
  assert.ok(left.lease.read("surrenders", "a"));
  assert.equal(left.mayWrite("th"), false);
  assert.equal(right.lease.read("claims", "a"), null);
  b.put("main", "state");
  const r = await left.release("a");
  assert.equal(r.status, "claimed");
  assert.equal(
    right.lease.read("claims", "a").pack.sourceRevision,
    a.s.scan("demo").rev,
  );
  assert.equal(right.lease.list("claims").length, 1);
});
test("unconfigured role never opens a spool or sends; directory adapter correlates replies", async (t) => {
  const h = temp();
  t.after(h.clean);
  for (const cfg of [{}, { role: "local" }, { enabled: true }]) {
    const x = new Relay({ stateDir: h.dir }, cfg, () => assert.fail("upload"));
    x.start();
    await x.shutdown();
    assert.equal(x.status().enabled, false);
  }
  assert.deepEqual(fs.readdirSync(h.dir), []);
  let msg;
  const run = spoolTransport(h.dir)({ v: 1 });
  const name = fs.readdirSync(path.join(h.dir, "outgoing"))[0];
  fs.mkdirSync(path.join(h.dir, "incoming"));
  fs.copyFileSync(
    path.join(h.dir, "outgoing", name),
    path.join(h.dir, "incoming", name),
  );
  await drain(h.dir, (x) => {
    msg = x;
    return "ok";
  });
  fs.renameSync(path.join(h.dir, "replies"), path.join(h.dir, "answers"));
  assert.equal(await run, "ok");
  assert.deepEqual(msg, { v: 1 });
});

test("an unanswered offer never authorizes a takeover; recovered claim results do not dispatch again", async (t) => {
  const home = temp();
  t.after(home.clean);
  const a = new Relay(
    { stateDir: path.join(home.dir, "local-state") },
    { enabled: true, role: "local" },
  );
  const b = new Relay(
    { stateDir: path.join(home.dir, "peer-state") },
    { enabled: true, role: "cloud" },
  );
  const id = "two-phase";
  a.track({ handoffId: id, threadId: "demo", targetRole: "cloud" });
  let now = 0;
  b.lease.clock = () => now;
  await assert.rejects(
    () =>
      a.lease.arm(id, async (m) => {
        b.receive({ from: "local", to: "cloud", message: m });
        throw Error("lost offer acknowledgement");
      }),
    /lost/,
  );
  now = 90000;
  assert.equal(b.lease.claim(id, b.ready).status, "waiting");
  assert.equal(a.lease.canAdvance(id), true);
  a.transport = loopback(b.receive);
  b.transport = loopback(a.receive);
  await a.tick();
  now += 20000;
  assert.equal(b.lease.claim(id, b.ready).status, "claimed");
  await b.tick();
  assert.equal(a.lease.canAdvance(id), false);
  const receipt = a.lease.read("receipts", id);
  assert.equal(receipt.targetRoute, "/relay-inbox/" + id);
  await b.tick();
  assert.deepEqual(a.lease.read("receipts", id), receipt);
  assert.equal(b.lease.list("claims").length, 1);
});

test("expired lease: isolated target stays in inbox until source confirms stop; retry and restart do not redispatch", async (t) => {
  const a = setup(t),
    b = setup(t);
  a.put("note", "one");
  writeState(b.dir, "source-grants.json", {
    demo: { root: b.root, allow: ["note"], nativeHandoff: true },
  });
  let running = true,
    stop = 0,
    attempts = 0,
    now = 0;
  const source = new Relay(
    {
      stateDir: a.dir,
      orchestration: {
        getThreadSnapshot: async () => ({
          workspacePath: a.root,
          title: "Native title",
          latestTurnSummary: "Observed summary",
          unknownSideEffects: true,
          isRunning: running,
        }),
        interruptActiveTurn: async (_, reason) => {
          assert.equal(reason, "lease expired");
          running = false;
          stop++;
          return { activeRunId: "run", interrupted: true };
        },
      },
    },
    { enabled: true, role: "local" },
    undefined,
    () => true,
  );
  const ctx = {
    stateDir: b.dir,
    orchestration: {
      continueThreadTurn: async (input) => {
        assert.equal(input.workspacePath, b.root);
        assert.ok(
          input.prompt.startsWith(
            "TOOL_OUTCOME_UNKNOWN: verify prior state before retrying any write/deploy command\n",
          ),
        );
        assert.ok(input.prompt.includes("Observed summary"));
        attempts++;
        return {
          ok: true,
          environmentId: "real-env",
          threadId: "next",
          route: "/real-env/next",
        };
      },
    },
  };
  const target = new Relay(
    ctx,
    { enabled: true, role: "cloud" },
    undefined,
    () => true,
  );
  source.transport = loopback(target.receive);
  target.transport = loopback(source.receive);
  source.lease.sourceClock = () => now;
  target.lease.clock = () => now;
  const id = "fence-handoff";
  source.track({
    handoffId: id,
    projectKey: "demo",
    threadId: "source",
    targetRole: "cloud",
  });
  await source.tick();
  now += target.lease.delay;
  assert.equal(target.lease.claim(id, target.ready).status, "claimed");
  await target.tick();
  assert.equal(target.claimResult(id).nativeContinued, false);
  assert.equal(attempts, 0);
  assert.equal(running, true);
  await source.fenceExpired();
  assert.equal(stop, 1);
  await source.tick();
  assert.equal(target.status().sourceInterrupted, true);
  assert.equal(target.claimResult(id).targetRoute, "/real-env/next");
  const restarted = new Relay(
    ctx,
    { enabled: true, role: "cloud" },
    undefined,
    () => true,
  );
  assert.equal((await restarted.complete(id)).targetRoute, "/real-env/next");
  assert.equal(attempts, 1);
});
test("no native write on read-only, transfer-only grant, opt-out or unconfirmed interruption", async (t) => {
  for (const mode of ["read-only", "transfer-only", "opt-out", "unconfirmed"]) {
    const a = setup(t),
      b = setup(t);
    a.put("note", "1");
    let allowed = mode !== "read-only";
    writeState(b.dir, "source-grants.json", {
      demo: {
        root: b.root,
        allow: ["note"],
        nativeHandoff: mode !== "transfer-only",
      },
    });
    const source = new Relay(
      {
        stateDir: a.dir,
        orchestration: {
          getThreadSnapshot: async () => ({
            workspacePath: a.root,
            title: "Title",
            latestTurnSummary: "",
            unknownSideEffects: true,
            isRunning: false,
          }),
          interruptActiveTurn: async () => ({
            activeRunId: mode === "unconfirmed" ? "still-running" : null,
            interrupted: false,
          }),
        },
      },
      { enabled: true, role: "local" },
      undefined,
      () => true,
    );
    let calls = 0;
    const target = new Relay(
      {
        stateDir: b.dir,
        orchestration: {
          continueThreadTurn: () => {
            calls++;
            throw Error("Forbidden");
          },
        },
      },
      { enabled: true, role: "cloud" },
      undefined,
      () => allowed,
    );
    source.transport = loopback(target.receive);
    const input = {
      threadId: "source",
      handoffId: "check",
      projectKey: "demo",
      targetRole: "cloud",
      autoContinue: mode !== "opt-out",
    };
    if (mode === "unconfirmed") {
      await assert.rejects(source.handoff(input), /stop not confirmed/);
      assert.equal(target.claimResult("check"), null);
    } else {
      const r = await source.handoff(input);
      assert.equal(r.targetRoute, "/relay-inbox/check");
      assert.equal(r.nativeContinued, false);
      allowed = true;
      await target.complete("check");
    }
    assert.equal(calls, 0);
  }
});
