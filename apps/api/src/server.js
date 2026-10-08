import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, simulatePolicy } from "../../../packages/core/src/index.js";
import { createDecisionStore, createFileDecisionStore } from "../../../packages/telemetry/src/index.js";
import { listPolicyProfiles } from "../../../packages/policy/src/index.js";
import { createPolicyStore, createFilePolicyStore } from "../../../packages/policy-store/src/index.js";
import { createTenantTargetRegistry, tenantFromAuthContext, scopeKey } from "../../../packages/tenancy/src/index.js";
import { planHybridExecution } from "../../../packages/planner/src/index.js";
import { createLogger, createRequestId } from "../../../packages/observability/src/index.js";
import { createCalibrator } from "../../../packages/calibration/src/index.js";
import { createIdempotencyStore } from "../../../packages/runtime/src/index.js";
import { createRateLimiter, getClientKey } from "./rate-limit.js";
import { createCoordinatedFixedWindowRateLimiter, createCoordinatedIdempotencyStore } from "../../../packages/coordination/src/index.js";
import { createProbeScheduler } from "../../../packages/probing/src/index.js";
import {
  createDryRunExecutionAdapter,
  createExecutionRegistry,
  executePlan
} from "../../../packages/execution/src/index.js";
import { loadProvidersFromFile } from "../../../packages/providers/src/index.js";
import { loadScopedAuthFromEnv } from "../../../packages/auth/src/index.js";
import { createSQLiteStateStores } from "../../../packages/sqlite/src/index.js";
import { createHTTPCoordinationStore } from "../../../packages/state-client/src/index.js";
import {
  assertDecisionStore,
  assertCoordinationStore,
  describeStateBackend
} from "../../../packages/state-contract/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web");


function validateProductionSafety({
  strict = false,
  authEnabled,
  rateLimitEnabled,
  decisionStore,
  policyStore
} = {}) {
  if (!strict) return;

  const failures = [];
  if (!authEnabled) failures.push("authentication is disabled");
  if (!rateLimitEnabled) failures.push("rate limiting is disabled");
  if (decisionStore?.capabilities?.durable !== true) {
    failures.push("telemetry store is not durable");
  }
  if (policyStore?.capabilities?.durable !== true) {
    failures.push("policy store is not durable");
  }

  if (failures.length) {
    throw new Error("production safety requirements not met: " + failures.join("; "));
  }
}

function requiredScope(method, pathname) {
  if (method === "GET") return "read";
  if (method === "POST" && pathname === "/v1/decide") return "decide";
  if (method === "POST" && pathname === "/v1/hybrid-plan") return "decide";
  if (method === "POST" && pathname === "/v1/policies/simulate") return "decide";
  if (method === "POST" && pathname === "/v1/outcomes") return "telemetry";
  if (method === "POST" && pathname === "/v1/execute") return "execute";
  if (method === "POST" && pathname === "/v1/targets") return "targets";
  if (method === "POST" && pathname.startsWith("/v1/targets/")) return "targets";
  if (method === "DELETE" && pathname.startsWith("/v1/targets/")) return "targets";
  return "admin";
}

const SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer"
});

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
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
      ...SECURITY_HEADERS,
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self';",
      "content-type": type + "; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

export async function createConfiguredExecutionRegistry({
  targetRegistry
} = {}) {
  if (!targetRegistry) throw new Error("targetRegistry is required");

  const executionRegistry = createExecutionRegistry(
    typeof targetRegistry.listExecutionAdapters === "function"
      ? targetRegistry.listExecutionAdapters()
      : []
  );

  const snapshots = await targetRegistry.list();
  for (const target of snapshots) {
    if (!executionRegistry.has(target.id)) {
      executionRegistry.register({
        ...createDryRunExecutionAdapter({
          id: "dry-run:" + target.id,
          targetId: target.id
        }),
        dryRunOnly: true
      });
    }
  }

  return executionRegistry;
}

export function createGracefulShutdown({
  server,
  probeScheduler = null,
  logger = createLogger({ level: "info" }),
  onClosed = null,
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
        if (typeof onClosed === "function") await onClosed();
        logger.info({
          event: "shutdown_complete",
          signal,
          forced
        });
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

    if (probeScheduler) probeScheduler.stop();

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
        logger.error({
          event: "shutdown_force_close_unavailable",
          signal
        });
        void finish();
      }
    }, shutdownTimeoutMs);

    server.close(() => {
      void finish();
    });
  });
}

