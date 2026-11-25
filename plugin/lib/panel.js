(() => {
  const main = document.querySelector("main"),
    notice = document.querySelector("#notice");
  let busy = false;
  async function view() {
    const result = await fetch(`${location.pathname}/api/view`, {
      cache: "no-store",
    });
    if (!result.ok) throw Error(`HTTP ${result.status}`);
    const html = await result.text();
    if (html !== previous) {
      main.innerHTML = html;
      previous = html;
    }
  }
  let previous;
  async function run(action, body) {
    if (busy) return;
    busy = true;
    main.inert = true;
    try {
      if (action) {
        const r = await fetch(`${location.pathname}/api/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error((await r.json()).error);
      }
      await view();
      if (action) notice.textContent = "已更新";
    } catch (e) {
      notice.textContent = String(e.message);
      previous = null;
    } finally {
      busy = false;
      main.inert = false;
    }
  }
  main.addEventListener("change", (e) => {
    if (e.target.dataset.setting)
      run("config", { [e.target.dataset.setting]: e.target.checked });
  });
  main.addEventListener("click", async (e) => {
    if (e.target.dataset.revoke) run("revoke", { id: e.target.dataset.revoke });
    if (e.target.id === "refresh") run("refresh", {});
    if (e.target.id === "copy") {
      const input = document.querySelector("#uri");
      input.select();
      try {
        await navigator.clipboard.writeText(input.value);
        notice.textContent = "已复制";
      } catch {
        notice.textContent = document.execCommand("copy")
          ? "已复制"
          : "请选择并复制链接";
      }
    }
  });
  setInterval(() => {
    if (!document.hidden && document.activeElement?.id !== "uri") run();
  }, 10000);
})();
