import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createSQLiteStateStores } from "../../../packages/sqlite/src/index.js";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";

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

function requestTenantId(req) {
  return normalizeTenantId(req.headers["x-locd-tenant-id"]);
}

export function createStateServiceServer({
  stores,
  apiKey = process.env.LOCD_STATE_SERVICE_API_KEY?.trim() || null,
  maxBodyBytes = Number(process.env.LOCD_STATE_SERVICE_MAX_BODY_BYTES || 1_000_000)
} = {}) {
  if (!stores?.telemetry || !stores?.coordination || !stores?.policies) {
    throw new Error("state service telemetry, coordination and policy stores are required");
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
        const tenantId = requestTenantId(req);
        const event = await readBody(req, maxBodyBytes);
        const saved = stores.telemetry.record({ ...event, tenantId });
        sendJson(res, 201, saved);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/state/outcomes/")) {
        const tenantId = requestTenantId(req);
        const id = decodeKey(pathname, "/v1/state/outcomes/");
        const patch = await readBody(req, maxBodyBytes);
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
        const body = await readBody(req, maxBodyBytes);
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
        const body = await readBody(req, maxBodyBytes);
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
