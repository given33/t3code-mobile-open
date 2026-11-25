import { readFileSync } from "node:fs";
export const shellJs = readFileSync(
  new URL("./mobile-shell.js", import.meta.url),
  "utf8",
);
export const shellCss = readFileSync(
  new URL("./mobile-shell.css", import.meta.url),
  "utf8",
);
export function injectShell(html) {
  // The classic script executes before deferred/module application entry points.
  return html.replace(
    /<\/head\s*>/i,
    '<link rel="stylesheet" href="/mobile/v1/shell.css"><script src="/mobile/v1/shell.js"></script></head>',
  );
}
