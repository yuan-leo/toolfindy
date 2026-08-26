const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const host = "127.0.0.1";
const port = 4173;
const root = path.resolve(__dirname, "app");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((request, response) => {
  if (request.url === "/__findry/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  let filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    response.writeHead(403); response.end("Forbidden"); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(root, "index.html");
  fs.readFile(filePath, (error, data) => {
    if (error) { response.writeHead(404); response.end("Not found"); return; }
    response.writeHead(200, {
      "content-type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "cross-origin-opener-policy": "same-origin-allow-popups",
      "referrer-policy": "no-referrer-when-downgrade",
      "x-content-type-options": "nosniff",
    });
    response.end(data);
  });
});

server.on("error", (error) => {
  console.error("\nTool Findy could not start on http://127.0.0.1:4173");
  console.error(error.code === "EADDRINUSE" ? "Tool Findy may already be running. Check your browser." : error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log("Tool Findy is running locally.");
  console.log(`Open ${url} if your browser does not appear.`);
  console.log("Close this window to stop Tool Findy.\n");
  if (process.env.FINDRY_NO_BROWSER !== "1") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
});