export function createConfiguredProbeScheduler({
  registry,
  intervalMs = Number(process.env.LOCD_PROBE_INTERVAL_MS || 0),
  maxConcurrent = Number(process.env.LOCD_PROBE_MAX_CONCURRENT || 4),
  logger = createLogger({ level: process.env.LOCD_LOG_LEVEL || "info" })
} = {}) {
  if (!registry) throw new Error("registry is required");
  if (intervalMs <= 0) return null;

  if (typeof registry.forTenant === "function" && typeof registry.listTenantIds === "function") {
    const schedulers = new Map();

    function syncSchedulers() {
      for (const tenantId of registry.listTenantIds()) {
        if (schedulers.has(tenantId)) continue;
        schedulers.set(tenantId, createProbeScheduler({
          registry: registry.forTenant(tenantId),
          intervalMs,
          maxConcurrent,
          onResult: result => {
            logger.info({
              event: "target_probe",
              tenantId,
              targetId: result.targetId,
              status: result.status,
              errorClass: result.errorClass || null,
              available: result.snapshot?.available,
              health: result.snapshot?.health,
              latencyMs: result.snapshot?.estimatedLatencyMs
            });
          }
        }));
      }
    }

    let timer = null;
    let running = false;

    const runAll = async () => {
      syncSchedulers();
      return (await Promise.all(
        [...schedulers.values()].map(scheduler => scheduler.runOnce())
      )).flat();
    };

    return {
      runOnce: runAll,
      start() {
        if (running) return false;
        running = true;
        syncSchedulers();
        timer = setInterval(() => {
          runAll().catch(() => {});
        }, intervalMs);
        timer?.unref?.();
        return true;
      },
      stop() {
        if (!running) return false;
        running = false;
        clearInterval(timer);
        timer = null;
        return true;
      },
      isRunning() {
        return running;
      },
      inFlightCount() {
        return [...schedulers.values()].reduce(
          (total, scheduler) => total + scheduler.inFlightCount(),
          0
        );
      }
    };
  }

  return createProbeScheduler({
    registry,
    intervalMs,
    maxConcurrent,
    onResult: result => {
      logger.info({
        event: "target_probe",
        targetId: result.targetId,
        status: result.status,
        errorClass: result.errorClass || null,
        available: result.snapshot?.available,
        health: result.snapshot?.health,
        latencyMs: result.snapshot?.estimatedLatencyMs
      });
    }
  });
}

