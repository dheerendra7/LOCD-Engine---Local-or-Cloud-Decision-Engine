import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

export const SCOPES = Object.freeze([
  "read",
  "decide",
  "targets:write",
  "telemetry:write",
  "execute",
  "admin"
]);

const SCOPE_SET = new Set(SCOPES);

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeScopes(scopes, field = "scopes") {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(field + " must be a non-empty array");
  }

  const values = [...new Set(scopes.map(String))];
  for (const scope of values) {
    if (!SCOPE_SET.has(scope)) {
      throw new Error("unknown auth scope: " + scope);
    }
  }
  return values;
}

function normalizeKeyEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("auth key entry must be an object");
  }
  if (!entry.id || typeof entry.id !== "string") {
    throw new Error("auth key id is required");
  }
  if (!entry.keyEnv || typeof entry.keyEnv !== "string") {
    throw new Error("auth key keyEnv is required");
  }

  return {
    id: String(entry.id),
    keyEnv: String(entry.keyEnv),
    scopes: normalizeScopes(entry.scopes)
  };
}

export function createAuthorizer({
  legacyKey = null,
  keyEntries = [],
  env = process.env,
  allowAnonymous = true
} = {}) {
  if (!Array.isArray(keyEntries)) {
    throw new Error("keyEntries must be an array");
  }

  const entries = keyEntries.map(normalizeKeyEntry);
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error("duplicate auth key id: " + entry.id);
    ids.add(entry.id);
  }

  const resolvedKeys = entries.map(entry => {
    const value = String(env[entry.keyEnv] ?? "");
    if (!value.trim()) {
      throw new Error("auth key environment variable is empty: " + entry.keyEnv);
    }
    return {
      ...entry,
      value
    };
  });

  const configured = Boolean(legacyKey) || resolvedKeys.length > 0;

  function extractCredential(req) {
    const authorization = String(req.headers.authorization || "");
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const headerKey = String(req.headers["x-locd-api-key"] || "").trim();
    return bearer || headerKey || null;
  }

  function authenticate(req) {
    const supplied = extractCredential(req);

    if (legacyKey && supplied && safeEqual(supplied, legacyKey)) {
      return {
        authenticated: true,
        principal: {
          id: "legacy",
          scopes: ["admin"]
        }
      };
    }

    for (const entry of resolvedKeys) {
      if (supplied && safeEqual(supplied, entry.value)) {
        return {
          authenticated: true,
          principal: {
            id: entry.id,
            scopes: [...entry.scopes]
          }
        };
      }
    }

    if (!configured && allowAnonymous) {
      return {
        authenticated: false,
        principal: {
          id: "anonymous",
          scopes: []
        }
      };
    }

    return {
      authenticated: false,
      principal: null
    };
  }

  function authorize(principal, scope) {
    if (principal?.scopes?.includes("admin")) return true;
    if (scope === "execute" && !principal?.authenticated) return false;
    if (!configured && allowAnonymous) return true;
    return Boolean(principal?.scopes?.includes(scope));
  }

  return {
    configured,
    authenticate,
    authorize,
    listKeyMetadata() {
      return resolvedKeys.map(({ value, ...entry }) => ({ ...entry }));
    }
  };
}

export async function loadAuthorizerFromFile({
  filePath,
  legacyKey = null,
  env = process.env,
  allowAnonymous = false
} = {}) {
  if (!filePath) {
    return createAuthorizer({ legacyKey, env, allowAnonymous });
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("auth config file not found: " + filePath);
    }
    if (error instanceof SyntaxError) {
      throw new Error("auth config file is invalid JSON");
    }
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.keys)) {
    throw new Error("auth config file must contain a keys array");
  }

  return createAuthorizer({
    legacyKey,
    keyEntries: parsed.keys,
    env,
    allowAnonymous
  });
}

export function requiredScopeForRequest(method, pathname) {
  if (
    method === "GET" &&
    ["/v1/policies", "/v1/targets", "/v1/decisions", "/v1/metrics"].includes(pathname)
  ) {
    return "read";
  }

  if (method === "POST" && (
    pathname === "/v1/decide" ||
    pathname === "/v1/hybrid-plan"
  )) {
    return "decide";
  }

  if (method === "POST" && pathname === "/v1/outcomes") {
    return "telemetry:write";
  }

  if (method === "POST" && pathname === "/v1/execute") {
    return "read";
  }

  if (method === "POST" && pathname === "/v1/targets") {
    return "targets:write";
  }

  if (method === "POST" && pathname.startsWith("/v1/targets/") &&
      (pathname.endsWith("/probe") || pathname.endsWith("/heartbeat"))) {
    return "targets:write";
  }

  if (method === "DELETE" && pathname.startsWith("/v1/targets/")) {
    return "targets:write";
  }

  return "admin";
}
