import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../../../packages/core/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web");
const port = Number(process.env.PORT || 8787);

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body.length > 1_000_000) throw new Error("request body too large");
  return body ? JSON.parse(body) : {};
}

async function serveWeb(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const file = path.normalize(path.join(webRoot, requested));
  if (!file.startsWith(webRoot + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const content = await readFile(file);
    const type = file.endsWith(".html") ? "text/html" : "text/plain";
    res.writeHead(200, { "content-type": type + "; charset=utf-8" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok", service: "locd-api", version: "0.1.0" });
      return;
    }

    if (req.method === "POST" && req.url === "/v1/decide") {
      const body = await readBody(req);
      sendJson(res, 200, decide(body));
      return;
    }

    if (req.method === "GET") {
      await serveWeb(res, new URL(req.url, "http://localhost").pathname);
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "bad_request" });
  }
});

server.listen(port, () => {
  console.log("LOCD Engine API listening on port " + port);
});
