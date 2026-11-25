import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { temp } from "./helpers.mjs";
const guard = fileURLToPath(
  new URL("../../scripts/check-privacy.mjs", import.meta.url),
);
test("guard rejects untracked, staged and force-tracked private inputs without echoing their values", (t) => {
  const h = temp();
  t.after(h.clean);
  const git = (...args) =>
    execFileSync("git", args, { cwd: h.dir, stdio: "pipe" });
  git("init", "-q");
  const put = (file, s) => writeFileSync(join(h.dir, file), s);
  const run = () =>
    spawnSync(process.execPath, [guard], { cwd: h.dir, encoding: "utf8" });
  put(".gitignore", "*.key\n");
  put("ignored.key", "ignored");
  put(
    "sample",
    "127.0.0.1 192.0.2.20 198.51.100.42 203.0.113.10 10.0.0.22 192.168.1.9 https://example.com",
  );
  assert.equal(run().status, 0);
  for (const [label, value] of [
    ["private material", ["-----BEGIN ", "EC PRIVATE", " KEY-----"].join("")],
    ["non-example IPv4", [8, 8, 4, 4].join(".")],
    [
      "personal path",
      "C:" +
        String.fromCharCode(92) +
        ["Users", "person"].join(String.fromCharCode(92)),
    ],
    ["personal path", ["", "Users", "someone", "Documents"].join("/")],
    ["private server alias", "her" + "mes-" + "hub"],
    ["unapproved DNS name", "personal-node." + "net"],
    ["credential", "sk" + "-" + "x".repeat(36)],
    ["credential", "github" + "_pat_" + "x".repeat(28)],
  ]) {
    put("sample", value);
    const r = run();
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(label));
    assert.ok(!r.stderr.includes(value));
  }
  git("add", "sample");
  put("sample", "harmless worktree");
  assert.equal(run().status, 1);
  assert.match(run().stderr, /index: sample/);
  git("add", "sample");
  assert.equal(run().status, 0);
  git("add", "-f", "ignored.key");
  assert.equal(run().status, 1);
});
