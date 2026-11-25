import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readState, writeState, HttpError } from "../state.mjs";

const FILE = 2 * 1024 * 1024,
  COUNT = 4096,
  BATCH = 32 * 1024 * 1024;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw new HttpError(409, message);
};
const own = (obj, key) => Object.hasOwn(obj, key);
export const validId = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(v) &&
  !/^(con|aux|prn|nul|com\d|lpt\d|constructor|prototype)$/i.test(v);
const safePart = (s) =>
  s.length > 0 &&
  s.length <= 200 &&
  !s.startsWith(".") &&
  !/[. ]$/.test(s) &&
  !/[\\/:<>|"?*\x00-\x1f\x7f~]/.test(s) &&
  !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(s) &&
  !/^(?:node_modules|dist|build|credentials?|secrets?|id_(?:rsa|dsa|ed25519|ecdsa)(?:\..*)?|auth\.json|identity\.json|devices\.json|source-grants\.json|family-grants\.json)$/i.test(
    s,
  ) &&
  !/\.(?:pem|key|p8|p12|pfx|kdbx)$/i.test(s);
const safe = (rel) =>
  typeof rel === "string" &&
  rel.length <= 1024 &&
  rel.split("/").every(safePart);
const pairs = (files) =>
  Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const revision = (files) => sha(JSON.stringify(pairs(files)));
const empty = () => ({ files: {}, rev: revision({}) });
const stat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
function plainRoot(p) {
  if (
    typeof p !== "string" ||
    path.parse(p).root === p ||
    !path.isAbsolute(p) ||
    path.resolve(p) !== fs.realpathSync.native(p) ||
    !stat(p)?.isDirectory()
  )
    fail("Grant requires a canonical directory");
  return path.resolve(p);
}
function readFile(p, max = FILE) {
  const st = stat(p);
  if (!st?.isFile() || st.nlink !== 1 || st.size > max)
    fail("Protected or oversized file");
  const fd = fs.openSync(
    p,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const s = fs.fstatSync(fd);
    const { dev: openedDevice } = s,
      { dev: observedDevice } = st;
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      openedDevice !== observedDevice ||
      s.ino !== st.ino ||
      s.size !== st.size
    )
      fail("File changed during sync");
    const b = Buffer.alloc(s.size);
    let i = 0;
    while (i < b.length) {
      const n = fs.readSync(fd, b, i, b.length - i, i);
      if (!n) fail("File changed during sync");
      i += n;
    }
    const end = fs.fstatSync(fd);
    if (end.size !== s.size || end.ctimeMs !== s.ctimeMs)
      fail("File changed during sync");
    return b;
  } finally {
    fs.closeSync(fd);
  }
}
// Supported gitignore subset: rooted/relative globs, directory rules, ! and **.
// Refuse unsupported escapes rather than accidentally disclose an ignored file.
function rules(dir) {
  const file = path.join(dir, ".gitignore");
  if (!stat(file)) return [];
  return readFile(file, 128 * 1024)
    .toString("utf8")
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s && !s.startsWith("#"))
    .map((s) => {
      if (s.includes("\\") || /[{}()]/.test(s)) fail("Unsupported ignore rule");
      const neg = s[0] === "!";
      if (neg) s = s.slice(1);
      const directory = s.endsWith("/");
      if (directory) s = s.slice(0, -1);
      const rooted = s.includes("/");
      if (s.startsWith("/")) s = s.slice(1);
      return { dir, pattern: s, neg, directory, rooted };
    });
}
const match = (s, glob) => path.posix.matchesGlob(s, glob);
function ignored(file, isDir, rs) {
  let skip = false;
  for (const r of rs)
    if (
      (!r.directory || isDir) &&
      match(
        r.rooted
          ? path.relative(r.dir, file).split(path.sep).join("/")
          : path.basename(file),
        r.pattern,
      )
    )
      skip = !r.neg;
  return skip;
}
function manifest(files) {
  if (
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    Object.keys(files).length > COUNT
  )
    fail("Invalid manifest");
  const names = new Set();
  for (const [k, v] of Object.entries(files)) {
    const lower = k.normalize("NFC").toLowerCase();
    if (!safe(k) || !hash(v) || names.has(lower))
      fail("Invalid or ambiguous manifest path");
    names.add(lower);
  }
  for (const k of names) {
    let parent = k;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (names.has(parent)) fail("File/directory collision");
    }
  }
  return { rev: revision(files), files };
}
export class SourceSync {
  constructor(stateDir) {
    this.dir = stateDir;
    this.store = path.join(stateDir, "task-sync", "source");
  }
  grants() {
    return readState(this.dir, "source-grants.json", {});
  }
  granted(k) {
    return validId(k) && own(this.grants(), k);
  }
  workspace(k) {
    if (!this.granted(k)) throw new HttpError(403, "Workspace not authorized");
    const { root, allow } = this.grants()[k];
    if (!Array.isArray(allow) || !allow.length || allow.length > 128)
      fail("Missing explicit allow patterns");
    const patterns = allow.map((p) => {
      if (typeof p === "string" && p.endsWith("/")) p += "**";
      if (
        typeof p !== "string" ||
        p.length > 1024 ||
        !p.split("/").every((s) => safePart(s.replace(/[?*]/g, "x"))) ||
        /[\[\]{}()!]/.test(p)
      )
        fail("Invalid allow pattern");
      return p.split("/");
    });
    const canonical = plainRoot(root),
      state = fs.realpathSync.native(this.dir);
    if (
      [canonical, state].some((p, i) => {
        const other = [state, canonical][i];
        return p === other || other.startsWith(p + path.sep);
      })
    )
      fail("State and workspace must not overlap");
    return { root: canonical, patterns };
  }
  scan(k, want) {
    const { root, patterns } = this.workspace(k),
      files = Object.create(null),
      blobs = Object.create(null);
    let total = 0,
      count = 0;
    function walk(dir, prefix, tails, inherited) {
      if (fs.realpathSync.native(dir) !== dir)
        fail("Workspace directory changed");
      const rs = [...inherited, ...rules(dir)];
      const dynamic = tails.some(([x]) => x.includes("*") || x.includes("?"));
      const names = dynamic
        ? fs.readdirSync(dir)
        : [...new Set(tails.map((t) => t[0]))];
      for (const name of names) {
        if (!safePart(name)) continue;
        const rel = prefix + name;
        if (!safe(rel)) continue;
        const next = tails.flatMap((t) => advance(t, name));
        if (!next.length) continue;
        const file = path.join(dir, name),
          st = stat(file);
        if (!st || st.isSymbolicLink() || ignored(file, st.isDirectory(), rs))
          continue;
        if (st.isDirectory() && next.some((t) => t.length))
          walk(
            file,
            rel + "/",
            next.filter((t) => t.length),
            rs,
          );
        if (
          !st.isFile() ||
          st.nlink !== 1 ||
          st.size > FILE ||
          !next.some((t) => !t.length)
        )
          continue;
        if (++count > COUNT) fail("Workspace exceeds file limit");
        const data = readFile(file);
        files[rel] = sha(data);
        if (want && want[rel] !== files[rel]) {
          if ((total += data.length) > BATCH)
            fail("Patch exceeds transfer limit");
          blobs[rel] = data.toString("base64");
        }
      }
    }
    walk(root, "", patterns, []);
    return { ...manifest(files), blobs };
  }
  // Inspect the exact path (including every ancestor) independently of scanning:
  // a filtered file is not a deletion and cannot be an incoming write target.
  target(k, rel) {
    const { root, patterns } = this.workspace(k);
    if (!safe(rel) || !patterns.some((p) => match(rel, p.join("/"))))
      fail("Path outside grant");
    let dir = root,
      rs = [];
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (stat(dir)) rs = rs.concat(rules(dir));
      dir = path.join(dir, parts[i]);
      const s = stat(dir),
        parent = i < parts.length - 1;
      if (
        ignored(dir, parent, rs) ||
        (s &&
          (s.isSymbolicLink() ||
            (parent
              ? !s.isDirectory()
              : !s.isFile() || s.nlink !== 1 || s.size > FILE)))
      )
        fail("Protected sync target");
    }
    return dir;
  }
  patch(k, base = empty()) {
    if (manifest(base.files).rev !== base.rev) fail("Invalid source base");
    const { files, rev, blobs } = this.scan(k, base.files);
    for (const p of Object.keys(base.files))
      if (!own(files, p)) this.target(k, p);
    return { v: 1, projectKey: k, base: base.rev, rev, files, blobs };
  }
  state(k) {
    if (!validId(k)) fail("Invalid workspace");
    return readState(this.store, k + ".json", { ...empty(), status: "new" });
  }
  ready(k, rev) {
    if (!this.granted(k)) return !rev;
    const s = this.state(k);
    return s.status === "applied" && s.rev === rev && this.scan(k).rev === rev;
  }
  apply(p) {
    const k = p.projectKey,
      before = this.state(k),
      local = this.scan(k),
      target = manifest(p.files);
    if (
      p.v !== 1 ||
      !hash(p.base) ||
      target.rev !== p.rev ||
      !p.blobs ||
      typeof p.blobs !== "object" ||
      Array.isArray(p.blobs)
    )
      fail("Invalid patch");
    if (
      before.status === "applied" &&
      before.rev === p.rev &&
      before.rev !== p.base
    )
      return { status: "applied", rev: p.rev }; // lost ACK, never rewrite
    if (before.rev !== p.base) fail("Stale source base");
    const plan = [],
      conflicts = [],
      expected = new Set();
    let bytes = 0;
    for (const rel of new Set([
      ...Object.keys(before.files),
      ...Object.keys(p.files),
    ])) {
      const old = own(before.files, rel) ? before.files[rel] : undefined,
        remote = own(p.files, rel) ? p.files[rel] : undefined;
      const file = this.target(k, rel),
        cur = local.files[rel];
      if (old === remote) continue;
      let data;
      if (remote !== undefined) {
        expected.add(rel);
        const text = p.blobs[rel];
        if (typeof text !== "string" || text.length > 4 * Math.ceil(FILE / 3))
          fail("Invalid patch content");
        data = Buffer.from(text, "base64");
        if (
          data.length > FILE ||
          (bytes += data.length) > BATCH ||
          data.toString("base64") !== text ||
          sha(data) !== remote
        )
          fail("Bad content hash");
      }
      if (cur === remote) continue;
      (cur !== old ? conflicts : plan).push({ rel, file, data, old });
    }
    if (Object.keys(p.blobs).some((n) => !expected.has(n)))
      fail("Unexpected patch content");
    if (conflicts.length) {
      const at = path.join(this.store, "conflicts", k, p.rev),
        entries = [];
      fs.mkdirSync(at, { recursive: true, mode: 0o700 });
      for (const c of conflicts) {
        const blob = c.data ? sha(c.data) : null;
        if (blob && !stat(path.join(at, blob)))
          fs.writeFileSync(path.join(at, blob), c.data, {
            flag: "wx",
            mode: 0o600,
          });
        entries.push({ path: c.rel, remoteBlob: blob });
      }
      writeState(at, "manifest.json", entries);
      writeState(this.store, k + ".json", {
        ...before,
        status: "conflict",
        conflicts: entries.length,
      });
      return { status: "conflict", rev: before.rev };
    }
    const resulting = { ...local.files };
    for (const c of plan) {
      if (c.data)
        Object.defineProperty(resulting, c.rel, {
          value: p.files[c.rel],
          configurable: true,
          enumerable: true,
        });
      else delete resulting[c.rel];
    }
    manifest(resulting);
    for (const c of plan) {
      this.target(k, c.rel);
      fs.mkdirSync(path.dirname(c.file), { recursive: true, mode: 0o700 });
      // Reserve a unique sibling before moving the old inode. Never overwrite an
      // edit made between scan and install; keep recovery data if restoration races.
      const stage = fs.mkdtempSync(
          path.join(path.dirname(c.file), ".t3-sync-"),
        ),
        backup = path.join(stage, "original"),
        incoming = path.join(stage, "new");
      try {
        let mode = 0o600;
        if (c.old !== undefined) {
          fs.renameSync(c.file, backup);
          mode = fs.lstatSync(backup).mode & 0o777;
          if (sha(readFile(backup)) !== c.old)
            fail("Concurrent edit; patch stopped");
        }
        if (c.data) {
          fs.writeFileSync(incoming, c.data, { mode, flag: "wx" });
          fs.linkSync(incoming, c.file);
        }
        if (stat(backup)) fs.unlinkSync(backup);
      } catch (e) {
        if (stat(backup) && !stat(c.file)) {
          fs.linkSync(backup, c.file);
          fs.unlinkSync(backup);
        }
        throw e;
      } finally {
        if (stat(incoming)) fs.unlinkSync(incoming);
        if (!stat(backup)) fs.rmdirSync(stage);
      }
    }
    writeState(this.store, k + ".json", {
      ...target,
      status: "applied",
      at: Date.now(),
    });
    return { status: "applied", rev: p.rev };
  }
}
function advance(t, name) {
  if (t[0] === "**")
    return [t, ...(t.length === 1 ? [[]] : advance(t.slice(1), name))];
  return match(name, t[0]) ? [t.slice(1)] : [];
}
