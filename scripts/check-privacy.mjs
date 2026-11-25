// Run at a checkout root. Git is the file list, not a hand-maintained glob.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 128 * 1024 * 1024 });
const paths = (...args) =>
  git(...args)
    .toString()
    .split("\0")
    .filter(Boolean);
const allowedDomains = new Set([
  "example.com",
  "example.org",
  "example.net",
  "www.w3.org",
  "registry.npmjs.org",
  "github.com",
]);
const personalAlias = new RegExp(
  "\\b" + ["her", "mes"].join("") + "[-.](?:hub|hk)\\b",
  "i",
);
const rules = [
  ["private material", /\bBEGIN (?:[A-Z0-9 ]*PRIVATE KEY\b|CERTIFICATE-----)/],
  [
    "credential",
    /(?:\bsk-[A-Za-z0-9_-]{12,}|\b(?:gh[pousr]_|github_pat_|xox[baprs]-)[\w-]{8,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]{12,}\.[\w-]{8,}\.[\w-]{8,})/,
  ],
  [
    "personal path",
    /(?:[a-z]:[\\/]+users[\\/]+|\/Users\/(?!example(?:\/|$|[\s"']))[^/\s"'<>]+|[a-z]:[\\/]+t3code-local\b|\/home\/(?!example\b)[\w.-]+\/)/i,
  ],
  ["private server alias", personalAlias],
];
function allowedIP(ip) {
  return (
    ["127.0.0.1", "0.0.0.0"].includes(ip) ||
    /^(?:192\.0\.2|198\.51\.100|203\.0\.113|10\.0\.0|192\.168\.1)\./.test(ip)
  );
}
function domainAllowed(host) {
  return (
    allowedDomains.has(host) ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(host) ||
    /\.(?:invalid|test|example)$/.test(host)
  );
}
function reason(s) {
  for (const [kind, re] of rules) if (re.test(s)) return kind;
  for (const [ip] of s.matchAll(
    /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g,
  ))
    if (ip.split(".").every((n) => Number(n) < 256) && !allowedIP(ip))
      return "non-example IPv4";
  // Arbitrary URL hosts, plus bare domains in common public and private DNS zones.
  const dns =
    /\b(?:https?|wss?|ssh):\/\/(?:[^\s/@]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)|\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|me|dev|cn|hk|xyz|cloud|cc|top|online|site|info|biz|tech|work|network|local|internal|lan|home\.arpa))\b/gi;
  for (const m of s.matchAll(dns)) {
    const host = (m[1] ?? m[2]).toLowerCase();
    if (!/^\d+(?:\.\d+){3}$/.test(host) && !domainAllowed(host))
      return "unapproved DNS name";
  }
}
let violations = 0;
function check(file, content, source) {
  const nameProblem = reason(file);
  const runtime =
    /(?:^|\/)(?:source-grants\.json|family-(?:route|grants)\.json|devices\.json|identity\.json|\.env(?:\..*)?|[^/]+\.(?:pem|p8|p12|key|ipa|tgz))$/i.test(
      file,
    );
  const data = content.toString("utf8");
  // Allow only the literal ATS dictionary key, in this exact plist. Inspect every
  // other occurrence normally (including subdomains and suffixed lookalikes).
  const inspect = (text) => reason(file === "ios/T3Mobile/Info.plist"
    ? text.replace(/(<key>NSExceptionDomains<\/key>\s*<dict>\s*)<key>t3-cloud\.sslip\.io<\/key>/, "$1<key>ats-example</key>") : text);
  const problem =
    nameProblem ||
    ((runtime || /(?:^|\/)task-sync\//.test(file)) && "runtime/private file") ||
    inspect(data) ||
    (data.includes("\0") && inspect(content.toString("utf16le")));
  if (problem) {
    console.error(
      `${source}: ${nameProblem ? "[private filename]" : file}: ${problem}`,
    );
    violations++;
  }
}
const work = new Set(
  paths("ls-files", "--cached", "--others", "--exclude-standard", "-z"),
);
for (const file of work) {
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) continue; // staged deletions and unstaged removals
  if (st.isSymbolicLink()) check(file, Buffer.from(readlinkSync(file)), "link");
  else if (st.isFile()) check(file, readFileSync(file), "worktree");
  else throw new Error("Unsupported tracked entry; inspect nested checkout");
}
for (const file of paths(
  "diff",
  "--cached",
  "--name-only",
  "--diff-filter=ACMRT",
  "-z",
))
  check(file, git("show", `:${file}`), "index");
console.log(`Privacy: ${work.size} paths checked; ${violations} violations`);
process.exitCode = violations ? 1 : 0;
