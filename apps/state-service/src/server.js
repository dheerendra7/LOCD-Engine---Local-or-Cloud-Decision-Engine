import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createSQLiteStateStores } from "../../../packages/sqlite/src/index.js";

function safeEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req, apiKey) {
  if (!apiKey) return true;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const headerKey = String(req.headers["x-locd-state-api-key"] || "");
  return safeEqual(bearer || headerKey, apiKey);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("request body too large");
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("invalid JSON");
  }
}

function decodeKey(pathname, prefix, suffix = "") {
  return decodeURIComponent(pathname.slice(prefix.length, suffix ? -suffix.length : undefined));
}

export function createStateServiceServer({
  stores,
  apiKey = process.env.LOCD_STATE_SERVICE_API_KEY?.trim() || null,
  maxBodyBytes = Number(process.env.LOCD_STATE_SERVICE_MAX_BODY_BYTES || 1_000_000)
} = {}) {
  if (!stores?.telemetry || !stores?.coordination) {
    throw new Error("state service stores are required");
  }
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be >= 1");
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          service: "locd-state-service",
          storage: "sqlite"
        });
        return;
      }

      if (!pathname.startsWith("/v1/state/")) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      if (!authorized(req, apiKey)) {
        sendJson(res, 401, { error: "unauthorized" }, {
          "www-authenticate": "Bearer"
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/state/decisions") {
        const event = await readBody(req, maxBodyBytes);
        const saved = stores.telemetry.record(event);
        sendJson(res, 201, saved);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/outcomes/")) {
        const id = decodeKey(pathname, "/v1/state/outcomes/");
        const patch = await readBody(req, maxBodyBytes);
        const saved = stores.telemetry.recordOutcome(id, patch);
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/state/decisions") {
        const limit = url.searchParams.get("limit") || "50";
        sendJson(res, 200, {
          decisions: stores.telemetry.list({ limit })
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/state/metrics") {
        sendJson(res, 200, stores.telemetry.summary());
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/state/kv/")) {
        const key = decodeKey(pathname, "/v1/state/kv/");
        if (key.endsWith("/set-if-absent")) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const value = await stores.coordination.get(key);
        sendJson(res, 200, { value });
        return;
      }

      if (req.method === "PUT" && pathname.startsWith("/v1/state/kv/")) {
        const key = decodeKey(pathname, "/v1/state/kv/");
        const body = await readBody(req, maxBodyBytes);
        await stores.coordination.set(key, body.value, { ttlMs: body.ttlMs ?? null });
        sendJson(res, 200, { stored: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/kv/") && pathname.endsWith("/set-if-absent")) {
        const key = decodeKey(pathname, "/v1/state/kv/", "/set-if-absent");
        const body = await readBody(req, maxBodyBytes);
        const claimed = await stores.coordination.setIfAbsent(
          key,
          body.value,
          { ttlMs: body.ttlMs ?? null }
        );
        sendJson(res, 200, { claimed });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/kv/") && pathname.endsWith("/incr")) {
        const key = decodeKey(pathname, "/v1/state/kv/", "/incr");
        const body = await readBody(req, maxBodyBytes);
        const value = await stores.coordination.incr(
          key,
          { ttlMs: body.ttlMs ?? null }
        );
        sendJson(res, 200, { value });
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/v1/state/kv/")) {
        const key = decodeKey(pathname, "/v1/state/kv/");
        const deleted = await stores.coordination.delete(key);
        sendJson(res, 200, { deleted });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/state/telemetry/clear") {
        stores.telemetry.clear();
        sendJson(res, 200, { cleared: "telemetry" });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/state/coordination/clear") {
        await stores.coordination.clear();
        sendJson(res, 200, { cleared: "coordination" });
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad_request";
      const status =
        message === "request body too large" ? 413 :
        message === "decision_not_found" ? 404 :
        message === "invalid JSON" ? 400 :
        400;
      sendJson(res, status, { error: message });
    }
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith("/apps/state-service/src/server.js");

if (isMain) {
  const filePath = process.env.LOCD_STATE_DB_FILE?.trim();
  if (!filePath) {
    throw new Error("LOCD_STATE_DB_FILE is required for the state service");
  }

  const stores = createSQLiteStateStores({
    filePath,
    maxEntries: Number(process.env.LOCD_STATE_TELEMETRY_MAX || 5000)
  });

  const port = Number(process.env.LOCD_STATE_SERVICE_PORT || 8890);
  const server = createStateServiceServer({ stores });

  server.listen(port, "0.0.0.0", () => {
    console.log("LOCD State Service listening on 0.0.0.0:" + port);
  });

  const close = () => {
    server.close(() => stores.close());
  };

  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