export async function createConfiguredTargetRegistry({
  targetFile = process.env.LOCD_TARGETS_FILE?.trim() || null,
  providerFile = process.env.LOCD_PROVIDERS_FILE?.trim() || null,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const targetRegistry = createTenantTargetRegistry();

  if (targetFile) {
    await targetRegistry.loadFromFile(targetFile);
  }

  if (providerFile) {
    const providers = await loadProvidersFromFile(providerFile, env, fetchImpl);
    for (const provider of providers) {
      const registry = targetRegistry.forTenant(provider.tenantId);
      if (registry.has(provider.targetId)) {
        registry.remove(provider.targetId);
      }
      registry.register(provider);
    }
  }

  return targetRegistry;
}

export async function checkReadiness({
  decisionStore,
  targetRegistry,
  policyStore,
  coordinationStore = null
} = {}) {
  const checks = {};

  try {
    if (!decisionStore || typeof decisionStore.summary !== "function") {
      throw new Error("decision_store_unavailable");
    }
    await decisionStore.summary({ tenantId: "default" });
    checks.telemetry = "ok";
  } catch {
    checks.telemetry = "failed";
  }

  try {
    if (!targetRegistry || typeof targetRegistry.forTenant !== "function") {
      throw new Error("target_registry_unavailable");
    }
    const registry = targetRegistry.forTenant("default");
    if (!registry || typeof registry.list !== "function") {
      throw new Error("tenant_target_registry_unavailable");
    }
    await registry.list();
    checks.targets = "ok";
  } catch {
    checks.targets = "failed";
  }

  try {
    if (!policyStore || typeof policyStore.list !== "function") {
      throw new Error("policy_store_unavailable");
    }
    await policyStore.list("default");
    checks.policies = "ok";
  } catch {
    checks.policies = "failed";
  }

  if (coordinationStore) {
    try {
      if (typeof coordinationStore.get !== "function") {
        throw new Error("coordination_store_unavailable");
      }
      await coordinationStore.get("locd:readiness:probe");
      checks.coordination = "ok";
    } catch {
      checks.coordination = "failed";
    }
  } else {
    checks.coordination = "not_configured";
  }

  const failed = Object.values(checks).some(value => value === "failed");
  return {
    ready: !failed,
    checks
  };
}

export function createServer({
  apiKey = process.env.LOCD_API_KEY?.trim() || null,
  decisionStore = createDecisionStore({ maxEntries: 1000 }),
  targetRegistry = createTenantTargetRegistry(),
  targetFile = process.env.LOCD_TARGETS_FILE?.trim() || null,
  policyStore = createPolicyStore(),
  idempotencyStore = null,
  coordinationStore = null,
  maxBodyBytes = Number(process.env.LOCD_MAX_BODY_BYTES || 1_000_000),
  rateLimiter = null,
  rateLimitMaxRequests = Number(process.env.LOCD_RATE_LIMIT_RPM || 0),
  rateLimitWindowMs = 60_000,
  authFailureRateLimiter = null,
  authFailureRateLimitMaxRequests = Number(process.env.LOCD_AUTH_FAILURE_RPM || 30),
  trustProxy = process.env.LOCD_TRUST_PROXY === "true",
  idempotencyLockTtlMs = Number(process.env.LOCD_IDEMPOTENCY_LOCK_TTL_MS || 30_000),
  logger = createLogger({
    level: process.env.LOCD_LOG_LEVEL || "info"
  }),
  executionRegistry = null,
  executionEnabled = process.env.LOCD_EXECUTION_ENABLED === "true",
  authorizer = null,
  probeScheduler = null,
  serviceVersion = "0.1.0",
  calibrator = createCalibrator(),
  calibrationEnabled = process.env.LOCD_CALIBRATION_ENABLED === "true",
  coordinationBackend = null,
  telemetryBackend = null,
  policyBackend = null,
  requestTimeoutMs = Number(process.env.LOCD_REQUEST_TIMEOUT_MS || 30_000),
  headersTimeoutMs = Number(process.env.LOCD_HEADERS_TIMEOUT_MS || 10_000),
  keepAliveTimeoutMs = Number(process.env.LOCD_KEEP_ALIVE_TIMEOUT_MS || 5_000),
  maxRequestsPerSocket = Number(process.env.LOCD_MAX_REQUESTS_PER_SOCKET || 0),
  productionStrict = process.env.LOCD_PRODUCTION_STRICT === "true"
} = {}) {
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be >= 1");
  }
  if (!Number.isFinite(idempotencyLockTtlMs) || idempotencyLockTtlMs < 1) {
    throw new Error("idempotencyLockTtlMs must be >= 1");
  }
  if (!Number.isFinite(authFailureRateLimitMaxRequests) || authFailureRateLimitMaxRequests < 0) {
    throw new Error("authFailureRateLimitMaxRequests must be >= 0");
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

  assertDecisionStore(decisionStore);
  if (coordinationStore) assertCoordinationStore(coordinationStore);
  if (!policyStore || typeof policyStore.list !== "function" ||
      typeof policyStore.get !== "function" ||
      typeof policyStore.history !== "function" ||
      typeof policyStore.upsert !== "function" ||
      typeof policyStore.remove !== "function") {
    throw new Error("policyStore must implement list, get, history, upsert and remove");
  }
  if (!calibrator || typeof calibrator.apply !== "function" ||
      typeof calibrator.observe !== "function" ||
      typeof calibrator.hydrate !== "function") {
    throw new Error("calibrator must implement apply, observe and hydrate");
  }
  const calibrationReady = (async () => {
    try {
      if (calibrator.snapshot().length === 0) {
        const events = await decisionStore.list({ limit: 5000 });
        if (Array.isArray(events)) calibrator.hydrate(events);
      }
    } catch (error) {
      logger.warn({
        event: "calibration_hydrate_failed",
        errorClass: error instanceof Error ? error.message : "calibration_hydrate_failed"
      });
    }
  })();
  const auth = authorizer || loadScopedAuthFromEnv({
    legacyApiKey: apiKey
  });

  const effectiveIdempotencyStore = idempotencyStore ||
    (coordinationStore
      ? createCoordinatedIdempotencyStore({ store: coordinationStore })
      : createIdempotencyStore());

  const effectiveRateLimiter = rateLimiter ||
    (coordinationStore
      ? createCoordinatedFixedWindowRateLimiter({
          store: coordinationStore,
          maxRequests: rateLimitMaxRequests,
          windowMs: rateLimitWindowMs
        })
      : createRateLimiter({
          maxRequests: rateLimitMaxRequests,
          windowMs: rateLimitWindowMs
        }));

  const effectiveAuthFailureRateLimiter = authFailureRateLimiter ||
    (auth.enabled
      ? (coordinationStore
        ? createCoordinatedFixedWindowRateLimiter({
            store: coordinationStore,
            maxRequests: authFailureRateLimitMaxRequests,
            windowMs: rateLimitWindowMs
          })
        : createRateLimiter({
            maxRequests: authFailureRateLimitMaxRequests,
            windowMs: rateLimitWindowMs
          }))
      : createRateLimiter({
          maxRequests: 0,
          windowMs: rateLimitWindowMs
        }));

  validateProductionSafety({
    strict: productionStrict,
    authEnabled: auth.enabled,
    rateLimitEnabled: effectiveRateLimiter.enabled,
    decisionStore,
    policyStore
  });

  const server = http.createServer(async (req, res) => {
    const requestId = createRequestId(req.headers["x-request-id"]);
    const startedAt = process.hrtime.bigint();
    let requestLogWritten = false;
    let pathname = "unknown";

    try {
      const url = new URL(req.url || "/", "http://localhost");
      pathname = url.pathname;

      const originalEnd = res.end.bind(res);
      res.end = (...args) => {
        if (!requestLogWritten) {
          requestLogWritten = true;
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          logger.info({
            event: "http_request",
            requestId,
            method: req.method,
            path: pathname,
            status: res.statusCode,
            durationMs: Number(durationMs.toFixed(3))
          });
        }
        return originalEnd(...args);
      };
      res.setHeader("x-request-id", requestId);

      let authContext = {
        ok: true,
        keyId: null,
        scopes: ["admin"],
        tenantId: "default"
      };

      if (pathname.startsWith("/v1/")) {
        authContext = auth.authorize(req, requiredScope(req.method, pathname));

        if (!authContext.ok) {
          if (authContext.reason === "unauthorized" && effectiveAuthFailureRateLimiter.enabled) {
            const authRate = await effectiveAuthFailureRateLimiter.consume(
              getClientKey(req, { trustProxy })
            );
            if (!authRate.allowed) {
              sendJson(res, 429, { error: "auth_rate_limit_exceeded" }, {
                "retry-after": String(Math.max(
                  1,
                  Math.ceil((authRate.resetAt - Date.now()) / 1000)
                )),
                "www-authenticate": "Bearer"
              });
              return;
            }
          }

          const status = authContext.reason === "forbidden_scope" ? 403 : 401;
          const body = {
            error: authContext.reason === "forbidden_scope"
              ? "insufficient_scope"
              : "unauthorized"
          };
          const headers = status === 401
            ? { "www-authenticate": "Bearer" }
            : {};
          sendJson(res, status, body, headers);
          return;
        }
      }

      const tenantId = tenantFromAuthContext(authContext);
      const requestRegistry = typeof targetRegistry.forTenant === "function"
        ? targetRegistry.forTenant(tenantId)
        : targetRegistry;

      const idempotencyKey = String(req.headers["idempotency-key"] || "").trim() || null;
      const getReplay = async body => {
        if (!idempotencyKey || !["POST", "PUT", "PATCH"].includes(req.method)) return null;
        const scope = scopeKey(tenantId, req.method + " " + pathname);

        if (typeof effectiveIdempotencyStore.claim === "function") {
          const claim = await effectiveIdempotencyStore.claim(
            scope,
            idempotencyKey,
            body,
            idempotencyLockTtlMs
          );

          if (claim.claimed) return null;

          if (claim.reason === "in_progress") {
            return {
              status: 409,
              body: { error: "idempotency_request_in_progress" }
            };
          }

          if (claim.reason === "completed" && claim.response) {
            return {
              ...claim.response,
              replayed: true
            };
          }
        }

        return await effectiveIdempotencyStore.lookup(scope, idempotencyKey, body);
      };
      const rememberResponse = async (body, status, responseBody) => {
        if (!idempotencyKey) return;
        await effectiveIdempotencyStore.remember(
          scopeKey(tenantId, req.method + " " + pathname),
          idempotencyKey,
          body,
          { status, body: responseBody }
        );
      };
      const sendReplay = replay => sendJson(res, replay.status, replay.body, {
        "idempotency-replayed": "true"
      });

      if (pathname.startsWith("/v1/")) {
        const rate = await effectiveRateLimiter.consume(
          scopeKey(tenantId, getClientKey(req, { trustProxy }))
        );
        if (effectiveRateLimiter.enabled) {
          res.setHeader("x-ratelimit-limit", String(rate.limit));
          res.setHeader("x-ratelimit-remaining", String(rate.remaining));
          res.setHeader("x-ratelimit-reset", String(Math.ceil(rate.resetAt / 1000)));
        }

        if (!rate.allowed) {
          sendJson(res, 429, { error: "rate_limit_exceeded" }, {
            "retry-after": String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000)))
          });
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          service: "locd-api",
          version: serviceVersion
        });
        return;
      }

      if (req.method === "GET" && pathname === "/ready") {
        const readiness = await checkReadiness({
          decisionStore,
          targetRegistry,
          policyStore,
          coordinationStore
        });
        sendJson(res, readiness.ready ? 200 : 503, {
          status: readiness.ready ? "ready" : "not_ready",
          service: "locd-api",
          version: serviceVersion,
          checks: readiness.checks
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/execute") {
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        if (!body.plan) {
          sendJson(res, 400, { error: "plan is required" });
          return;
        }

        const mode = body.mode || "dry-run";
        if (!["dry-run", "live"].includes(mode)) {
          sendJson(res, 400, { error: "execution mode must be dry-run or live" });
          return;
        }

        if (mode === "live") {
          if (!executionEnabled) {
            sendJson(res, 403, { error: "live_execution_disabled" });
            return;
          }
          if (!auth.enabled || !authContext.ok || (!authContext.scopes.includes("admin") && !authContext.scopes.includes("execute"))) {
            sendJson(res, 403, { error: "live_execution_requires_execute_scope" });
            return;
          }
          if (!effectiveRateLimiter.enabled) {
            sendJson(res, 503, { error: "live_execution_requires_rate_limit" });
            return;
          }
        }

        const registry = executionRegistry ||
          await createConfiguredExecutionRegistry({ targetRegistry: requestRegistry });

        const responseBody = await executePlan(body.plan, {
          registry,
          mode,
          timeoutMs: body.timeoutMs,
          failFast: body.failFast !== false,
          includeOutputs: body.includeOutputs === true
        });

        await rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/hybrid-plan") {
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }
        const hasRequestTargets = Array.isArray(body.targets) && body.targets.length > 0;
        const request = hasRequestTargets
          ? body
          : { ...body, targets: await requestRegistry.list() };

        if (!request.targets.length) {
          sendJson(res, 503, { error: "no_registered_targets" });
          return;
        }

        const responseBody = planHybridExecution(request);
        await rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/decide") {
        await calibrationReady;
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }
        const hasRequestTargets = Array.isArray(body.targets) && body.targets.length > 0;
        const rawTargets = hasRequestTargets
          ? body.targets
          : await requestRegistry.list();
        const calibratedTargets = calibrationEnabled
          ? calibrator.apply(rawTargets, body.workload?.type || "unknown", tenantId)
          : rawTargets;
        let policy = body.policy || {};
        if (policyStore && policy.profile) {
          const custom = await policyStore.get(tenantId, policy.profile);
          if (custom) {
            policy = {
              ...custom.policy,
              ...policy,
              profile: custom.baseProfile
            };
          }
        }
        const request = { ...body, policy, targets: calibratedTargets };

        if (!request.targets.length) {
          sendJson(res, 503, { error: "no_registered_targets" });
          return;
        }

        const decision = decide(request);

        const selectedTarget = calibratedTargets.find(
          target => String(target?.id) === String(decision.targetId)
        );

        const event = await decisionStore.record({
          decisionVersion: decision.decisionVersion,
          workloadType: body.workload?.type,
          route: decision.route,
          targetId: decision.targetId,
          confidence: decision.confidence,
          estimatedLatencyMs: decision.estimated?.latencyMs,
          estimatedCostUsd: decision.estimated?.costUsd,
          targetUtilization: selectedTarget?.capacity,
          tenantId,
          outcome: "pending"
        });

        const adjustedTargetIds = calibrationEnabled
          ? request.targets
            .filter((target, index) => {
              const original = rawTargets[index];
              return target.estimatedLatencyMs !== original.estimatedLatencyMs ||
                target.estimatedCostUsd !== original.estimatedCostUsd;
            })
            .map(target => target.id)
          : [];

        const responseBody = {
          ...decision,
          decisionId: event.id,
          calibration: {
            enabled: calibrationEnabled,
            workloadType: body.workload?.type || "unknown",
            minSamples: calibrator.config.minSamples,
            adjustedTargetIds
          }
        };
        await rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/outcomes") {
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }
        if (!body.decisionId) {
          sendJson(res, 400, { error: "decisionId is required" });
          return;
        }

        try {
          const event = await decisionStore.recordOutcome(body.decisionId, body, { tenantId });
          calibrator.observe({
            tenantId,
            targetId: event.targetId,
            workloadType: event.workloadType,
            estimatedLatencyMs: event.estimatedLatencyMs,
            actualLatencyMs: event.actualLatencyMs,
            estimatedCostUsd: event.estimatedCostUsd,
            actualCostUsd: event.actualCostUsd,
            outcome: event.outcome,
            utilization: event.targetUtilization
          });
          await rememberResponse(body, 200, event);
          sendJson(res, 200, event);
        } catch (error) {
          if (error instanceof Error && error.message === "decision_not_found") {
            sendJson(res, 404, { error: "decision_not_found" });
            return;
          }
          throw error;
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/policies/simulate") {
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        if (!body.workload?.type) {
          sendJson(res, 400, { error: "workload.type is required" });
          return;
        }

        const resolvePolicyForTenant = async input => {
          const candidate = input && typeof input === "object" ? input : {};
          if (!candidate.profile) return candidate;

          const custom = await policyStore.get(tenantId, candidate.profile);
          if (!custom) return candidate;

          return {
            ...custom.policy,
            ...candidate,
            profile: custom.baseProfile
          };
        };

        const rawTargets = Array.isArray(body.targets) && body.targets.length > 0
          ? body.targets
          : await requestRegistry.list();

        if (!rawTargets.length) {
          sendJson(res, 503, { error: "no_registered_targets" });
          return;
        }

        const result = simulatePolicy({
          workload: body.workload,
          constraints: body.constraints || {},
          targets: rawTargets,
          currentPolicy: await resolvePolicyForTenant(body.currentPolicy || {}),
          candidatePolicy: await resolvePolicyForTenant(body.candidatePolicy || {})
        });

        await rememberResponse(body, 200, result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/policies") {
        const customPolicies = (await policyStore
          .list(tenantId))
          .map(record => ({
            ...record.policy,
            source: "custom",
            version: record.version,
            updatedAt: record.updatedAt
          }));

        const builtIns = listPolicyProfiles().map(profile => ({
          ...profile,
          source: "built-in",
          version: null
        }));

        sendJson(res, 200, { policies: [...builtIns, ...customPolicies] });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/policies/") && pathname.endsWith("/history")) {
        const policyId = decodeURIComponent(
          pathname.slice("/v1/policies/".length, -"/history".length)
        );
        if (!policyId) {
          sendJson(res, 400, { error: "policy id is required" });
          return;
        }

        const history = await policyStore.history(tenantId, policyId);
        if (!history) {
          sendJson(res, 404, { error: "policy_not_found" });
          return;
        }

        sendJson(res, 200, {
          tenantId,
          policyId,
          versions: history.versions
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/policies/")) {
        const policyId = decodeURIComponent(pathname.slice("/v1/policies/".length));
        if (!policyId) {
          sendJson(res, 400, { error: "policy id is required" });
          return;
        }

        const custom = await policyStore.get(tenantId, policyId);
        if (!custom) {
          const builtIn = listPolicyProfiles().find(profile => profile.id === policyId);
          if (!builtIn) {
            sendJson(res, 404, { error: "policy_not_found" });
            return;
          }
          sendJson(res, 200, {
            ...builtIn,
            source: "built-in",
            version: null
          });
          return;
        }

        sendJson(res, 200, {
          ...custom.policy,
          source: "custom",
          version: custom.version,
          updatedAt: custom.updatedAt,
          updatedBy: custom.updatedBy
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/policies") {
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        const policyId = String(body.id || "").trim().toLowerCase();
        const existed = (await policyStore.get(tenantId, policyId)) != null;

        const saved = await policyStore.upsert(tenantId, body, {
          updatedBy: authContext.keyId || "admin"
        });

        const responseBody = {
          ...saved.policy,
          source: "custom",
          version: saved.version,
          updatedAt: saved.updatedAt,
          updatedBy: saved.updatedBy
        };

        const status = existed ? 200 : 201;
        await rememberResponse(body, status, responseBody);
        sendJson(res, status, responseBody);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/policies/") && pathname.endsWith("/rollback")) {
        const policyId = decodeURIComponent(
          pathname.slice("/v1/policies/".length, -"/rollback".length)
        );
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1) {
          sendJson(res, 400, { error: "policy version must be a positive integer" });
          return;
        }

        let saved;
        if (typeof policyStore.rollback === "function") {
          saved = await policyStore.rollback(tenantId, policyId, version, {
            updatedBy: authContext.keyId || "admin"
          });
          if (!saved) {
            sendJson(res, 404, { error: "policy_version_not_found" });
            return;
          }
        } else {
          const history = await policyStore.history(tenantId, policyId);
          const selected = history?.versions?.find(item => item.version === version);
          if (!selected) {
            sendJson(res, 404, { error: "policy_version_not_found" });
            return;
          }
          saved = await policyStore.upsert(tenantId, selected.policy, {
            updatedBy: authContext.keyId || "admin"
          });
          saved = { ...saved, rolledBackFromVersion: version };
        }

        const responseBody = {
          ...saved.policy,
          source: "custom",
          version: saved.version,
          updatedAt: saved.updatedAt,
          updatedBy: saved.updatedBy,
          rolledBackFromVersion: version
        };

        await rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "PUT" && pathname.startsWith("/v1/policies/")) {
        const policyId = decodeURIComponent(pathname.slice("/v1/policies/".length));
        if (!policyId || policyId.endsWith("/history") || policyId.endsWith("/rollback")) {
          sendJson(res, 400, { error: "policy id is required" });
          return;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        const existing = await policyStore.get(tenantId, policyId);
        const payload = { ...body, id: policyId };
        const saved = await policyStore.upsert(tenantId, payload, {
          updatedBy: authContext.keyId || "admin"
        });

        const responseBody = {
          ...saved.policy,
          source: "custom",
          version: saved.version,
          updatedAt: saved.updatedAt,
          updatedBy: saved.updatedBy
        };

        const status = existing ? 200 : 201;
        await rememberResponse(body, status, responseBody);
        sendJson(res, status, responseBody);
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/v1/policies/")) {
        const policyId = decodeURIComponent(pathname.slice("/v1/policies/".length));
        if (!policyId) {
          sendJson(res, 400, { error: "policy id is required" });
          return;
        }

        const removed = await policyStore.remove(tenantId, policyId);
        if (!removed) {
          sendJson(res, 404, { error: "policy_not_found" });
          return;
        }

        sendJson(res, 200, { removed: policyId });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/targets") {
        sendJson(res, 200, { targets: await requestRegistry.list() });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/targets") {
        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        const target = await requestRegistry.register(body);
        if (targetFile) await targetRegistry.saveToFile(targetFile);
        const responseBody = await target.getSnapshot();
        await rememberResponse(body, 201, responseBody);
        sendJson(res, 201, responseBody);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/targets/") && pathname.endsWith("/probe")) {
        const id = decodeURIComponent(
          pathname.slice("/v1/targets/".length, -"/probe".length)
        );
        if (!id) {
          sendJson(res, 400, { error: "target id is required" });
          return;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        try {
          const snapshot = await requestRegistry.probe(id);
          if (targetFile) await targetRegistry.saveToFile(targetFile);
          await rememberResponse(body, 200, snapshot);
          sendJson(res, 200, snapshot);
        } catch (error) {
          if (error instanceof Error && error.message === "target_not_found") {
            sendJson(res, 404, { error: "target_not_found" });
            return;
          }
          if (error instanceof Error && error.message === "target_does_not_support_probe") {
            sendJson(res, 501, { error: "target_does_not_support_probe" });
            return;
          }
          throw error;
        }
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/v1/targets/") && pathname.endsWith("/heartbeat")) {
        const id = decodeURIComponent(
          pathname.slice("/v1/targets/".length, -"/heartbeat".length)
        );
        if (!id) {
          sendJson(res, 400, { error: "target id is required" });
          return;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        const replay = await getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        try {
          const updated = await requestRegistry.heartbeat(id, body);
          if (targetFile) await targetRegistry.saveToFile(targetFile);
          await rememberResponse(body, 200, updated);
          sendJson(res, 200, updated);
        } catch (error) {
          if (error instanceof Error && error.message === "target_not_found") {
            sendJson(res, 404, { error: "target_not_found" });
            return;
          }
          if (error instanceof Error && error.message === "target_does_not_support_heartbeat") {
            sendJson(res, 501, { error: "target_does_not_support_heartbeat" });
            return;
          }
          throw error;
        }
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/v1/targets/")) {
        const id = decodeURIComponent(pathname.slice("/v1/targets/".length));
        if (!id) {
          sendJson(res, 400, { error: "target id is required" });
          return;
        }
        const removed = requestRegistry.remove(id);
        if (!removed) {
          sendJson(res, 404, { error: "target_not_found" });
          return;
        }
        if (targetFile) await targetRegistry.saveToFile(targetFile);
        sendJson(res, 200, { removed: id });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/decisions") {
        const limit = new URL(req.url || "/", "http://localhost").searchParams.get("limit") || "50";
        sendJson(res, 200, {
          decisions: await decisionStore.list({ limit, tenantId })
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/metrics") {
        const summary = await decisionStore.summary({ tenantId });
        delete summary.tenantId;
        sendJson(res, 200, summary);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/calibration") {
        sendJson(res, 200, {
          tenantId,
          enabled: calibrationEnabled,
          config: calibrator.config,
          entries: calibrator.snapshot(tenantId)
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/status") {
        const targets = await requestRegistry.list();
        const probeableTargets = typeof requestRegistry.listProbeable === "function"
          ? await requestRegistry.listProbeable()
          : [];
        const scopedExecutionRegistry = executionRegistry ||
          (typeof targetRegistry.forTenant === "function"
            ? await createConfiguredExecutionRegistry({ targetRegistry: requestRegistry })
            : null);
        const executionAdapters = scopedExecutionRegistry && typeof scopedExecutionRegistry.list === "function"
          ? scopedExecutionRegistry.list()
          : [];

        sendJson(res, 200, {
          service: "locd-api",
          version: serviceVersion,
          status: "ok",
          stateBackend: describeStateBackend({
            telemetry: decisionStore,
            coordination: coordinationStore,
            kind: telemetryBackend || "process-local"
          }),
          capabilities: {
            executionEnabled: Boolean(executionEnabled),
            persistentTargets: Boolean(targetFile),
            persistentTelemetry: Boolean(
              telemetryBackend && telemetryBackend !== "process-local"
            ),
            automaticProbing: Boolean(probeScheduler?.isRunning?.()),
            calibrationEnabled: Boolean(calibrationEnabled),
            sharedCoordination: Boolean(coordinationStore),
            coordinationBackend: coordinationBackend ||
              (coordinationStore ? "shared" : "process-local"),
            telemetryBackend: telemetryBackend || "process-local",
            policyBackend: policyBackend || "process-local",
            rateLimitMode: coordinationStore ? "shared" : "process-local",
            idempotencyMode: coordinationStore ? "shared" : "process-local"
          },
          counts: {
            targets: targets.length,
            customPolicies: (await policyStore.list(tenantId)).length,
            probeableTargets: probeableTargets.length,
            executionAdapters: executionAdapters.length,
            decisions: (await decisionStore.summary({ tenantId })).totalDecisions
          }
        });
        return;
      }

      if (req.method === "GET") {
        await serveWeb(res, pathname);
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_server_error";

      if (message === "idempotency_key_reused") {
        sendJson(res, 409, { error: message });
        return;
      }
      if (message === "idempotency_key_invalid") {
        sendJson(res, 400, { error: message });
        return;
      }
      if (message === "request body too large") {
        sendJson(res, 413, { error: message });
        return;
      }
      if (error && typeof error === "object" && error.code === "STATE_SERVICE_TIMEOUT") {
        sendJson(res, 503, { error: "state_service_unavailable", requestId });
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
        event: "http_request_error",
        requestId,
        method: req.method,
        path: pathname,
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

  // Bound HTTP resources at the server edge to reduce Slowloris and idle-connection risk.
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.maxRequestsPerSocket = maxRequestsPerSocket;

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const targetFile = process.env.LOCD_TARGETS_FILE?.trim() || null;
  const telemetryFile = process.env.LOCD_TELEMETRY_FILE?.trim() || null;
  const stateDbFile = process.env.LOCD_STATE_DB_FILE?.trim() || null;
  const stateServiceUrl = process.env.LOCD_STATE_SERVICE_URL?.trim() || null;
  const stateServiceApiKey = process.env.LOCD_STATE_SERVICE_API_KEY?.trim() || null;
  const coordinationUrl = process.env.LOCD_COORDINATION_URL?.trim() || null;
  const coordinationApiKey = process.env.LOCD_COORDINATION_API_KEY?.trim() || null;
  const providerFile = process.env.LOCD_PROVIDERS_FILE?.trim() || null;
  const policyFile = process.env.LOCD_POLICIES_FILE?.trim() || null;
  const targetRegistry = await createConfiguredTargetRegistry({
    targetFile,
    providerFile
  });

  const stateStores = stateDbFile
    ? createSQLiteStateStores({ filePath: stateDbFile, maxEntries: 5000 })
    : null;

  const networkState = !stateDbFile && stateServiceUrl
    ? createHTTPStateStores({
        baseUrl: stateServiceUrl,
        apiKey: stateServiceApiKey,
        maxEntries: 5000
      })
    : null;

  const decisionStore = stateStores
    ? stateStores.telemetry
    : networkState?.telemetry
      ? networkState.telemetry
      : telemetryFile
        ? createFileDecisionStore({ filePath: telemetryFile, maxEntries: 5000 })
        : createDecisionStore({ maxEntries: 1000 });

  const coordinationStore = stateStores?.coordination ||
    networkState?.coordination ||
    (coordinationUrl
      ? createHTTPCoordinationStore({
          baseUrl: coordinationUrl,
          apiKey: coordinationApiKey
        })
      : null);

  const logger = createLogger({ level: process.env.LOCD_LOG_LEVEL || "info" });
  const probeScheduler = createConfiguredProbeScheduler({
    registry: targetRegistry,
    intervalMs: Number(process.env.LOCD_PROBE_INTERVAL_MS || 0),
    maxConcurrent: Number(process.env.LOCD_PROBE_MAX_CONCURRENT || 4),
    logger
  });
  const policyStore = stateStores?.policies ||
    networkState?.policies ||
    (policyFile
      ? await createFilePolicyStore({ filePath: policyFile, maxVersionsPerPolicy: 20 })
      : createPolicyStore());

  const server = createServer({
    targetFile,
    targetRegistry,
    policyStore,
    decisionStore,
    logger,
    probeScheduler,
    coordinationStore,
    coordinationBackend: stateDbFile
      ? "sqlite"
      : (coordinationUrl || stateServiceUrl)
        ? "network"
        : "process-local",
    telemetryBackend: stateDbFile
      ? "sqlite"
      : (stateServiceUrl || telemetryFile)
        ? (stateServiceUrl ? "network" : "file")
        : "process-local",
    policyBackend: stateDbFile
      ? "sqlite"
      : stateServiceUrl
        ? "network"
        : policyFile
          ? "file"
          : "process-local",
    executionEnabled: process.env.LOCD_EXECUTION_ENABLED === "true"
  });

  const shutdown = createGracefulShutdown({
    server,
    probeScheduler,
    logger,
    onClosed: () => stateStores?.close()
  });

  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });

  server.listen(port, "0.0.0.0", () => {
    if (probeScheduler) {
      probeScheduler.start();
      void probeScheduler.runOnce();
    }
    console.log("LOCD Engine API listening on 0.0.0.0:" + port);
  });
}
