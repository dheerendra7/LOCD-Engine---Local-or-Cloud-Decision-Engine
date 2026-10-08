import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createSQLiteStateStores } from "../../../packages/sqlite/src/index.js";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";
import { createLogger, createRequestId } from "../../../packages/observability/src/index.js";

function safeEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req, apiKey) {
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

export async function readBody(req, maxBytes = 1_000_000) {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be >= 1");
  }

  const declaredLength = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("request body too large");
  }

  let body = "";
  let receivedBytes = 0;

  for await (const chunk of req) {
    const text = typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk).toString("utf8");
    receivedBytes += Buffer.byteLength(text, "utf8");
    if (receivedBytes > maxBytes) {
      throw new Error("request body too large");
    }
    body += text;
  }

  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("invalid JSON");
  }
}

function assertJsonContentType(req) {
  const contentType = String(req.headers?.["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (!contentType || (contentType !== "application/json" && !contentType.endsWith("+json"))) {
    throw new Error("unsupported_media_type");
  }
}

async function readJsonBody(req, maxBytes = 1_000_000) {
  assertJsonContentType(req);
  return readBody(req, maxBytes);
}

function decodeKey(pathname, prefix, suffix = "") {
  return decodeURIComponent(pathname.slice(prefix.length, suffix ? -suffix.length : undefined));
}

function requestTenantId(req) {
  return normalizeTenantId(req.headers["x-locd-tenant-id"]);
}

export function createStateServiceServer({
  stores,
  apiKey = process.env.LOCD_STATE_SERVICE_API_KEY?.trim() || null,
  maxBodyBytes = Number(process.env.LOCD_STATE_SERVICE_MAX_BODY_BYTES || 1_000_000),
  logger = createLogger({ level: process.env.LOCD_LOG_LEVEL || "info" }),
  requestTimeoutMs = Number(process.env.LOCD_STATE_SERVICE_REQUEST_TIMEOUT_MS || 30_000),
  headersTimeoutMs = Number(process.env.LOCD_STATE_SERVICE_HEADERS_TIMEOUT_MS || 10_000),
  keepAliveTimeoutMs = Number(process.env.LOCD_STATE_SERVICE_KEEP_ALIVE_TIMEOUT_MS || 5_000),
  maxRequestsPerSocket = Number(process.env.LOCD_STATE_SERVICE_MAX_REQUESTS_PER_SOCKET || 0)
} = {}) {
  if (!stores?.telemetry || !stores?.coordination || !stores?.policies) {
    throw new Error("state service telemetry, coordination and policy stores are required");
  }
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("state service apiKey is required");
  }
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be >= 1");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("requestTimeoutMs must be >= 1");
  }
  if (!Number.isFinite(headersTimeoutMs) || headersTimeoutMs < 1) {
    throw new Error("headersTimeoutMs must be >= 1");
  }
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error("headersTimeoutMs must be <= requestTimeoutMs");
  }
  if (!Number.isFinite(keepAliveTimeoutMs) || keepAliveTimeoutMs < 0) {
    throw new Error("keepAliveTimeoutMs must be >= 0");
  }
  if (!Number.isInteger(maxRequestsPerSocket) || maxRequestsPerSocket < 0) {
    throw new Error("maxRequestsPerSocket must be a non-negative integer");
  }

  const server = http.createServer(async (req, res) => {
    const requestId = createRequestId(req.headers["x-request-id"]);
    res.setHeader("x-request-id", requestId);

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
        const tenantId = requestTenantId(req);
        const event = await readJsonBody(req, maxBodyBytes);
        const saved = stores.telemetry.record({ ...event, tenantId });
        sendJson(res, 201, saved);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/outcomes/")) {
        const tenantId = requestTenantId(req);
        const id = decodeKey(pathname, "/v1/state/outcomes/");
        const patch = await readJsonBody(req, maxBodyBytes);
        const saved = stores.telemetry.recordOutcome(id, patch, { tenantId });
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/state/decisions") {
        const tenantId = requestTenantId(req);
        const limit = url.searchParams.get("limit") || "50";
        sendJson(res, 200, {
          tenantId,
          decisions: stores.telemetry.list({ limit, tenantId })
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/state/metrics") {
        const tenantId = requestTenantId(req);
        sendJson(res, 200, stores.telemetry.summary({ tenantId }));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/state/policies") {
        const tenantId = requestTenantId(req);
        sendJson(res, 200, {
          tenantId,
          policies: await stores.policies.list(tenantId)
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/state/policies/") &&
          pathname.endsWith("/history")) {
        const tenantId = requestTenantId(req);
        const id = decodeKey(pathname, "/v1/state/policies/", "/history");
        const history = await stores.policies.history(tenantId, id);
        if (!history) {
          sendJson(res, 404, { error: "policy_not_found" });
          return;
        }
        sendJson(res, 200, history);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/state/policies/")) {
        const tenantId = requestTenantId(req);
        const id = decodeKey(pathname, "/v1/state/policies/");
        const policy = await stores.policies.get(tenantId, id);
        if (!policy) {
          sendJson(res, 404, { error: "policy_not_found" });
          return;
        }
        sendJson(res, 200, policy);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/state/policies") {
        const tenantId = requestTenantId(req);
        const body = await readJsonBody(req, maxBodyBytes);
        if (!body.policy || typeof body.policy !== "object") {
          sendJson(res, 400, { error: "policy is required" });
          return;
        }
        const saved = await stores.policies.upsert(tenantId, body.policy, {
          updatedBy: body.updatedBy ?? null
        });
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/policies/") &&
          pathname.endsWith("/rollback")) {
        const tenantId = requestTenantId(req);
        const id = decodeKey(pathname, "/v1/state/policies/", "/rollback");
        const body = await readJsonBody(req, maxBodyBytes);
        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1) {
          sendJson(res, 400, { error: "policy version must be a positive integer" });
          return;
        }
        const saved = await stores.policies.rollback(tenantId, id, version, {
          updatedBy: body.updatedBy ?? null
        });
        if (!saved) {
          sendJson(res, 404, { error: "policy_version_not_found" });
          return;
        }
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/v1/state/policies/")) {
        const tenantId = requestTenantId(req);
        const id = decodeKey(pathname, "/v1/state/policies/");
        const removed = await stores.policies.remove(tenantId, id);
        if (!removed) {
          sendJson(res, 404, { error: "policy_not_found" });
          return;
        }
        sendJson(res, 200, { removed: id });
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
        const body = await readJsonBody(req, maxBodyBytes);
        await stores.coordination.set(key, body.value, { ttlMs: body.ttlMs ?? null });
        sendJson(res, 200, { stored: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/kv/") && pathname.endsWith("/set-if-absent")) {
        const key = decodeKey(pathname, "/v1/state/kv/", "/set-if-absent");
        const body = await readJsonBody(req, maxBodyBytes);
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
        const body = await readJsonBody(req, maxBodyBytes);
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
        const tenantId = requestTenantId(req);
        stores.telemetry.clear({ tenantId });
        sendJson(res, 200, { cleared: "telemetry", tenantId });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/state/coordination/clear") {
        await stores.coordination.clear();
        sendJson(res, 200, { cleared: "coordination" });
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_server_error";
      if (message === "request body too large") {
        sendJson(res, 413, { error: message });
        return;
      }
      if (message === "decision_not_found") {
        sendJson(res, 404, { error: message });
        return;
      }
      if (message === "unsupported_media_type") {
        sendJson(res, 415, { error: message });
        return;
      }
      if (message === "invalid JSON") {
        sendJson(res, 400, { error: message });
        return;
      }

      logger.error({
        event: "state_request_error",
        requestId,
        method: req.method,
        path: req.url,
        errorClass: error instanceof Error ? error.constructor.name : "unknown_error",
        errorCode: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : null
      });
      sendJson(res, 500, {
        error: "internal_server_error",
        requestId
      });
    }
  });

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.maxRequestsPerSocket = maxRequestsPerSocket;

  return server;
}

export function createGracefulShutdown({
  server,
  stores = null,
  logger = createLogger({ level: "info" }),
  shutdownTimeoutMs = Number(process.env.LOCD_SHUTDOWN_TIMEOUT_MS || 10_000)
} = {}) {
  if (!server || typeof server.close !== "function") {
    throw new Error("server is required");
  }
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw new Error("shutdownTimeoutMs must be >= 1");
  }

  let shuttingDown = false;

  return signal => new Promise(resolve => {
    if (shuttingDown) {
      resolve(false);
      return;
    }

    shuttingDown = true;
    let forced = false;
    let settled = false;
    let timer = null;

    const finish = async () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      try {
        if (stores && typeof stores.close === "function") stores.close();
        logger.info({ event: "shutdown_complete", signal, forced });
        resolve(true);
      } catch (error) {
        logger.error({
          event: "shutdown_close_error",
          errorClass: error instanceof Error ? error.message : "shutdown_close_error"
        });
        resolve(false);
      }
    };

    logger.info({ event: "shutdown_started", signal });

    timer = setTimeout(() => {
      if (settled) return;
      forced = true;
      logger.warn({
        event: "shutdown_timeout",
        signal,
        timeoutMs: shutdownTimeoutMs
      });

      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      } else {
        logger.error({ event: "shutdown_force_close_unavailable", signal });
        void finish();
      }
    }, shutdownTimeoutMs);

    server.close(() => {
      void finish();
    });
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

  const shutdown = createGracefulShutdown({
    server,
    stores,
    shutdownTimeoutMs: Number(process.env.LOCD_SHUTDOWN_TIMEOUT_MS || 10_000)
  });

  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
}
