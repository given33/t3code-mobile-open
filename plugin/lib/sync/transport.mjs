import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { writeState, readState } from "../state.mjs";

export const MAX_WIRE = 48 * 1024 * 1024;
const uuid = /^[a-f0-9-]{36}\.json$/;
export const loopback = (receive) => async (envelope) =>
  structuredClone(await receive(structuredClone(envelope)));
// No shell, user-supplied remote command, opportunistic host key, or auth prompts.
export function sshTransport(configFile) {
  if (!path.isAbsolute(configFile))
    throw Error("Expected administrator SSH config path");
  return (msg) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(msg);
      if (Buffer.byteLength(data) > MAX_WIRE)
        return reject(Error("Transfer too large"));
      const p = spawn(
        "ssh",
        [
          "-T",
          "-F",
          configFile,
          "-o",
          "BatchMode=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "UpdateHostKeys=no",
          "-o",
          "ClearAllForwardings=yes",
          "-o",
          "ForwardAgent=no",
          "-o",
          "ConnectTimeout=4",
          "sync-peer",
          "t3-sync-v1",
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
      const chunks = [];
      let bytes = 0;
      const t = setTimeout(() => p.kill(), 8000);
      p.stdout.on("data", (c) => {
        if ((bytes += c.length) > 65536) p.kill();
        else chunks.push(c);
      });
      p.stdin.on("error", () => {});
      p.on("error", reject);
      p.on("close", (code) => {
        clearTimeout(t);
        try {
          if (code !== 0 || bytes > 65536) throw Error();
          const r = JSON.parse(Buffer.concat(chunks));
          if (r.ok !== true) throw Error();
          resolve(r.value);
        } catch {
          reject(Error("Peer unavailable or refused transfer"));
        }
      });
      p.stdin.end(data);
    });
}
// Spool transport also works behind NAT: the audited helper can carry requests
// in reverse. Replies are correlated to one request, never inferred from SSH exit.
export function spoolTransport(dir) {
  return async (msg) => {
    const id = randomUUID() + ".json";
    if (Buffer.byteLength(JSON.stringify(msg)) > MAX_WIRE)
      throw Error("Transfer too large");
    writeState(path.join(dir, "outgoing"), id, msg);
    try {
      const until = performance.now() + 8000;
      while (performance.now() < until) {
        const r = readState(path.join(dir, "answers"), id);
        if (r) {
          if (!r.ok) throw Error("Peer refused transfer");
          return r.value;
        }
        await sleep(100);
      }
      throw Error("Peer unavailable");
    } finally {
      for (const k of ["outgoing", "answers"])
        fs.rmSync(path.join(dir, k, id), { force: true });
    }
  };
}
export async function drain(dir, receive) {
  const inbox = path.join(dir, "incoming");
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  for (const id of fs
    .readdirSync(inbox)
    .filter((x) => uuid.test(x))
    .slice(0, 8)) {
    const f = path.join(inbox, id);
    let reply;
    try {
      const s = fs.lstatSync(f);
      if (!s.isFile() || s.nlink !== 1 || s.size > MAX_WIRE) throw Error();
      reply = { ok: true, value: await receive(readState(inbox, id)) };
    } catch {
      reply = { ok: false };
    }
    writeState(path.join(dir, "replies"), id, reply);
    fs.rmSync(f, { force: true });
  }
}
