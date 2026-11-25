import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { HttpError, readState, writeState } from "../state.mjs";
import { validId } from "./source-sync.mjs";

const reject = (msg) => {
  throw new HttpError(409, msg);
};
// ACK only after the replaced file and its new directory entries are durable.
// Node does not expose directory handles for fsync on Windows.
function durableParents(dir, root) {
  if (process.platform === "win32") return;
  for (let p = dir; ; p = path.dirname(p)) {
    const fd = fs.openSync(p, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (p === root) break;
  }
}
export const UNKNOWN = "TOOL_OUTCOME_UNKNOWN";
export function checkpoint(x, role) {
  if (
    !x ||
    !validId(x.handoffId) ||
    !validId(x.threadId) ||
    (x.projectKey !== null && !validId(x.projectKey)) ||
    x.sourceRole !== role ||
    (x.sourceRevision !== null &&
      (typeof x.sourceRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(x.sourceRevision))) ||
    !Number.isSafeInteger(x.createdAt) ||
    x.createdAt <= 0 ||
    (x.autoContinue !== undefined && typeof x.autoContinue !== "boolean") ||
    typeof x.unknownSideEffects !== "boolean" ||
    !["BETWEEN_STEPS", UNKNOWN].includes(x.stepBoundary) ||
    (x.stepBoundary === UNKNOWN) !== x.unknownSideEffects ||
    ["summary", "continuationPrompt", "title"].some(
      (k) =>
        typeof x[k] !== "string" || x[k].length > (k === "title" ? 256 : 4096),
    )
  )
    reject("Invalid checkpoint");
  return Object.fromEntries(
    [
      ...(x.autoContinue === false ? ["autoContinue"] : []),
      "handoffId",
      "threadId",
      "projectKey",
      "title",
      "sourceRole",
      "sourceRevision",
      "summary",
      "stepBoundary",
      "unknownSideEffects",
      "continuationPrompt",
      "createdAt",
    ].map((k) => [k, x[k]]),
  );
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class Failover {
  constructor(dir, role, config = {}, clock = () => performance.now()) {
    this.dir = dir;
    this.role = role;
    this.peer = role === "local" ? "cloud" : "local";
    this.clock = clock;
    // A laptop may suspend while its peer continues measuring elapsed time.
    const boot = clock(),
      wall = Date.now();
    this.sourceClock = () => Math.max(clock(), boot + Date.now() - wall);
    this.fence = config.sourceFenceMs ?? 12000;
    this.delay = config.takeoverDelayMs ?? 20000;
    if (
      ![this.fence, this.delay].every(Number.isSafeInteger) ||
      this.fence < 1 ||
      this.delay <= this.fence + 2000 ||
      this.delay > 86400000
    )
      reject("Invalid failover timings");
    this.deadlines = new Map();
    this.seen = new Map(); // restart: source fails closed; receiver waits a full new delay
  }
  read(kind, id) {
    if (!validId(id)) reject("Invalid handoff ID");
    return readState(path.join(this.dir, kind), id + ".json");
  }
  save(kind, id, data) {
    if (!validId(id)) reject("Invalid handoff ID");
    writeState(path.join(this.dir, kind), id + ".json", data);
    durableParents(path.join(this.dir, kind), path.dirname(this.dir));
  }
  list(kind) {
    let names;
    try {
      names = fs.readdirSync(path.join(this.dir, kind));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return names
      .filter((s) => s.endsWith(".json"))
      .map((s) => this.read(kind, s.slice(0, -5)));
  }
  register(data) {
    const pack = checkpoint(data, this.role),
      id = pack.handoffId,
      prev = this.read("active", id);
    if (prev) {
      if (!same(pack, prev.pack)) reject("Handoff ID reused");
      return prev;
    }
    if (
      this.list("active").some(
        (s) => s.pack.threadId === pack.threadId && !s.returned,
      )
    )
      reject("Thread already registered");
    const s = { pack, epoch: randomUUID(), armed: false, seq: 0 };
    this.save("active", id, s);
    return s;
  }
  canAdvance(id) {
    const s = this.read("active", id);
    return (
      !!s &&
      !s.surrendered &&
      !s.returned &&
      (!s.armed || this.sourceClock() < (this.deadlines.get(id) ?? -Infinity))
    );
  }
  assertStep(id) {
    if (!this.canAdvance(id)) reject("Source fenced");
  }
  async arm(id, send) {
    let s = this.read("active", id);
    if (!s || s.armed || s.surrendered) reject("Cannot offer lease");
    const msg = {
      v: "failover-v1",
      epoch: s.epoch,
      pack: s.pack,
      fence: this.fence,
      delay: this.delay,
    };
    const ack = await send({ ...msg, kind: "offer" });
    if (ack?.epoch !== s.epoch || ack.status !== "offered")
      reject("Offer not acknowledged");
    s = this.read("active", id);
    if (s.armed || s.surrendered) reject("Offer changed");
    this.save("active", id, { ...s, armed: true });
    this.deadlines.set(id, this.sourceClock() + this.fence);
    const peer = await send({ ...msg, kind: "armed" });
    if (peer?.epoch !== s.epoch || peer.status !== "peerArmed")
      reject("Peer not armed");
    this.assertStep(id);
    return peer;
  }
  async renew(id, send) {
    this.assertStep(id);
    const s = this.read("active", id),
      start = this.sourceClock();
    if (!s.armed) reject("Not armed");
    const seq = s.seq + 1;
    this.save("active", id, { ...s, seq });
    const ack = await send({
      v: "failover-v1",
      kind: "renew",
      id,
      epoch: s.epoch,
      seq,
    });
    this.assertStep(id); // a delayed ACK must never un-fence a source
    if (
      ack?.status !== "renewed" ||
      ack.epoch !== s.epoch ||
      ack.seq !== seq ||
      this.read("active", id).seq !== seq
    )
      reject("Stale renewal");
    this.deadlines.set(id, start + this.fence);
  }
  surrender(id) {
    const s = this.read("active", id);
    if (!s) reject("Unknown handoff");
    this.save("active", id, { ...s, surrendered: true }); // irrevocable before creating any sendable record
    if (!s.surrendered) this.save("surrenders", id, s.pack);
    return {
      v: "failover-v1",
      kind: "surrender",
      epoch: s.epoch,
      pack: s.pack,
    };
  }
  receive(msg, ready) {
    if (msg?.v !== "failover-v1" || !validId(msg.epoch))
      reject("Invalid lease message");
    const pack = msg.pack && checkpoint(msg.pack, this.peer),
      id = pack?.handoffId ?? msg.id;
    const s = this.read("standby", id),
      now = this.clock();
    if (s && (s.epoch !== msg.epoch || (pack && !same(pack, s.pack))))
      reject("Lease identity mismatch");
    if (msg.kind === "offer" || msg.kind === "armed") {
      if (
        !pack ||
        msg.fence !== this.fence ||
        msg.delay !== this.delay ||
        s?.surrendered ||
        this.read("claims", id)
      )
        reject("Lease parameters mismatch");
      if (msg.kind === "offer") {
        if (!s)
          this.save("standby", id, {
            epoch: msg.epoch,
            pack,
            seq: 0,
            peerArmed: false,
          });
        return { epoch: msg.epoch, status: "offered" };
      }
      if (!s) reject("Missing lease offer");
      if (!s.peerArmed) {
        this.save("standby", id, { ...s, peerArmed: true });
        this.seen.set(id, now);
      }
      return { epoch: s.epoch, status: "peerArmed" };
    }
    if (msg.kind === "renew") {
      if (
        !s?.peerArmed ||
        s.surrendered ||
        this.read("claims", id) ||
        !Number.isSafeInteger(msg.seq) ||
        msg.seq <= s.seq
      )
        reject("Renewal rejected");
      if (now - this.lastSeen(id) >= this.delay) reject("Lease expired");
      this.save("standby", id, { ...s, seq: msg.seq });
      this.seen.set(id, now);
      return { epoch: s.epoch, status: "renewed", seq: msg.seq };
    }
    if (msg.kind === "surrender" && pack) {
      // The armed checkpoint is immutable. A final observation may enrich it but
      // cannot rebind the lease, workspace, revision, or task it was granted for.
      let final;
      if (msg.final !== undefined) {
        const f = msg.final;
        if (
          !f ||
          typeof f.sourceInterrupted !== "boolean" ||
          typeof f.sourceQuiescent !== "boolean" ||
          (f.sourceInterrupted && !f.sourceQuiescent) ||
          typeof f.title !== "string" ||
          f.title.length > 256 ||
          typeof f.summary !== "string" ||
          f.summary.length > 4096 ||
          typeof f.unknownSideEffects !== "boolean"
        )
          reject("Invalid final observation");
        final = {
          sourceInterrupted: f.sourceInterrupted,
          sourceQuiescent: f.sourceQuiescent,
          title: f.title,
          summary: f.summary,
          unknownSideEffects: f.unknownSideEffects,
        };
        if (s?.final && !same(s.final, final))
          reject("Conflicting final observation");
      }
      this.save("standby", id, {
        ...s,
        pack,
        epoch: msg.epoch,
        surrendered: true,
        ...(final ? { final } : {}),
      });
      return this.claim(id, ready);
    }
    reject("Unknown lease message");
  }
  lastSeen(id) {
    if (!this.seen.has(id)) this.seen.set(id, this.clock());
    return this.seen.get(id);
  }
  claim(id, ready) {
    const existing = this.read("claims", id);
    if (existing) return { status: "claimed", id, epoch: existing.epoch };
    const s = this.read("standby", id);
    if (
      !s ||
      (!s.surrendered &&
        (!s.peerArmed || this.clock() - this.lastSeen(id) < this.delay))
    )
      return { status: "waiting" };
    if (!ready(s.pack)) return { status: "conflict", id };
    // Publish the delivery exactly once before any native dispatch. Later result
    // updates retain this pack/epoch and use the native durable command receipt.
    const dir = path.join(this.dir, "claims");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, randomUUID() + ".tmp");
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          epoch: s.epoch,
          pack: s.pack,
          receivedAt: Date.now(),
        }),
        { flag: "wx", mode: 0o600, flush: true },
      );
      try {
        fs.linkSync(tmp, path.join(dir, id + ".json"));
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    durableParents(dir, path.dirname(this.dir));
    return { status: "claimed", id, epoch: s.epoch };
  }
}
