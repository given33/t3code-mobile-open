import { readFileSync } from "node:fs";
import { HttpError } from "./state.mjs";
const base = "/api/plugin-ext/t3-mobile-link/panel";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (v) => (v ? new Date(v).toISOString() : "—");
function content(s) {
  const f = s.family?.peer;
  return `<fieldset><legend>连接与权限</legend>${[
    ["enabled", "启用手机连接"],
    ["actions", "允许手机操作"],
    ["terminal", "允许原生终端"],
  ]
    .map(
      ([k, label]) =>
        `<label><input data-setting="${k}" type="checkbox" ${s.config[k] ? "checked" : ""}>${label}</label>`,
    )
    .join("")}</fieldset>
    <section><h2>扫码配对</h2><p>${s.listening ? "监听中 · " + s.addresses.map(esc).join("，") : "未监听"}</p><p>安全码 <strong>${esc(s.safetyCode)}</strong></p>
    ${s.pairing ? `<div class="qr" aria-label="配对二维码">${s.pairing.svg}</div><p>请在 ${date(s.pairing.expiresAt)} 前扫码</p><label>配对链接 <input id="uri" readonly value="${esc(s.pairing.uri)}"></label><button id="copy">复制链接</button>` : "<p>暂无有效配对码</p>"}<button id="refresh" ${s.listening ? "" : "disabled"}>刷新配对码</button></section>
    <section><h2>已配对设备</h2>${s.devices.length ? `<ul>${s.devices.map((d) => `<li><b>${esc(d.name)}</b> · 配对 ${esc(date(d.pairedAt))} · 最近活跃 ${esc(date(d.lastActive))} <button data-revoke="${esc(d.id)}">撤销</button></li>`).join("")}</ul>` : "<p>暂无设备</p>"}</section>
    <section><h2>跨端同步与接力</h2><p>${s.relay.enabled ? "已启用" : "未启用"} · 角色 ${esc(s.relay.role ?? "—")} · 已授权工作区 ${s.relay.syncedWorkspaces.length} · 租约 ${esc(s.relay.leaseState)} · 冲突 ${s.relay.conflicts}</p>${s.relay.syncedWorkspaces.map(w => `<p>${esc(w.projectKey)} · <code>${esc(w.rev?.slice(0,12) ?? "—")}</code> · ${esc(w.status)}</p>`).join("")}</section>
    <section><h2>Family</h2>${f ? `<p>${esc(s.family.familyId)} · 本节点 ${esc(s.host.role)} (${s.listening ? "已启用" : "未启用"})</p><p>${esc(f.displayName)} · ${esc(f.role)} · ${s.peerOnline ? "在线" : "未连通"} · ${f.hosts.map(esc).join("，")}</p>` : "<p>未配置对端</p>"}</section>`;
}
function html(s) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mobile Link</title><style>:root{color-scheme:light dark;font:14px system-ui}body{max-width:54rem;margin:1rem}h1,h2{font-size:1.1rem}label,button{margin:.3rem}section,fieldset{border:1px solid #8886;border-radius:.5rem;padding:.7rem;margin:.7rem 0}.qr{max-width:16rem;background:white}.qr svg{display:block;width:100%}li{overflow-wrap:anywhere}#uri{width:min(65%,36rem)}#notice{min-height:1.3em}</style><h1>T3 Mobile Link</h1><div id="notice" role="status" aria-live="polite"></div><main>${content(s)}</main><script src="${base}/script.js" defer></script></html>`;
}
const script = readFileSync(new URL("./panel.js", import.meta.url), "utf8");
export function panel(service) {
  return async (req, path) => {
    const reply = (body, status, type) =>
      new Response(body, {
        status,
        headers: {
          "content-type": type,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        },
      });
    try {
      if (req.method === "GET") {
        if (path === "/panel")
          return reply(
            html(await service.panelState()),
            200,
            "text/html; charset=utf-8",
          );
        if (path === "/panel/script.js")
          return reply(script, 200, "application/javascript");
        if (path === "/panel/api/state")
          return reply(
            JSON.stringify(await service.panelState()),
            200,
            "application/json",
          );
        if (path === "/panel/api/view")
          return reply(
            content(await service.panelState()),
            200,
            "text/html; charset=utf-8",
          );
      }
      if (req.method === "POST" && path.startsWith("/panel/api/")) {
        if (
          req.headers.get("content-type")?.split(";")[0] !== "application/json"
        )
          throw new HttpError(415, "Expected JSON");
        let b;
        try {
          b = await req.json();
        } catch {
          throw new HttpError(400, "Invalid JSON");
        }
        if (path === "/panel/api/config") await service.configure(b);
        else if (path === "/panel/api/refresh") {
          if (!service.server) throw new HttpError(409, "Listener disabled");
          service.pair.refresh();
        } else if (path === "/panel/api/revoke") service.revoke(b?.id);
        else return new Response(null, { status: 404 });
        return reply('{"ok":true}', 200, "application/json");
      }
      return new Response(null, { status: 404 });
    } catch (e) {
      return reply(
        JSON.stringify({
          error: e.status
            ? e.message
            : "Mobile Link configuration or service unavailable",
        }),
        e.status ?? 500,
        "application/json",
      );
    }
  };
}
