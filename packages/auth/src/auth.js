import { timingSafeEqual } from "node:crypto";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";

const ALL_SCOPES = new Set(["read", "decide", "telemetry", "targets", "execute", "admin"]);

function safeEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("auth key scopes must be a non-empty array");
  }
  const unique = [...new Set(scopes.map(String))];
  for (const scope of unique) {
    if (!ALL_SCOPES.has(scope)) throw new Error("unknown auth scope: " + scope);
  }
  if (unique.includes("admin")) return ["admin"];
  return unique;
}

function extractSuppliedKey(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return String(bearer || req.headers["x-locd-api-key"] || "");
}

export function createScopedAuthorizer({
  legacyApiKey = null,
  legacyTenantId = "default",
  keys = []
} = {}) {
  if (legacyApiKey != null && typeof legacyApiKey !== "string") {
    throw new Error("legacyApiKey must be a string");
  }
  if (!Array.isArray(keys)) throw new Error("auth keys must be an array");

  const entries = [];
  if (legacyApiKey) {
    entries.push({
      id: "legacy",
      secret: legacyApiKey,
      scopes: ["admin"],
      tenantId: normalizeTenantId(legacyTenantId)
    });
  }

  const ids = new Set();
  for (const entry of keys) {
    if (!entry || typeof entry !== "object") throw new Error("auth key entry must be an object");
    if (!entry.id || typeof entry.id !== "string") throw new Error("auth key id is required");
    if (ids.has(entry.id)) throw new Error("duplicate auth key id: " + entry.id);
    ids.add(entry.id);

    const secret = String(entry.secret || "");
    if (!secret.trim()) throw new Error("auth key secret is required: " + entry.id);

    if (entries.some(existing => safeEqual(existing.secret, secret))) {
      throw new Error("duplicate auth key secret is not allowed: " + entry.id);
    }

    entries.push({
      id: entry.id,
      secret,
      scopes: normalizeScopes(entry.scopes),
      tenantId: normalizeTenantId(entry.tenantId)
    });
  }

  function authorize(req, requiredScope = null) {
    if (entries.length === 0) {
      return {
        ok: true,
        keyId: null,
        scopes: ["admin"],
        tenantId: normalizeTenantId(legacyTenantId)
      };
    }

    const supplied = extractSuppliedKey(req);
    let matched = null;

    for (const entry of entries) {
      if (safeEqual(supplied, entry.secret)) {
        matched = entry;
      }
    }

    if (!matched) {
      return { ok: false, reason: "unauthorized" };
    }

    if (!requiredScope || matched.scopes.includes("admin") || matched.scopes.includes(requiredScope)) {
      return {
        ok: true,
        keyId: matched.id,
        scopes: [...matched.scopes],
        tenantId: matched.tenantId
      };
    }

    return {
      ok: false,
      reason: "forbidden_scope",
      keyId: matched.id,
      scopes: [...matched.scopes],
      tenantId: matched.tenantId
    };
  }

  return {
    enabled: entries.length > 0,
    authorize,
    listKeyIds() {
      return entries.map(entry => entry.id);
    }
  };
}

export function loadScopedAuthFromEnv({
  legacyApiKey = process.env.LOCD_API_KEY?.trim() || null,
  legacyTenantId = process.env.LOCD_LEGACY_TENANT_ID?.trim() || "default",
  raw = process.env.LOCD_API_KEYS_JSON || "",
  env = process.env
} = {}) {
  if (!raw.trim()) {
    return createScopedAuthorizer({ legacyApiKey, legacyTenantId });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LOCD_API_KEYS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("LOCD_API_KEYS_JSON must be an array");
  }

  const keys = parsed.map(entry => {
    if (!entry || typeof entry !== "object") {
      throw new Error("LOCD_API_KEYS_JSON entries must be objects");
    }
    const secretEnv = String(entry.secretEnv || "");
    if (!secretEnv) throw new Error("auth key secretEnv is required: " + String(entry.id || "unknown"));
    if (!(secretEnv in env)) {
      throw new Error("auth key environment variable is not set: " + secretEnv);
    }
    const secret = String(env[secretEnv] ?? "");
    if (!secret.trim()) {
      throw new Error("auth key environment variable is empty: " + secretEnv);
    }
    return {
      id: entry.id,
      secret,
      tenantId: entry.tenantId,
      scopes: entry.scopes
    };
  });

  return createScopedAuthorizer({ legacyApiKey, legacyTenantId, keys });
}
