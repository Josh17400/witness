// Static server for the web test pages (no dependencies): `node serve.mjs [port]` (default 5318).
// /witness/witness.js → adapters/js/witness.js, /witness/witness_emscripten.js → adapters/cpp/witness_emscripten.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pages = path.join(here, "pages");
const port = +process.argv[2] || +process.env.PORT || 5318;
const alias = {
  "/witness/witness.js": path.join(here, "..", "..", "adapters", "js", "witness.js"),
  "/witness/witness_emscripten.js": path.join(here, "..", "..", "adapters", "cpp", "witness_emscripten.js"),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = alias[url.pathname] || path.join(pages, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!alias[url.pathname] && !file.startsWith(pages + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(data);
  });
});
let tries = 0;
server.on("error", (e) => { if (e.code === "EADDRINUSE" && ++tries < 25) return setTimeout(() => server.listen(port, "127.0.0.1"), 200); console.error(e.message); process.exit(1); });
server.listen(port, "127.0.0.1", () => console.log(`web test pages: http://127.0.0.1:${port}/`));
const parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000).unref();
