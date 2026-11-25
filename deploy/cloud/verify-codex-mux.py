"""Run on the gateway as its service user. Does not read or print credentials."""
import json
import subprocess
import sys

root = "/var/lib/t3-cloud/workspace"
worker = "/var/lib/t3-codex/workspace"
with subprocess.Popen(["/opt/t3-cloud/bin/codex", "app-server"], cwd=root,
                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, universal_newlines=True) as proc:
    def send(method, params, seq=None):
        msg = {"method": method, "params": params}
        if seq is not None:
            msg["id"] = seq
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def result(seq):
        for line in proc.stdout:
            reply = json.loads(line)
            if reply.get("id") == seq:
                if "error" in reply:
                    sys.exit("RPC error: " + str(reply["error"].get("code")))
                return reply["result"]
        sys.exit("Unexpected EOF")

    try:
        send("initialize", {"clientInfo": {"name": "sandbox_probe", "version": "1"},
                            "capabilities": {"experimentalApi": True}}, 1)
        result(1)
        send("initialized", {})
        send("command/exec", {"command": ["/usr/bin/pwd"], "cwd": worker,
                              "sandboxPolicy": {"type": "readOnly", "networkAccess": False}}, 2)
        reply = result(2)
        ok = reply.get("stdout", "").strip() == worker
        loopback = "Failed RTM_NEWADDR" in reply.get("stderr", "")
        print(f"exitCode={reply.get('exitCode')} expectedWorkspace={ok} loopbackDenied={loopback}")
        sys.exit(0 if ok and reply.get("exitCode") == 0 and not loopback else 1)
    finally:
        proc.stdin.close()
        proc.terminate()
