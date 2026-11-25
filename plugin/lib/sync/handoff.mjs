import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeState, HttpError } from "../state.mjs";
import { SourceSync, validId } from "./source-sync.mjs";
import { Failover, UNKNOWN } from "./failover.mjs";
import { drain, sshTransport, spoolTransport } from "./transport.mjs";

const conflict = (text) => {
  throw new HttpError(409, text);
};
const guard =
  "TOOL_OUTCOME_UNKNOWN: verify prior state before retrying any write/deploy command";
function resultFor(id, r = {}) {
  const native = r.nativeContinued === true;
  if (
    native &&
    (!validId(r.targetThreadId) ||
      !validId(r.environmentId) ||
      r.targetRoute !== `/${r.environmentId}/${r.targetThreadId}`)
  )
    conflict("Invalid native route");
  return {
    status: "claimed",
    targetThreadId: native ? r.targetThreadId : null,
    environmentId: native ? r.environmentId : null,
    targetRoute: native ? r.targetRoute : "/relay-inbox/" + id,
    sourceInterrupted: r.sourceInterrupted === true,
    nativeContinued: native,
  };
}
export class Relay {
  constructor(ctx, config = {}, transport, writable = () => false) {
    this.enabled =
      config?.enabled === true && ["local", "cloud"].includes(config?.role);
    if (!this.enabled) return;
    this.native = ctx.orchestration;
    this.writable = writable;
    this.autoContinue = config.autoContinue !== false;
    this.stopping = new Map();
    this.continuing = new Map();
    this.role = config.role;
    this.peer = this.role === "local" ? "cloud" : "local";
    this.dir = path.join(ctx.stateDir, "task-sync");
    this.source = new SourceSync(ctx.stateDir);
    this.lease = new Failover(this.dir, this.role, config);
    this.spool = path.join(this.dir, "wire");
    this.transport =
      transport ||
      (config.sshConfig
        ? sshTransport(config.sshConfig)
        : spoolTransport(this.spool));
    this.queue = Promise.resolve();
    this.nextSync = 0;
  }
  serial(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
  send = (msg) =>
    this.transport({ from: this.role, to: this.peer, message: msg });
  ready = (pack) =>
    pack.projectKey
      ? this.source.ready(pack.projectKey, pack.sourceRevision)
      : pack.sourceRevision === null &&
        !Object.keys(this.source.grants()).length;
  receive = (packet) => {
    if (!this.enabled || packet?.from !== this.peer || packet?.to !== this.role)
      conflict("Wrong relay role");
    const m = packet.message;
    if (m?.kind === "claim-result") {
      const s = this.lease.read("active", m.id);
      if (!s || s.epoch !== m.epoch || (!s.armed && !s.surrendered))
        conflict("Unexpected claim result");
      const result = resultFor(m.id, m.result);
      this.lease.save("active", m.id, { ...s, returned: true });
      if (!this.lease.read("receipts", m.id)?.nativeContinued)
        this.lease.save("receipts", m.id, result);
      return { status: "recorded", epoch: s.epoch };
    }
    if (m?.kind === "patch") return this.source.apply(m.patch);
    const ack = this.lease.receive(m, this.ready);
    if (ack.status !== "claimed") return ack;
    return this.complete(ack.id).then((result) => ({ ...ack, ...result }));
  };
  async sync(k, confirm = false) {
    const base = this.source.state(k),
      p = this.source.patch(k, base);
    if (base.status === "conflict")
      conflict("Source conflict needs reconciliation");
    if (!confirm && base.status !== "new" && base.rev === p.rev) return p.rev;
    const r = await this.send({ kind: "patch", patch: p });
    if (
      this.source.state(k).rev !== base.rev ||
      this.source.state(k).status === "conflict"
    )
      conflict("Source base changed during transfer");
    if (r.status === "conflict") {
      this.lease.save("peer-conflicts", k, { rev: p.rev });
      conflict("Peer reported a source conflict");
    }
    if (r.status !== "applied" || r.rev !== p.rev)
      conflict("Peer has not applied source revision");
    if (this.lease.read("peer-conflicts", k))
      this.lease.save("peer-conflicts", k, null);
    writeState(this.source.store, k + ".json", {
      status: "sent",
      files: p.files,
      rev: p.rev,
      at: Date.now(),
    });
    return p.rev;
  }
  status() {
    const result = {
      enabled: this.enabled,
      role: this.role ?? null,
      peerRole: this.peer ?? null,
      leaseState: "disabled",
      syncedWorkspaces: [],
      activeHandoff: null,
      targetThreadId: null,
      targetRoute: null,
      sourceInterrupted: false,
      nativeContinued: false,
      conflicts: 0,
      lastSyncAt: null,
    };
    if (!this.enabled) return result;
    const active = this.lease.list("active"),
      standby = this.lease.list("standby");
    const ws = Object.keys(this.source.grants())
      .filter(validId)
      .map((k) => {
        const s = this.source.state(k);
        return {
          projectKey: k,
          rev: s.status === "new" ? null : s.rev,
          status: s.status,
          at: s.at ?? null,
          conflicts:
            (s.conflicts ?? 0) + (this.lease.read("peer-conflicts", k) ? 1 : 0),
        };
      });
    const last = [...active, ...standby].sort(
      (a, b) => b.pack.createdAt - a.pack.createdAt,
    )[0];
    const fenced = active.some(
      (s) =>
        s.armed && !s.surrendered && !this.lease.canAdvance(s.pack.handoffId),
    );
    const id = last?.pack.handoffId;
    const delivery =
      id && (this.lease.read("receipts", id) ?? this.claimResult(id));
    return {
      ...result,
      ...delivery,
      sourceInterrupted:
        delivery?.sourceInterrupted === true ||
        (id && this.lease.read("final", id)?.sourceInterrupted) === true,
      syncedWorkspaces: ws,
      activeHandoff: last?.pack.handoffId ?? null,
      conflicts:
        ws.reduce((n, w) => n + w.conflicts, 0) +
        standby.filter((s) => s.blocked).length,
      leaseState: fenced
        ? "fenced"
        : last?.surrendered
          ? "surrendered"
          : last?.peerArmed
            ? "peerArmed"
            : last?.armed
              ? "armed"
              : last
                ? "registered"
                : "idle",
      lastSyncAt: Math.max(0, ...ws.map((w) => w.at ?? 0)) || null,
    };
  }
  mayWrite(threadId) {
    if (!this.enabled) return true;
    return !this.lease
      .list("active")
      .some(
        (s) =>
          (!validId(threadId) || s.pack.threadId === threadId) &&
          !this.lease.canAdvance(s.pack.handoffId),
      );
  }
  track(b) {
    const s = this.register(b);
    return { ok: true, handoffId: s.pack.handoffId };
  }
  register(b) {
    if (!this.enabled || this.closing)
      conflict("Task relay disabled or closing");
    const grants = this.source.grants(),
      mapped = Object.keys(grants).filter(
        (k) =>
          Array.isArray(grants[k].threadIds) &&
          grants[k].threadIds.includes(b.threadId),
      );
    const k = b.projectKey ?? (mapped.length === 1 ? mapped[0] : null);
    const previous = this.lease
      .list("active")
      .find((s) => s.pack.threadId === b.threadId);
    const id = b.handoffId ?? previous?.pack.handoffId ?? randomUUID();
    if (
      !validId(id) ||
      !validId(b.threadId) ||
      (b.autoContinue !== undefined && typeof b.autoContinue !== "boolean") ||
      b.targetRole !== this.peer ||
      (k !== null && !validId(k)) ||
      ["summary", "title"].some(
        (f) =>
          b[f] !== undefined &&
          (typeof b[f] !== "string" ||
            b[f].length > (f === "title" ? 256 : 4096)),
      )
    )
      throw new HttpError(400, "Invalid handoff");
    if (Object.keys(grants).length && !this.source.granted(k))
      conflict("Explicit workspace identity required");
    const existing = this.lease.read("active", id);
    if (existing) {
      if (
        (b.autoContinue !== undefined &&
          (this.autoContinue && b.autoContinue) !==
            (existing.pack.autoContinue !== false)) ||
        existing.pack.threadId !== b.threadId ||
        existing.pack.projectKey !== k ||
        existing.pack.title !== (b.title ?? "") ||
        existing.pack.summary !== (b.summary ?? "")
      )
        conflict("Handoff ID reused");
      return existing;
    }
    return this.lease.register({
      handoffId: id,
      threadId: b.threadId,
      ...(!this.autoContinue || b.autoContinue === false
        ? { autoContinue: false }
        : {}),
      projectKey: k,
      title: b.title ?? "",
      sourceRole: this.role,
      sourceRevision:
        k && this.source.granted(k) ? this.source.scan(k).rev : null,
      summary: b.summary ?? "",
      stepBoundary: UNKNOWN,
      unknownSideEffects: true,
      continuationPrompt:
        "Inspect the checkpoint and verify unacknowledged side effects before continuing. Do not replay commands.",
      createdAt: Date.now(),
    });
  }
  // Explicit, host-local registration of a checkpoint can precede a device switch.
  // Idempotent phone handoff surrenders immediately; no optimistic target route.
  claimResult(id) {
    const c = this.lease.read("claims", id);
    if (!c) return null;
    return resultFor(id, {
      ...c.result,
      sourceInterrupted:
        c.result?.sourceInterrupted ||
        this.lease.read("standby", id)?.final?.sourceInterrupted,
    });
  }
  complete(id) {
    if (this.continuing.has(id)) return this.continuing.get(id);
    const op = this.continueClaim(id).finally(() => this.continuing.delete(id));
    this.continuing.set(id, op);
    return op;
  }
  async continueClaim(id) {
    const claim = this.lease.read("claims", id),
      previous = this.claimResult(id);
    if (!claim || !previous) conflict("Missing claim");
    if (claim.result) return previous;
    const p = claim.pack,
      final = this.lease.read("standby", id)?.final;
    // A transfer key and file allowlist are not authority to run an agent.
    // In particular a peer timer alone proves nothing about a stalled source worker.
    if (
      !this.autoContinue ||
      p.autoContinue === false ||
      !this.writable() ||
      !this.native?.continueThreadTurn ||
      !p.sourceRevision ||
      !this.source.granted(p.projectKey) ||
      this.source.grants()[p.projectKey].nativeHandoff !== true
    ) {
      // A read-only claim is not latent authority that can wake after a configuration change.
      this.lease.save("claims", id, { ...claim, result: previous });
      return previous;
    }
    if (!final?.sourceQuiescent) return previous;
    if (!this.ready(p)) conflict("Claimed revision no longer matches");
    const title = final.title || p.title,
      summary = final.summary || p.summary;
    const unknownSideEffects = final.unknownSideEffects;
    const prompt = [
      unknownSideEffects ? guard : "Verify the checkpoint before continuing.",
      p.continuationPrompt,
      JSON.stringify({
        title,
        summary,
        from: p.sourceRole,
        sourceRevision: p.sourceRevision,
      }),
    ].join("\n");
    const native = await this.native.continueThreadTurn({
      handoffId: id,
      threadId: p.threadId,
      workspacePath: this.source.workspace(p.projectKey).root,
      sourceRole: p.sourceRole,
      sourceRevision: p.sourceRevision,
      title,
      prompt,
      unknownSideEffects,
    });
    if (native.ok !== true) conflict("Native handoff was not accepted");
    const result = resultFor(id, {
      sourceInterrupted: final.sourceInterrupted,
      nativeContinued: true,
      environmentId: native.environmentId,
      targetRoute: native.route,
      targetThreadId: native.threadId,
    });
    // Crash after dispatch but before this write reuses the native command receipt.
    this.lease.save("claims", id, { ...claim, result });
    return result;
  }
  stopSource(id, reason) {
    if (this.stopping.has(id)) return this.stopping.get(id);
    const op = this.observeStop(id, reason).finally(() =>
      this.stopping.delete(id),
    );
    this.stopping.set(id, op);
    return op;
  }
  async observeStop(id, reason) {
    const saved = this.lease.read("final", id);
    if (saved) return saved;
    const { pack } = this.lease.surrender(id);
    if (!this.native?.interruptActiveTurn || !this.writable()) return undefined;
    const snapshot = await this.native.getThreadSnapshot(pack.threadId);
    if (!snapshot) return undefined;
    if (
      pack.projectKey &&
      (!this.source.granted(pack.projectKey) ||
        path.relative(
          this.source.workspace(pack.projectKey).root,
          snapshot.workspacePath,
        ) !== "")
    )
      conflict("Source thread is outside granted workspace");
    if (!this.writable()) return undefined;
    const stopped = await this.native.interruptActiveTurn(
      pack.threadId,
      reason,
    );
    if (stopped.activeRunId && !stopped.interrupted)
      conflict("Provider stop not confirmed");
    const after = await this.native.getThreadSnapshot(pack.threadId);
    if (!after || after.isRunning) conflict("Source thread is still running");
    const final = {
      sourceInterrupted: stopped.interrupted,
      sourceQuiescent: true,
      title: pack.projectKey ? snapshot.title.slice(0, 256) : pack.title,
      summary: (pack.projectKey
        ? snapshot.latestTurnSummary || pack.summary
        : pack.summary
      ).slice(0, 4096),
      unknownSideEffects:
        pack.unknownSideEffects ||
        snapshot.unknownSideEffects ||
        after.unknownSideEffects ||
        stopped.interrupted,
    };
    this.lease.save("final", id, final);
    this.lease.save("surrenders", id, {
      ...pack,
      ...final,
      stepBoundary: final.unknownSideEffects ? UNKNOWN : "BETWEEN_STEPS",
    });
    return final;
  }
  async release(id) {
    const m = this.lease.surrender(id),
      p = m.pack;
    const final = await this.stopSource(id, "handoff");
    if (final) m.final = final;
    if (p.sourceRevision) {
      try {
        if ((await this.sync(p.projectKey, true)) !== p.sourceRevision)
          return { status: "conflict" };
      } catch (e) {
        if (
          this.lease.read("peer-conflicts", p.projectKey) ||
          this.source.state(p.projectKey).status === "conflict"
        )
          return { status: "conflict" };
        throw e;
      }
    }
    const r = await this.send(m);
    if (r.status === "conflict") return { status: "conflict" };
    if (r.status !== "claimed" || r.id !== id || r.epoch !== m.epoch)
      conflict("Peer has not claimed handoff");
    const result = resultFor(id, {
      ...r,
      sourceInterrupted: final?.sourceInterrupted,
    });
    this.lease.save("receipts", id, result);
    this.lease.save("delivered", id, { epoch: m.epoch });
    return result;
  }
  handoff(b) {
    return this.serial(async () => {
      const s = this.register(b),
        id = s.pack.handoffId;
      const r = this.lease.read("receipts", id) ?? (await this.release(id));
      return {
        ok: r.status === "claimed",
        handoffId: id,
        targetRole: this.peer,
        sourceRevision: s.pack.sourceRevision,
        targetRoute: null,
        targetThreadId: null,
        nativeContinued: false,
        sourceInterrupted:
          this.lease.read("final", id)?.sourceInterrupted === true,
        ...r,
      };
    });
  }
  fenceExpired() {
    // An unreachable peer can leave a renew in flight. Do not queue the local stop behind it.
    return Promise.all(
      this.lease
        .list("active")
        .filter(
          (s) =>
            s.armed &&
            !s.surrendered &&
            !this.lease.canAdvance(s.pack.handoffId),
        )
        .map((s) => this.stopSource(s.pack.handoffId, "lease expired")),
    );
  }
  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.incoming ??= drain(this.spool, this.receive)
          .catch(() => {
            this.lastError = "Receive failed";
          })
          .finally(() => {
            this.incoming = null;
          });
        void this.fenceExpired().catch(() => {
          this.lastError = "Source stop not confirmed";
        });
        for (const s of this.lease.list("standby")) {
          if (this.lease.read("claims", s.pack.handoffId)) continue;
          const r = this.lease.claim(s.pack.handoffId, this.ready);
          if ((r.status === "conflict") !== !!s.blocked)
            this.lease.save("standby", s.pack.handoffId, {
              ...s,
              blocked: r.status === "conflict",
            });
        }
      } catch {
        this.lastError = "Receive failed";
      }
      if (!this.busy && !this.closing) {
        this.busy = this.serial(() => this.tick())
          .catch(() => {
            this.lastError = "Transfer deferred";
          })
          .finally(() => {
            this.busy = null;
          });
      }
    }, 500);
    this.timer.unref();
  }
  async tick() {
    for (const { pack, epoch } of this.lease.list("claims")) {
      const id = pack.handoffId;
      const result = await this.complete(id);
      if (
        this.lease.read("reported", id)?.nativeContinued ===
        result.nativeContinued
      )
        continue;
      try {
        const r = await this.send({ kind: "claim-result", id, epoch, result });
        if (r?.status === "recorded" && r.epoch === epoch)
          this.lease.save("reported", id, {
            epoch,
            nativeContinued: result.nativeContinued,
          });
      } catch {
        this.lastError = "Claim result pending";
      }
    }
    for (const s of this.lease.list("active")) {
      const id = s.pack.handoffId;
      if (
        this.lease.read("receipts", id) &&
        (!s.surrendered || this.lease.read("delivered", id))
      )
        continue;
      if (s.surrendered) {
        await this.release(id);
        continue;
      }
      if (s.armed && this.lease.canAdvance(id))
        await this.lease.renew(id, this.send);
      if (!s.armed) {
        if (
          s.pack.sourceRevision &&
          (await this.sync(s.pack.projectKey, true)) !== s.pack.sourceRevision
        )
          continue;
        await this.lease.arm(id, this.send);
      }
    }
    if (Date.now() >= this.nextSync) {
      this.nextSync = Date.now() + 15000;
      for (const k of Object.keys(this.source.grants())) await this.sync(k);
    }
  }
  async shutdown() {
    if (!this.enabled) return;
    this.closing = true;
    clearInterval(this.timer);
    const pending = this.lease
      .list("active")
      .filter((s) => !this.lease.read("delivered", s.pack.handoffId));
    for (const s of pending) this.lease.surrender(s.pack.handoffId);
    await Promise.all(
      pending.map((s) =>
        this.stopSource(s.pack.handoffId, "graceful shutdown"),
      ),
    );
    await this.queue;
    await this.incoming;
    await Promise.allSettled(
      pending.map((s) => this.release(s.pack.handoffId)),
    );
  }
}
