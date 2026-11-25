import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temp } from "./helpers.mjs";
import { identity } from "../lib/identity.mjs";
import { PairCode } from "../lib/pair-link.mjs";
import { Devices } from "../lib/devices.mjs";
import { familyRoute } from "../lib/family.mjs";
import { digest, writeState } from "../lib/state.mjs";
import { Proxy } from "../lib/t3-proxy.mjs";

test("identity: stable P-256 self-signature, private key match, independent SPKI & safety code", (t) => {
  const h = temp();
  t.after(h.clean);
  const i = identity(h.dir),
    cert = new X509Certificate(i.cert);
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.ok(cert.verify(cert.publicKey));
  assert.ok(cert.checkPrivateKey(createPrivateKey(i.key)));
  assert.ok(!cert.ca);
  assert.ok(
    Date.parse(cert.validFrom) <= Date.now() &&
      Date.parse(cert.validTo) > Date.now(),
  );
  const hash = createHash("sha256")
    .update(cert.publicKey.export({ type: "spki", format: "der" }))
    .digest();
  assert.equal(i.fingerprint, hash.toString("base64url"));
  assert.equal(
    i.safetyCode,
    hash.toString("hex").slice(0, 16).toUpperCase().match(/.{4}/g).join(" "),
  );
  assert.equal(identity(h.dir).id, i.id);
  assert.equal(identity(h.dir).fingerprint, i.fingerprint);
  writeFileSync(join(h.dir, "identity.json"), "{");
  assert.throws(() => identity(h.dir));
});
test("pair URI, SVG, one-time use, rotation, fixed expiry and bounded attempts", () => {
  let now = 1000;
  const p = new PairCode(() => now),
    host = { id: "a", name: "本机 & 1", role: "cloud" };
  p.refresh();
  const first = p.code;
  const link = p.link(host, "pin", ["example.com:3081"]);
  assert.ok(link.svg.includes("<svg") && link.svg.includes("<path"));
  const u = new URL(link.uri);
  assert.equal(u.protocol, "t3mobile:");
  assert.equal(u.searchParams.get("name"), host.name);
  assert.equal(u.searchParams.get("code"), first);
  p.refresh();
  assert.throws(() => p.consume(first, "one"), { status: 403 });
  p.consume(p.code, "one");
  assert.equal(p.link(host, "pin", []), null);
  assert.throws(() => p.consume(first, "one"), { status: 403 });
  p.refresh();
  now += 300000;
  assert.throws(() => p.consume(p.code, "two"), { status: 403 });
  p.refresh();
  for (let i = 0; i < 8; i++)
    assert.throws(() => p.consume("bad", "three"), { status: 403 });
  assert.throws(() => p.consume(p.code, "three"), { status: 429 });
  now += 60000;
  p.consume(p.code, "three");
});
test("Family metadata uses opposite role and pinned hosts only; grants scoped, live, expiring and locally revocable", (t) => {
  const a = temp(),
    b = temp();
  t.after(a.clean);
  t.after(b.clean);
  const local = new Devices(a.dir),
    phone = local.add("<Phone>");
  const hdr = { authorization: "Bearer " + phone.token };
  const remote = new Devices(b.dir);
  assert.equal(familyRoute(b.dir), null);
  assert.throws(() => remote.auth(hdr), { status: 401 });
  const peer = {
    id: "local-id",
    name: "Desk",
    displayName: "本机",
    role: "local",
    hosts: ["example.com:3081"],
    fingerprint: digest("pin"),
  };
  writeState(b.dir, "family-route.json", {
    familyId: "example",
    role: "cloud",
    peer: { ...peer, secret: "not exposed" },
  });
  assert.deepEqual(familyRoute(b.dir).peer, peer);
  const device = {
    id: phone.deviceId,
    name: "Phone",
    tokenHash: digest(phone.token),
    expiresAt: Date.now() + 60000,
  };
  function grant(familyId, d) {
    writeState(b.dir, "family-grants.json", { familyId, devices: [d] });
  }
  grant("other", device);
  assert.throws(() => remote.auth(hdr), { status: 401 });
  grant("example", { ...device, expiresAt: 0 });
  assert.throws(() => remote.auth(hdr), { status: 401 });
  grant("example", device);
  const cookie = { cookie: "t3m_session=" + remote.cookie(remote.auth(hdr)) };
  assert.equal(remote.auth(cookie).id, phone.deviceId);
  grant("other", device);
  assert.throws(() => remote.auth(cookie), { status: 401 });
  grant("example", device);
  remote.revoke(phone.deviceId);
  assert.throws(() => new Devices(b.dir).auth(hdr), { status: 401 });
  assert.ok(
    !readFileSync(join(a.dir, "devices.json"), "utf8").includes(phone.token),
  );
  assert.equal(local.auth(hdr).id, phone.deviceId);
  local.revoke(phone.deviceId);
  assert.throws(() => local.auth(hdr), { status: 401 });
  writeState(b.dir, "family-route.json", {
    familyId: "example",
    role: "local",
    peer,
  });
  assert.throws(() => familyRoute(b.dir));
});
test("local session coalescing, proactive refresh, policy generation change and fail-closed issuance", async () => {
  let count = 0,
    near = false,
    allow = true;
  const proxy = new Proxy({
    async issueLocalSession() {
      count++;
      return allow
        ? {
            cookieName: "t3",
            cookieValue: "test-only",
            expiresAt: new Date(
              Date.now() + (near ? 1000 : 90000),
            ).toISOString(),
          }
        : null;
    },
  });
  await Promise.all([proxy.session(false), proxy.session(false)]);
  assert.equal(count, 1);
  await proxy.session(false);
  assert.equal(count, 1);
  proxy.invalidate();
  near = true;
  await proxy.session(true);
  await proxy.session(true);
  assert.equal(count, 3);
  proxy.invalidate();
  allow = false;
  await assert.rejects(proxy.session(true), { status: 503 });
});
