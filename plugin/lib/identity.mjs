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
function generate() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const alg = seq(der(6, hex("2a8648ce3d040302"))); // ecdsa-with-SHA256
  const name = seq(
    der(
      0x31,
      seq(der(6, hex("550403")), der(0x0c, Buffer.from("Mobile Link"))),
    ),
  );
  const serial = randomBytes(16);
  serial[0] = serial[0] & 0x7f || 1;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(2, hex("02"))),
    der(2, serial),
    alg,
    name,
    seq(
      time(new Date(now - 86400000)),
      time(new Date(now + 5 * 365 * 86400000)),
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
  return {
    id: randomUUID(),
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: new X509Certificate(cert).toString(),
  };
}
export function identity(dir) {
  let data = readState(dir, "identity.json");
  if (!data) {
    data = generate();
    writeState(dir, "identity.json", data);
  }
  const x = new X509Certificate(data.cert);
  if (
    !x.verify(x.publicKey) ||
    !x.checkPrivateKey(createPrivateKey(data.key)) ||
    Date.parse(x.validTo) <= Date.now()
  )
    throw Error("Invalid or expired Mobile Link identity");
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
