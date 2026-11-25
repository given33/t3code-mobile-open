(() => {
  "use strict";
  if (window.__T3_MOBILE_BRIDGE__) return;
  const post = (type, fields = {}) =>
    window.webkit?.messageHandlers?.t3Mobile?.postMessage({ type, ...fields });
  const root = document.documentElement;
  let previousRoute, previousTheme, currentSocket;
  function route() {
    const fields = { pathname: location.pathname, title: document.title };
    if (JSON.stringify(fields) !== previousRoute) {
      previousRoute = JSON.stringify(fields);
      post("route", fields);
    }
  }
  function theme() {
    const css = getComputedStyle(root),
      bgBase =
        css.getPropertyValue("--background").trim() || css.backgroundColor;
    const fields = {
      dark: root.classList.contains("dark") || css.colorScheme === "dark",
      bgBase,
    };
    if (JSON.stringify(fields) !== previousTheme) {
      previousTheme = JSON.stringify(fields);
      post("theme", fields);
    }
  }
  const ws = window.WebSocket;
  window.WebSocket = new Proxy(ws, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      const url = new URL(socket.url);
      if (url.host === location.host && url.pathname === "/ws") {
        currentSocket = socket;
        post("ws", { state: "connecting" });
        socket.addEventListener("open", () => {
          if (currentSocket === socket) post("ws", { state: "connected" });
        });
        socket.addEventListener("close", () => {
          if (currentSocket === socket) post("ws", { state: "disconnected" });
        });
      }
      return socket;
    },
  });
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const result = await Reflect.apply(originalFetch, this, args);
    if (
      result.status === 401 &&
      new URL(result.url || location.href).origin === location.origin
    )
      post("auth-expired");
    return result;
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const r = Reflect.apply(original, this, args);
      route();
      return r;
    };
  }
  addEventListener("popstate", route);
  function insertDraft(text) {
    if (typeof text !== "string" || !text) return false;
    const selector =
      'textarea:not(:disabled):not([readonly]),input[type="text"]:not(:disabled):not([readonly]),[contenteditable="true"]';
    const el =
      document.activeElement?.closest(selector) ??
      document.querySelector('.tiptap[contenteditable="true"]') ??
      document.querySelector(selector);
    if (!el) return false;
    el.focus();
    if (el.isContentEditable)
      return document.execCommand("insertText", false, text);
    const start = el.selectionStart ?? el.value.length,
      end = el.selectionEnd ?? start;
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
    el.setSelectionRange(start + text.length, start + text.length);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
    return true;
  }
  window.__T3_MOBILE_BRIDGE__ = Object.freeze({
    toggleSidebar() {
      const el = [
        ...document.querySelectorAll('[data-sidebar="trigger"]'),
      ].find((e) => e.getClientRects().length);
      el?.click();
      return !!el;
    },
    openRoute(path) {
      const dest = new URL(path, location.href);
      if (dest.origin !== location.origin) return false;
      location.assign(dest.href);
      return true;
    },
    insertDraft,
    setKeyboard(heightPx, durationMs) {
      root.style.setProperty(
        "--t3m-keyboard-inset",
        `${Math.max(0, Math.min(innerHeight, Number(heightPx) || 0))}px`,
      );
      root.style.setProperty(
        "--t3m-keyboard-duration",
        `${Math.max(0, Math.min(2000, Number(durationMs) || 0))}ms`,
      );
    },
    async reconnect() {
      const res = await fetch("/mobile/v1/sync", { cache: "no-store" });
      if (!res.ok) return false;
      if (currentSocket?.readyState !== ws.OPEN) location.reload();
      return true;
    },
    voiceEvent(payload) {
      window.dispatchEvent(
        new CustomEvent("t3mobile:voice", { detail: payload }),
      );
    },
  });
  function ready() {
    new MutationObserver(theme).observe(root, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    new MutationObserver(route).observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    post("ready");
    route();
    theme();
  }
  document.readyState === "loading"
    ? addEventListener("DOMContentLoaded", ready, { once: true })
    : ready();
})();
