import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import net from "node:net";
import https from "node:https";
import { once } from "node:events";
import { pinnedAgent } from "../lib/pinned.mjs";
import WebSocket from "ws";
export function temp() {
  const root = realpathSync.native(tmpdir()),
    dir = mkdtempSync(join(root, "mobile-link-test-"));
  return {
    dir,
    clean() {
      const actual = realpathSync.native(dir);
      if (
        dirname(actual) !== root ||
        !basename(actual).startsWith("mobile-link-test-")
      )
        throw Error("Unsafe cleanup path");
      rmSync(actual, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    },
  };
}
export async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const p = server.address().port;
  await new Promise((r) => server.close(r));
  return p;
}
export function mobile(
  port,
  pin,
  path,
  { method = "GET", headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const agent = pinnedAgent(pin);
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        agent,
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(8000),
      },
      async (res) => {
        try {
          const chunks = [];
          for await (const data of res) chunks.push(data);
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        } catch (e) {
          reject(e);
        } finally {
          agent.destroy();
        }
      },
    );
    req.on("error", (e) => {
      agent.destroy();
      reject(e);
    });
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
export function openWs(port, pin, headers, query = "orchestrationProtocol=2") {
  const agent = pinnedAgent(pin);
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws?${query}`, {
    agent,
    headers,
    origin: `https://127.0.0.1:${port}`,
    handshakeTimeout: 5000,
  });
  ws.once("close", () => agent.destroy());
  return ws;
}
export const deadline = () => ({ signal: AbortSignal.timeout(6000) });
