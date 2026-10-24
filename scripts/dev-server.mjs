import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const port = Number(process.env.EASY_HASS_DEV_PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/") {
      response.writeHead(302, { Location: "/easy-hass?preview=1" }).end();
      return;
    }
    let file;
    if (["/easy-hass", "/config", "/lovelace", "/profile"].includes(url.pathname)) {
      file = "frontend/dev/index.html";
    } else if (url.pathname === "/tests/navigation") {
      file = "tests/browser/navigation.html";
    } else if (url.pathname.startsWith("/easy_hass_static/")) {
      file = `custom_components/easy_hass/frontend/${url.pathname.slice(18)}`;
    } else {
      response.writeHead(404).end("Not found");
      return;
    }
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const content = await readFile(resolved);
    response.writeHead(200, { "Content-Type": mime[path.extname(resolved)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found. Frontend zuerst mit npm run build erstellen.");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Lokale HA-Shell-Simulation: http://127.0.0.1:${port}/easy-hass?preview=1`);
  console.log(`Browserprüfungen: http://127.0.0.1:${port}/tests/navigation`);
});
