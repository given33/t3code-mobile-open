import { randomBytes, randomUUID } from "node:crypto";
import { digest, readState, writeState, HttpError } from "./state.mjs";
import { familyGrants } from "./family.mjs";
const secret = () => randomBytes(32).toString("base64url");
export const COOKIE = "t3m_session",
  COOKIE_TTL = 3600_000;
export class Devices {
  constructor(dir) {
    this.dir = dir;
    this.data = readState(dir, "devices.json", { devices: [], revoked: [] });
    this.cookies = new Map();
    this.seen = new Map();
  }
  save() {
    writeState(this.dir, "devices.json", this.data);
  }
  add(name) {
    const token = secret(),
      now = Date.now();
    const d = {
      id: randomUUID(),
      name: String(name || "Mobile").slice(0, 96),
      tokenHash: digest(token),
      pairedAt: now,
      lastActive: now,
    };
    this.data.devices.push(d);
    this.save();
    return { deviceId: d.id, token };
  }
  all() {
    const ids = new Set(this.data.devices.map((d) => d.id));
    return [
      ...this.data.devices,
      ...familyGrants(this.dir).filter(
        (d) => !ids.has(d.id) && !this.data.revoked.includes(d.id),
      ),
    ];
  }
  list() {
    return this.all().map(({ id, name, pairedAt, lastActive }) => ({
      id,
      name,
      pairedAt: pairedAt ?? null,
      lastActive: this.seen.get(id) ?? lastActive ?? null,
    }));
  }
  revoke(id) {
    if (!this.all().some((d) => d.id === id))
      throw new HttpError(404, "Unknown device");
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    this.data.revoked.push(id);
    this.seen.delete(id);
    this.save();
    for (const [key, s] of this.cookies)
      if (s.id === id) this.cookies.delete(key);
  }
  cookie(d) {
    for (const [key, s] of this.cookies)
      if (s.id === d.id || s.expires <= Date.now()) this.cookies.delete(key);
    const value = secret();
    this.cookies.set(digest(value), {
      id: d.id,
      hash: d.tokenHash,
      expires: Date.now() + COOKIE_TTL,
    });
    return value;
  }
  auth(headers, bearerOnly = false) {
    const token = /^Bearer ([\w-]{43})$/i.exec(
      headers.authorization ?? "",
    )?.[1];
    const cookie = /(?:^|;\s*)t3m_session=([\w-]{43})(?:;|$)/.exec(
      headers.cookie ?? "",
    )?.[1];
    let d;
    if (token) d = this.all().find((x) => x.tokenHash === digest(token));
    else if (!bearerOnly && cookie) {
      const s = this.cookies.get(digest(cookie));
      if (s && s.expires > Date.now())
        d = this.all().find((x) => x.id === s.id && x.tokenHash === s.hash);
    }
    if (!d) throw new HttpError(401, "Mobile authentication required");
    this.seen.set(d.id, Date.now());
    if (this.data.devices.includes(d) && Date.now() - d.lastActive >= 60000) {
      d.lastActive = Date.now();
      this.save();
    }
    return d;
  }
}
