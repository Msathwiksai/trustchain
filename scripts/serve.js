/**
 * Tiny static file server for the web console. Serves the repository root so the
 * page can read /web, /deployments/localhost.json and the compiled ABIs in /artifacts.
 *   node scripts/serve.js  ->  http://127.0.0.1:5173/web/
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/web/index.html";
    if (rel.endsWith("/")) rel += "index.html";

    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(buf);
    });
  })
  .on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      // Almost always a console already running in another window, not a problem.
      console.log(`Already serving on http://127.0.0.1:${PORT}/web/ - open it in a browser.`);
      console.log(`(To move it elsewhere: PORT=5174 npm run web)`);
      return;
    }
    throw e;
  })
  .listen(PORT, () => console.log(`Web console on http://127.0.0.1:${PORT}/web/`));
