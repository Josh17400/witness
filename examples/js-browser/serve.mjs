// Tiny static server for the browser sample (no npx, no dependencies): `node serve.mjs`.
// Serves this folder, maps /witness/witness.js to the adapter in this repo, and accepts replays
// posted by ?witness_record=/__witness/record into witness/replays/<session>.jsonl.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = +process.env.PORT || 5317;
const alias = { "/witness/witness.js": path.join(root, "..", "..", "adapters", "js", "witness.js") };
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css", ".wav": "audio/wav" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/__witness/record") {
    const session = (url.searchParams.get("session") || "session").replace(/[^\w-]+/g, "_");
    const dir = path.join(root, "witness", "replays");
    fs.mkdirSync(dir, { recursive: true });
    req.pipe(fs.createWriteStream(path.join(dir, `${session}.jsonl`), { flags: "a" })).on("finish", () => res.writeHead(204).end());
    return;
  }
  const file = alias[url.pathname] || path.join(root, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!alias[url.pathname] && !file.startsWith(root + path.sep)) return res.writeHead(403).end("forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(data);
  });
});

let tries = 0;
server.on("error", (e) => {   // a previous server may still be shutting down: retry for a few seconds
  if (e.code === "EADDRINUSE" && ++tries < 25) return setTimeout(() => server.listen(port, "127.0.0.1"), 200);
  console.error(`serve.mjs: ${e.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`coins: http://127.0.0.1:${port}/`));

// Exit with whoever started us (a shell wrapper may be killed without killing its children).
const parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000).unref();
