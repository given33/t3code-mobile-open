import { networkInterfaces } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import qrcode from "qrcode-generator";
import { HttpError } from "./state.mjs";
export function endpoint(s) {
  if (typeof s !== "string" || !s || s.length > 255 || /[\s,@\\?#]/.test(s))
    throw Error("Invalid mobile endpoint");
  const url = new URL(s.includes("://") ? s : `https://${s}`);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.username ||
    url.password
  )
    throw Error("Expected TLS host[:port]");
  return url.host;
}
export function hosts(cfg, port) {
  let ips = [cfg.host];
  if (cfg.host === "0.0.0.0" || cfg.host === "::") {
    ips = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && !n["internal"] && n.family === "IPv4")
      .map((n) => n.address);
    if (!ips.length) ips = ["127.0.0.1"];
  }
  return [
    ...new Set(
      [
        ...cfg.extraHosts,
        ...cfg.tunnels,
        ...ips.map((n) => `${n.includes(":") ? `[${n}]` : n}:${port}`),
      ].map(endpoint),
    ),
  ].slice(0, 8);
}
export class Limit {
  constructor(max, period, now = Date.now) {
    Object.assign(this, { max, period, now, entries: new Map() });
  }
  take(key) {
    const now = this.now();
    let slot = this.entries.get(key);
    if (!slot || slot.until <= now) {
      if (this.entries.size >= 2048)
        for (const [k, v] of this.entries)
          if (v.until <= now) this.entries.delete(k);
      if (!slot && this.entries.size >= 2048)
        throw new HttpError(429, "Rate limited");
      this.entries.set(key, (slot = { until: now + this.period, count: 0 }));
    }
    if (++slot.count > this.max) throw new HttpError(429, "Rate limited");
  }
}
export class PairCode {
  constructor(now = Date.now) {
    this.now = now;
    this.limit = new Limit(8, 60000, now);
  }
  refresh() {
    this.code = randomBytes(18).toString("base64url");
    this.expiresAt = this.now() + 300000;
  }
  consume(code, address) {
    this.limit.take(address);
    if (
      !this.code ||
      this.now() >= this.expiresAt ||
      typeof code !== "string" ||
      Buffer.byteLength(code) !== this.code.length ||
      !timingSafeEqual(Buffer.from(code), Buffer.from(this.code))
    )
      throw new HttpError(403, "Invalid or expired pairing code");
    this.code = null;
  }
  link(host, pin, addresses) {
    if (!this.code || this.now() >= this.expiresAt) return null;
    const q = new URLSearchParams({
      v: "1",
      id: host.id,
      name: host.name,
      role: host.role,
      pin,
      code: this.code,
      hosts: addresses.join(","),
    });
    const uri = `t3mobile://pair?${q}`;
    const qr = qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return {
      uri,
      expiresAt: this.expiresAt,
      svg: qr.createSvgTag({ scalable: true, cellSize: 4, margin: 16 }),
    };
  }
}
