// Minimal DER for this single, fixed self-signed end-entity certificate profile.
// Node generates and signs the key; no shell, platform keychain or CLI dependency.
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { readState, writeState } from "./state.mjs";
function der(tag, ...parts) {
  const bytes = Buffer.concat(parts),
    n = bytes.length;
  const length = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Buffer.concat([Buffer.from([tag, ...length]), bytes]);
}
const seq = (...p) => der(0x30, ...p);
const hex = (s) => Buffer.from(s, "hex");
function time(date) {
  const s = date.toISOString().replace(/[-:T]/g, "").split(".")[0];
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(s.slice(2) + "Z"))
    : der(0x18, Buffer.from(s + "Z"));
}
const DAY = 86_400_000;
export function issueCertificate(privateKey, from, until) {
  const publicKey = createPublicKey(privateKey);
  const alg = seq(der(6, hex("2a8648ce3d040302"))); // ecdsa-with-SHA256
  const name = seq(
    der(
      0x31,
      seq(der(6, hex("550403")), der(0x0c, Buffer.from("Mobile Link"))),
    ),
  );
  const serial = randomBytes(16);
  serial[0] = serial[0] & 0x7f || 1;
  const tbs = seq(
    der(0xa0, der(2, hex("02"))),
    der(2, serial),
    alg,
    name,
    seq(
      time(new Date(from)),
      time(new Date(until)),
    ),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(
      0xa3,
      seq(seq(der(6, hex("551d13")), der(1, hex("ff")), der(4, seq()))),
    ),
  );
  const cert = seq(
    tbs,
    alg,
    der(3, hex("00"), sign("sha256", tbs, privateKey)),
  );
  return new X509Certificate(cert).toString();
}
export function identity(dir, now = Date.now()) {
  const from = now - 300_000; // five minutes of clock skew inside the 397-day lifetime
  const issue = key => issueCertificate(key, from, from + 397 * DAY);
  let data = readState(dir, "identity.json");
  if (!data) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    data = { id: randomUUID(), key: privateKey.export({ type: "pkcs8", format: "pem" }),
      cert: issue(privateKey) };
    writeState(dir, "identity.json", data);
  }
  const key = createPrivateKey(data.key);
  let x = new X509Certificate(data.cert);
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !x.verify(x.publicKey) || !x.checkPrivateKey(key))
    throw Error("Invalid Mobile Link identity");
  const until = Date.parse(x.validTo);
  if (until - now < 45 * DAY || until - Date.parse(x.validFrom) > 398 * DAY) {
    data = { ...data, cert: issue(key) };
    writeState(dir, "identity.json", data);
    x = new X509Certificate(data.cert);
  }
  const hash = createHash("sha256")
    .update(x.publicKey.export({ type: "spki", format: "der" }))
    .digest();
  return {
    ...data,
    fingerprint: hash.toString("base64url"),
    safetyCode: hash
      .toString("hex", 0, 8)
      .toUpperCase()
      .match(/.{4}/g)
      .join(" "),
  };
}
