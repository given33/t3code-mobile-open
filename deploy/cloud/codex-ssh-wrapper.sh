#!/bin/sh
# Install this file as bin/codex on the gateway and bin/ssh-dispatch on the worker.
set -eu
case "${0##*/}" in
  ssh-dispatch)
    exec /usr/bin/python3 -I -c '
import base64, json, os, re, sys
cmd = os.environ.get("SSH_ORIGINAL_COMMAND", "")
m = re.fullmatch(r"t3-codex-v1 ([A-Za-z0-9_=-]{1,98304})", cmd)
if not m: sys.exit("Expected a Codex bridge request")
try:
    cwd, args, env = json.loads(base64.urlsafe_b64decode(m[1]).decode("ascii"))
    if not isinstance(cwd, str) or cwd.startswith("/") or ".." in cwd.split("/"): raise ValueError()
    if not isinstance(args, list) or not all(isinstance(x, str) and "\0" not in x for x in args): raise ValueError()
    if not isinstance(env, dict) or not all(k in ("LANG", "LC_ALL", "TERM", "NO_COLOR", "RUST_LOG") and isinstance(v, str) and "\0" not in v for k,v in env.items()): raise ValueError()
    root = "/var/lib/t3-codex/workspace"
    dest = os.path.realpath(os.path.join(root, cwd))
    if os.path.commonpath([dest, root]) != root: raise ValueError()
    os.chdir(dest)
except (ValueError, TypeError, OSError): sys.exit("Invalid request or worker workspace is missing")
os.environ.update(env)
os.execv("/opt/t3-codex/bin/codex", ["codex", *args])'
    ;;
esac
case "${T3_CODEX_EXEC_MODE:-hk-ssh}" in
  local) exec /opt/t3-cloud/bin/codex-local "$@" ;;
  hk-ssh) ;;
  *) echo 'Unknown T3_CODEX_EXEC_MODE' >&2; exit 64 ;;
esac
# ssh joins remote argv into one shell command. Send only a fixed verb and one
# shell-inert operand; do not consume stdin (app-server uses it for JSON-RPC).
request=$(/usr/bin/python3 -I -c '
import base64, json, os, sys
root = "/var/lib/t3-cloud/workspace"
cwd = os.getcwd()
if cwd in ("/", "/var/lib/t3-cloud"): rel = "."  # service/standalone probe
elif os.path.commonpath([cwd, root]) == root: rel = os.path.relpath(cwd, root)
else: sys.exit("Run Codex from the configured gateway workspace")
env = {k: os.environ[k] for k in ("LANG", "LC_ALL", "TERM", "NO_COLOR", "RUST_LOG") if k in os.environ}
b = base64.urlsafe_b64encode(json.dumps([rel,sys.argv[1:],env],ensure_ascii=True).encode("ascii"))
if len(b) > 98304: sys.exit("Bridge argument list too long")
print(b.decode("ascii"))' "$@")
# ControlMaster=no uses an existing socket but never creates a second master.
# OpenSSH can connect directly if the socket is missing. Never replay a stdio session.
exec /usr/bin/ssh -T -F /etc/t3-cloud/ssh_config -o ControlMaster=no \
  -S /run/t3-cloud/hk.mux codex-worker t3-codex-v1 "$request"
