// Run directly with <real host entry>, or via e2e.mjs --mobile-ui. All accounts, drafts and host data are isolated.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(
  new URL("../plugin/package.json", import.meta.url),
);

const modelSelection = { instanceId: "mobile-ui-fixture", model: "hold" };
export function configureMobileUI(dir) {
  mkdirSync(join(dir, "userdata"), { recursive: true });
  writeFileSync(
    join(dir, "userdata/settings.json"),
    JSON.stringify({
      defaultModelSelection: modelSelection,
      providerInstances: {
        [modelSelection.instanceId]: {
          driver: "acpRegistry",
          displayName: "Mobile QA",
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [
              fileURLToPath(
                new URL("./handoff-acp-fixture.mjs", import.meta.url),
              ),
              join(dir, "qa-markers"),
              "--mobile-ui",
            ],
          },
        },
      },
    }),
  );
}
async function seed(origin, admin, workspace) {
  const WS = require("ws");
  const ws = new WS(
    origin.replace(/^http/, "ws") + "/ws?orchestrationProtocol=2",
    {
      headers: { authorization: `Bearer ${admin}` },
    },
  );
  let seq = 0;
  async function rpc(tag, payload) {
    const id = String(++seq);
    ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    for (;;) {
      const [data] = await once(ws, "message", {
        signal: AbortSignal.timeout(8000),
      });
      const frame = JSON.parse(data);
      if (frame._tag === "Exit" && frame.requestId === id) {
        assert.equal(frame.exit._tag, "Success", tag);
        return;
      }
    }
  }
  try {
    await once(ws, "open", { signal: AbortSignal.timeout(8000) });
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: "create-ui-project",
      projectId: "ui-project",
      title: "Mobile QA",
      workspaceRoot: workspace,
      defaultModelSelection: modelSelection,
    });
    await rpc("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: "create-ui-thread",
      threadId: "ui-thread",
      projectId: "ui-project",
      title: "Mobile layout",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    await rpc("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: "mobile-ui-message",
      threadId: "ui-thread",
      messageId: "ui-prompt",
      text: "Show the mobile layout sample",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  } finally {
    ws.terminate();
  }
}
export async function mobileUI({
  bin,
  origin,
  linkPort,
  pin,
  cookie,
  admin,
  workspace,
  environmentId,
}) {
  const web = join(dirname(bin), "../../web");
  const { chromium } = require(
    process.env.T3MOBILE_PLAYWRIGHT ||
      require.resolve("playwright", { paths: [web] }),
  );
  const out = fileURLToPath(new URL("../build/mobile-ui/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.T3MOBILE_CHROMIUM
      ? { executablePath: resolve(process.env.T3MOBILE_CHROMIUM) }
      : {}),
    args: [
      "--ignore-certificate-errors-spki-list=" +
        Buffer.from(pin, "base64url").toString("base64"),
    ],
  });
  const base = `https://127.0.0.1:${linkPort}`,
    results = [];
  try {
    await seed(origin, admin, workspace);
    for (const [width, height] of [
      [402, 874],
      [390, 844],
      [430, 932],
    ])
      for (const colorScheme of ["light", "dark"]) {
        const label = `${width}-${colorScheme}`;
        const ctx = await browser.newContext({
          viewport: { width, height },
          colorScheme,
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 1,
          locale: "en-US",
        });
        try {
          await ctx.addCookies([
            {
              name: "t3m_session",
              value: cookie.slice(cookie.indexOf("=") + 1),
              url: base,
              secure: true,
              httpOnly: true,
              sameSite: "Strict",
            },
          ]);
          await ctx.addInitScript(() => {
            window.mobileEvents = [];
            window.WebSocket = new Proxy(window.WebSocket, {
              construct(ctor, args, target) {
                const socket = Reflect.construct(ctor, args, target);
                if (new URL(socket.url).pathname === "/ws")
                  window.qaSocket = socket;
                return socket;
              },
            });
            window.webkit = {
              messageHandlers: {
                t3Mobile: { postMessage: (e) => window.mobileEvents.push(e) },
              },
            };
            new MutationObserver((_, obs) => {
              if (document.documentElement) {
                document.documentElement.setAttribute(
                  "data-t3m-native-nav",
                  "",
                );
                obs.disconnect();
              }
            }).observe(document, { childList: true });
          });
          const p = await ctx.newPage();
          p.setDefaultTimeout(10000);
          const cdp = await ctx.newCDPSession(p);
          await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
          async function swipe(from, to) {
            const point = x => [{ x, y: Math.round(height / 2) }];
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
            for (let i = 1; i <= 5; i++) {
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchMove", touchPoints: point(from + (to - from) * i / 5),
              });
            }
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          }
          async function capture(stage) {
            const dimensions = await p.evaluate(() => [
              innerWidth,
              document.documentElement.scrollWidth,
            ]);
            assert.equal(dimensions[0], width);
            assert.ok(dimensions[1] <= width);
            await p.screenshot({
              path: join(out, `${label}-${stage}.png`),
              // The official sidebar labels local sessions with the machine name.
              mask: [p.getByText(hostname(), { exact: true })],
              maskColor: "#777777",
            });
            return dimensions[1];
          }
          async function open(path) {
            await p.goto(base + path);
            await p.waitForFunction(() =>
              window.mobileEvents.some(
                (e) => e.type === "ws" && e.state === "connected",
              ),
            );
          }
          const thread = `/${environmentId}/ui-thread`;
          await open("/");
          await p
            .locator('[data-sidebar="trigger"]')
            .first()
            .waitFor({ state: "attached" });
          const row = {
            width,
            height,
            colorScheme,
            home: await capture("home"),
          };
          assert.equal(
            await p.locator('[data-sidebar="trigger"]:visible').count(),
            0,
          );
          const sidebar = p.locator('[data-mobile="true"][data-sidebar="sidebar"]');
          async function drawerState(open) {
            await p.waitForFunction(expected => window.mobileEvents.filter(e => e.type === "ui").at(-1)?.drawerOpen === expected, open);
            await sidebar.waitFor({ state: open ? "visible" : "hidden" });
          }
          await drawerState(false);
          await p.locator('[data-chat-composer-form]').waitFor();
          row.safeAreaFixture = await p.evaluate(() => {
            const probe = document.createElement("div");
            probe.style.paddingBottom = "env(safe-area-inset-bottom)";
            document.body.appendChild(probe);
            const value = parseFloat(getComputedStyle(probe).paddingBottom);
            probe.remove();
            return value;
          });
          assert.equal(row.safeAreaFixture, 34);
          assert.ok(await p.evaluate(() => window.__T3_MOBILE_BRIDGE__.toggleSidebar()));
          await drawerState(true);
          row.sidebar = await capture("sidebar");
          row.drawerWidth = await sidebar.evaluate(e => e.getBoundingClientRect().width);
          assert.ok(row.drawerWidth <= 320 && row.drawerWidth <= width * .82 + 1);
          await p.touchscreen.tap(width - 8, Math.round(height / 2));
          await drawerState(false);
          await swipe(5, 150);
          await drawerState(true);
          await swipe(240, 60);
          await drawerState(false);
          await swipe(5, 150);
          await drawerState(true);
          const sessionRow = sidebar.locator('[data-sidebar-row]').filter({ hasText: "Mobile layout" });
          await sessionRow.tap();
          await p.waitForURL(base + thread);
          await drawerState(false);
          const editor = p.locator('.ProseMirror[contenteditable="true"]');
          await editor.waitFor({ state: "attached" });
          await p
            .locator("pre")
            .filter({ hasText: "const longLine" })
            .first()
            .waitFor();
          // Tapping the current thread must dismiss as well, without a route change.
          await swipe(5, 150);
          await drawerState(true);
          await sessionRow.tap();
          await drawerState(false);
          row.drawerEvents = await p.evaluate(() => window.mobileEvents.filter(e => e.type === "ui").map(e => e.drawerOpen));
          assert.deepEqual(row.drawerEvents, [false,true,false,true,false,true,false,true,false]);
          row.thread = await capture("thread");
          const draft = "测试语音草稿";
          assert.ok(
            await p.evaluate(
              (text) => window.__T3_MOBILE_BRIDGE__.insertDraft(text),
              draft,
            ),
          );
          await p.waitForFunction(
            (text) =>
              document
                .querySelector(".ProseMirror")
                ?.textContent.includes(text),
            draft,
          );
          // Reloading forces the editor to reconstruct from the React-persisted draft.
          await p.reload();
          await editor.waitFor({ state: "attached" });
          const expand = p.locator(
            "[data-chat-composer-transition-prompt]:visible",
          );
          if (await expand.count()) await expand.click();
          await editor.waitFor();
          await p.waitForFunction(
            (text) =>
              document
                .querySelector(".ProseMirror")
                ?.textContent.includes(text),
            draft,
          );
          row.draftPersisted = true;
          row.font = await editor.evaluate((e) =>
            parseFloat(getComputedStyle(e).fontSize),
          );
          assert.ok(row.font >= 16);
          const shell = '[data-slot="composer-shell"]';
          const bottom = () => p.locator(shell).evaluate(e => e.getBoundingClientRect().bottom);
          row.before = await bottom();
          row.bottomGap = height - row.before;
          assert.ok(row.bottomGap >= 0 && row.bottomGap <= 8, `Composer bottom gap ${row.bottomGap}px`);
          async function keyboard(inset) {
            await p.evaluate(px => window.__T3_MOBILE_BRIDGE__.setKeyboard(px, 250), inset);
            await p.waitForFunction(({shell, target}) =>
              document.querySelector(shell).getBoundingClientRect().bottom === target,
              {shell, target: row.before - inset});
            return bottom();
          }
          row.raised = await keyboard(300);
          row.restored = await keyboard(0);
          assert.equal(row.before - row.raised, 300);
          assert.equal(row.before, row.restored);
          const state = await p.evaluate(() => {
            const theme = window.mobileEvents
              .filter((e) => e.type === "theme")
              .at(-1);
            const el = document.createElement("div");
            el.style.backgroundColor = "var(--background)";
            document.body.appendChild(el);
            const css = getComputedStyle(el).backgroundColor;
            el.remove();
            const ctx = document.createElement("canvas").getContext("2d");
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            const actual =
              "#" +
              Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3), (n) =>
                n.toString(16).padStart(2, "0"),
              ).join("");
            return {
              actual,
              theme,
              route: window.mobileEvents
                .filter((e) => e.type === "route")
                .at(-1)?.pathname,
              connected: window.mobileEvents.some(
                (e) => e.type === "ws" && e.state === "connected",
              ),
            };
          });
          assert.equal(state.theme.dark, colorScheme === "dark");
          assert.equal(state.theme.bgBase, state.actual);
          assert.match(state.actual, /^#[0-9a-f]{6}$/);
          assert.equal(state.route, thread);
          assert.ok(state.connected);
          Object.assign(row, {
            bg: state.actual,
            routeMatches: true,
            ws: "connected",
          });
          const attachment = p.locator('input[type="file"][multiple]').first();
          await attachment.setInputFiles({
            name: "qa-mobile.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("fixture attachment"),
          });
          await p
            .getByText("qa-mobile.txt", { exact: false })
            .first()
            .waitFor();
          row.fileInput = true;
          await p.evaluate(() => window.qaSocket.close(1000, "fixture"));
          await p.waitForFunction(() =>
            window.mobileEvents.some(
              (e) => e.type === "ws" && e.state === "disconnected",
            ),
          );
          await p
            .evaluate(() => window.__T3_MOBILE_BRIDGE__.reconnect())
            .catch((e) => {
              if (!String(e).includes("Execution context was destroyed"))
                throw e;
            });
          await p.waitForFunction(
            () =>
              window.qaSocket?.readyState === WebSocket.OPEN &&
              window.mobileEvents.filter((e) => e.type === "ws").at(-1)
                ?.state === "connected",
          );
          row.reconnected = true;
          const worked = p.getByRole("button", { name: /Worked for/ }).first();
          await worked.click();
          const change = p.getByText("Changed 1 file", { exact: true });
          await change.waitFor();
          row.toolCard = await capture("tool");
          await change.click();
          await p
            .getByText(/sample\.txt/)
            .first()
            .waitFor();
          await p.getByRole("button", { name: "Open diff" }).click();
          await p
            .locator("[data-diff], [data-diff-file-key]")
            .first()
            .waitFor();
          row.diff = await capture("diff");
          await open("/settings/general");
          await p.getByRole("dialog").first().waitFor();
          row.settings = await capture("settings");
          await p.getByRole("combobox").first().click();
          await p.getByRole("listbox").first().waitFor();
          row.dropdown = await capture("dropdown");
          results.push(row);
          console.log("Chromium", JSON.stringify(row));
        } finally {
          await ctx.close();
        }
      }
    writeFileSync(
      join(out, "results.json"),
      JSON.stringify({ browser: browser.version(), results }, null, 2),
    );
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw Error("Usage: node scripts/mobile-ui-e2e.mjs <real host entry>");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./e2e.mjs", import.meta.url)),
    process.argv[2], "--mobile-ui"], { stdio: "inherit", windowsHide: true });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
}
