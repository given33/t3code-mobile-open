import test from "node:test";
import assert from "node:assert/strict";
import { temp, port, mobile } from "./helpers.mjs";
import { LinkServer } from "../lib/link-server.mjs";
import { digest, writeState } from "../lib/state.mjs";

test("one local pairing discovers live pinned cloud listener; only an in-family grant opens peer WebView", async (t) => {
  async function start(role) {
    const h = temp();
    t.after(h.clean);
    const p = await port();
    const s = new LinkServer(
      {
        stateDir: h.dir,
        getServerInfo: () => ({ environmentId: role }),
        issueLocalSession: async () => null,
      },
      { role, host: "127.0.0.1", port: p },
    );
    await s.start();
    t.after(() => s.stop());
    return {
      h,
      p,
      s,
      peer: {
        ...s.host(),
        displayName: role,
        fingerprint: s.ident.fingerprint,
        hosts: [`127.0.0.1:${p}`],
      },
      req: (path, opts) => mobile(p, s.ident.fingerprint, path, opts),
    };
  }
  const local = await start("local"),
    cloud = await start("cloud");
  for (const [node, other] of [
    [local, cloud],
    [cloud, local],
  ])
    writeState(node.h.dir, "family-route.json", {
      familyId: "pair-family",
      role: node.peer.role,
      peer: other.peer,
    });
  const state = await local.s.panelState();
  assert.equal(state.peerOnline, true);
  const pair = await local.req("/mobile/v1/pair", {
    method: "POST",
    body: {
      code: new URL(state.pairing.uri).searchParams.get("code"),
      name: "Phone",
    },
  });
  assert.equal(pair.status, 200);
  const { deviceId, token, family } = pair.json();
  assert.deepEqual(family.peer, cloud.peer);
  const auth = {
    method: "POST",
    headers: { authorization: "Bearer " + token },
  };
  assert.equal((await cloud.req("/mobile/v1/web-session", auth)).status, 401);
  writeState(cloud.h.dir, "family-grants.json", {
    familyId: "pair-family",
    devices: [
      {
        id: deviceId,
        name: "Phone",
        tokenHash: digest(token),
        expiresAt: Date.now() + 60000,
      },
    ],
  });
  const session = await cloud.req("/mobile/v1/web-session", auth);
  assert.equal(session.status, 200);
  assert.equal(session.json().host.role, "cloud");
  assert.deepEqual(session.json().family.peer, local.peer);
  const cookie = session.headers["set-cookie"][0].split(";")[0];
  const sync = await cloud.req("/mobile/v1/sync", { headers: { cookie } });
  assert.equal(sync.status, 200);
  assert.equal(sync.json().upstreamOk, false);
  cloud.s.revoke(deviceId);
  assert.equal(
    (await cloud.req("/mobile/v1/sync", { headers: { cookie } })).status,
    401,
  );
  assert.equal((await local.req("/mobile/v1/web-session", auth)).status, 200);
});
