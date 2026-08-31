import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = join(import.meta.dirname, "public");
const DATA_DIR = process.env.ORDO_DATA_DIR ?? join(import.meta.dirname, "../../data");
const PORT = Number(process.env.ORDO_WEB_PORT ?? 3000);

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

createServer((req, res) => {
  let path = (req.url ?? "/").split("?")[0];

  // Serve the live measurement report so the site shows real numbers.
  if (path === "/api/report") {
    const f = join(DATA_DIR, "report.json");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(existsSync(f) ? readFileSync(f) : JSON.stringify({ error: "run the report first" }));
    return;
  }

  if (path === "/") path = "/index.html";
  if (path === "/docs") path = "/docs.html";
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`OrdoFi web | http://localhost:${PORT}`));
