// Manual browser fixture: real view/controller and bridge with non-redeemable
// sample data. No TLS listener, host session, pairing credential or disk state.
import http from "node:http";
import { panel } from "../lib/panel.mjs";
import { shellJs, shellCss, injectShell } from "../lib/mobile-shell.mjs";
import { once } from "node:events";
import qrcode from "qrcode-generator";
const uri = "t3mobile://pair?v=1&code=sample",
  qr = qrcode(0, "M");
qr.addData(uri);
qr.make();
const sample = {
  config: { enabled: false, actions: false, terminal: false },
  host: { role: "local" },
  addresses: ["example.com:3081"],
  safetyCode: "0000 0000 0000 0000",
  devices: [],
  family: null,
  relay: { enabled:true, role:"local", leaseState:"peerArmed", conflicts:1,
    syncedWorkspaces:[{projectKey:"demo",rev:"0123456789abcdef",status:"conflict"}] },
};
const model = {
  server: null,
  pair: { refresh() {} },
  async configure(p) {
    Object.assign(sample.config, p);
    this.server = sample.config.enabled;
  },
  async panelState() {
    return {
      ...sample,
      listening: this.server,
      pairing: this.server
        ? { uri, svg: qr.createSvgTag({ scalable: true }), expiresAt: 0 }
        : null,
    };
  },
};
const handle = panel(model),
  base = "/api/plugin-ext/t3-mobile-link";
const server = http.createServer(async (req, res) => {
  const path = req.url;
  if (path === "/fixture") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      injectShell(
        '<!doctype html><html><head><title>Bridge fixture</title><script>window.events=[];window.webkit={messageHandlers:{t3Mobile:{postMessage:m=>events.push(m)}}}</script></head><body><button data-sidebar="trigger" onclick="this.dataset.clicked=1">Sidebar</button><textarea></textarea></body></html>',
      ),
    );
    return;
  }
  if (path === "/mobile/v1/shell.js" || path === "/mobile/v1/shell.css") {
    const js = path.endsWith(".js");
    res.setHeader("content-type", js ? "application/javascript" : "text/css");
    res.end(js ? shellJs : shellCss);
    return;
  }
  if (!path.startsWith(base)) {
    res.writeHead(401).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const result = await handle(
    new Request("http://localhost" + path, {
      method: req.method,
      headers: req.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }),
    path.slice(base.length),
  );
  res.writeHead(result.status, Object.fromEntries(result.headers));
  res.end(await result.text());
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
console.log(`Fixture port ${server.address().port}; press Enter to stop.`);
process.stdin.once("data", () => {
  server.close();
  process.stdin.pause();
});
