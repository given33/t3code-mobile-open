import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
export function readState(dir, file, fallback = null) {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export function writeState(dir, file, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${file}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    renameSync(tmp, join(dir, file));
  } finally {
    rmSync(tmp, { force: true });
  }
}
export const digest = (value) =>
  createHash("sha256").update(value).digest("base64url");
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
