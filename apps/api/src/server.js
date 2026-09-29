import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../../../packages/core/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web");

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
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("invalid JSON");
  }
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
    const extension = path.extname(file);
    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json"
    };
    const type = types[extension] || "text/plain";
    res.writeHead(200, {
      "content-type": type + "; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          service: "locd-api",
          version: "0.1.0"
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/decide") {
        const body = await readBody(req);
        sendJson(res, 200, decide(body));
        return;
      }

      if (req.method === "GET") {
        await serveWeb(res, pathname);
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad_request";
      sendJson(res, 400, { error: message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, () => {
    console.log("LOCD Engine API listening on port " + port);
  });
}
