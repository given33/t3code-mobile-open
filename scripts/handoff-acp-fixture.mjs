// Real ACP subprocess with no network, filesystem tools, credentials or writes to the workspace.
// Record only prompt/cancel markers in the isolated test home; never record prompt bodies.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const send = (frame) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const marker = (word) => appendFileSync(process.argv[2], word + "\n");
let pending,
  sessionId = randomUUID();
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params } = JSON.parse(line);
  if (method === "session/prompt") {
    pending = id;
    marker(
      JSON.stringify(params.prompt).includes(
        "TOOL_OUTCOME_UNKNOWN: verify prior state",
      )
        ? "guarded-prompt"
        : "prompt",
    );
    continue;
  }
  if (method === "session/cancel") {
    marker("cancel");
    if (pending !== undefined)
      send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
    continue;
  }
  if (id == null) continue;
  if (method === "session/load") sessionId = params.sessionId;
  const result =
    method === "initialize"
      ? {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          agentInfo: { name: "handoff-fixture", version: "1" },
        }
      : method === "session/new" || method === "session/load"
        ? {
            ...(method === "session/new" ? { sessionId } : {}),
            models: {
              currentModelId: "hold",
              availableModels: [{ modelId: "hold", name: "Hold" }],
            },
          }
        : {};
  send({ id, result });
}
