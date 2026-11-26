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
  let colorContext;
  function srgb(color) {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    colorContext ??= document.createElement("canvas").getContext("2d", {willReadFrequently:true});
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = color;
    colorContext.fillRect(0, 0, 1, 1);
    const [r,g,b] = colorContext.getImageData(0, 0, 1, 1).data;
    return "#" + [r,g,b].map(n => n.toString(16).padStart(2, "0")).join("");
  }
  function theme() {
    const css = getComputedStyle(root),
      bgBase =
        css.getPropertyValue("--background").trim() || css.backgroundColor;
    const fields = {
      dark: root.classList.contains("dark") || css.colorScheme === "dark",
      bgBase: srgb(bgBase),
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
  async function insertDraft(text) {
    if (typeof text !== "string" || !text) return false;
    const collapsed = document.querySelector('[data-chat-composer-mobile-collapsed="true"] [data-chat-composer-transition-prompt]');
    if (collapsed) {
      collapsed.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const selector =
      'textarea:not(:disabled):not([readonly]),input[type="text"]:not(:disabled):not([readonly]),[contenteditable="true"]';
    const el =
      document.activeElement?.closest(selector) ??
      document.querySelector('.ProseMirror[contenteditable="true"]') ??
      document.querySelector(selector);
    if (!el || !el.getBoundingClientRect().width) return false;
    el.focus({preventScroll:true});
    // Tiptap exposes its Editor on the content DOM. Use a transaction so update,
    // selection, history and React draft persistence see the same change.
    if (el.editor?.view?.dom === el) {
      const view = el.editor.view;
      view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      return true;
    }
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
  const drawerSelector = '[data-sidebar="sidebar"][data-mobile="true"]:is([data-open], [data-state="open"])';
  const openDrawer = () => document.querySelector(drawerSelector);
  function toggleSidebar() {
    const el = document.querySelector('[data-sidebar-control] [data-sidebar="trigger"]') ??
        document.querySelector('[data-sidebar="trigger"]');
    el?.click();
    return !!el;
  }
  function watchDrawer() {
    let reported;
    function report() {
      const drawerOpen = !!openDrawer();
      if (drawerOpen === reported) return;
      reported = drawerOpen;
      post("ui", { drawerOpen });
    }
    new MutationObserver(report).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-open", "data-state", "data-mobile"],
    });
    report();
  }
  function installDrawerGestures() {
    let swipe;
    const nativePhone = () => root.hasAttribute("data-t3m-native-nav") && matchMedia("(max-width: 767px)").matches;
    addEventListener("touchstart", e => {
      swipe = null;
      if (e.touches.length !== 1 || !nativePhone()) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const drawer = openDrawer();
      if (!drawer && (x > 24 || document.querySelector('[role="dialog"]:is([data-open], [data-state="open"])'))) return;
      if (drawer && !drawer.contains(e.target) && e.target !== drawer.parentElement) return;
      swipe = { x, y, drawer };
    }, { capture: true, passive: true });
    addEventListener("touchmove", e => {
      if (!swipe) return;
      const dx = (e.touches[0].clientX - swipe.x) * (swipe.drawer ? -1 : 1);
      const dy = Math.abs(e.touches[0].clientY - swipe.y);
      if (dy > 10 && dy >= dx) swipe = null;
      else if (dx > 10 && dx > dy * 1.5 && e.cancelable) e.preventDefault();
    }, { capture: true, passive: false });
    addEventListener("touchcancel", () => { swipe = null; }, true);
    addEventListener("touchend", e => {
      const start = swipe;
      swipe = null;
      if (!start || start.drawer !== openDrawer()) return;
      const { clientX, clientY } = e.changedTouches[0];
      const dx = (clientX - start.x) * (start.drawer ? -1 : 1);
      if (dx >= 52 && dx > 1.5 * Math.abs(clientY - start.y)) {
        if (e.cancelable) e.preventDefault();
        toggleSidebar();
      }
    }, { capture: true, passive: false });
    addEventListener("click", e => {
      if (!nativePhone()) return;
      const row = e.target.closest?.("[data-sidebar-row]");
      const drawer = row?.closest(drawerSelector);
      if (!drawer || e.target.closest('button, [role="button"], a') !== row) return;
      // Let the host navigate first. A selected row can also be the current route.
      requestAnimationFrame(() => { if (openDrawer() === drawer) toggleSidebar(); });
    }, true);
  }
  window.__T3_MOBILE_BRIDGE__ = Object.freeze({
    toggleSidebar,
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
    new MutationObserver(() => { route(); theme(); }).observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    post("ready");
    route();
    theme();
    watchDrawer();
    installDrawerGestures();
  }
  document.readyState === "loading"
    ? addEventListener("DOMContentLoaded", ready, { once: true })
    : ready();
})();
