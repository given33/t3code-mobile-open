import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../plugin/", import.meta.url));
const build = fileURLToPath(new URL("../build/", import.meta.url));
const tempRoot = realpathSync(tmpdir()),
  stage = mkdtempSync(join(tempRoot, "mobile-link-pack-"));
try {
  function copy(from, files, to) {
    for (const name of files) {
      mkdirSync(dirname(join(to, name)), { recursive: true });
      cpSync(join(from, name), join(to, name), { recursive: true });
    }
  }
  copy(source, ["package.json", "host.mjs", "lib"], stage);
  cpSync(new URL("../LICENSE", import.meta.url), join(stage, "LICENSE"));
  // Do not ship dependency experiments, test fixtures, or their lockfiles. Keep
  // all public package entry points and the original copyright/license notices.
  for (const [name, files] of Object.entries({
    ws: [
      "package.json",
      "LICENSE",
      "index.js",
      "browser.js",
      "wrapper.mjs",
      "lib",
    ],
    "qrcode-generator": ["package.json", "dist", "README.md"],
  })) {
    copy(
      join(source, "node_modules", name),
      files,
      join(stage, "node_modules", name),
    );
  }
  mkdirSync(build, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      process.env.npm_execpath,
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      build,
    ],
    { cwd: stage, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const real = realpathSync(stage);
  if (
    dirname(real) !== tempRoot ||
    !basename(real).startsWith("mobile-link-pack-")
  )
    throw Error("Unsafe pack cleanup path");
  rmSync(real, { recursive: true, force: true });
}
