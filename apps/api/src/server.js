import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../../../packages/core/src/index.js";
import { createDecisionStore, createFileDecisionStore } from "../../../packages/telemetry/src/index.js";
import { listPolicyProfiles } from "../../../packages/policy/src/index.js";
import { createTargetRegistry } from "../../../packages/registry/src/index.js";
import { planHybridExecution } from "../../../packages/planner/src/index.js";
import { createLogger, createRequestId } from "../../../packages/observability/src/index.js";
import { createIdempotencyStore } from "../../../packages/runtime/src/index.js";
import { createRateLimiter, getClientKey } from "./rate-limit.js";
import { createProbeScheduler } from "../../../packages/probing/src/index.js";
import {
  createDryRunExecutionAdapter,
  createExecutionRegistry,
  executePlan
} from "../../../packages/execution/src/index.js";
import { loadProvidersFromFile } from "../../../packages/providers/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web");

const SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
});


function safeSecretEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function isAuthorized(req, configuredApiKey) {
  if (!configuredApiKey) return true;

  const authorization = req.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerKey = req.headers["x-locd-api-key"];
  const supplied = bearer || headerKey;

  return safeSecretEqual(supplied, configuredApiKey);
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = 1_000_000) {
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

export function createConfiguredProbeScheduler({
  registry,
  intervalMs = Number(process.env.LOCD_PROBE_INTERVAL_MS || 0),
  maxConcurrent = Number(process.env.LOCD_PROBE_MAX_CONCURRENT || 4),
  logger = createLogger({ level: process.env.LOCD_LOG_LEVEL || "info" })
} = {}) {
  if (!registry) throw new Error("registry is required");
  if (intervalMs <= 0) return null;

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
  const targetRegistry = createTargetRegistry();

  if (targetFile) {
    await targetRegistry.loadFromFile(targetFile);
  }

  if (providerFile) {
    const providers = await loadProvidersFromFile(providerFile, env, fetchImpl);
    for (const provider of providers) {
      targetRegistry.register(provider);
    }
  }

  return targetRegistry;
}

export function createServer({
  apiKey = process.env.LOCD_API_KEY?.trim() || null,
  decisionStore = createDecisionStore({ maxEntries: 1000 }),
  targetRegistry = createTargetRegistry(),
  targetFile = process.env.LOCD_TARGETS_FILE?.trim() || null,
  idempotencyStore = createIdempotencyStore(),
  maxBodyBytes = Number(process.env.LOCD_MAX_BODY_BYTES || 1_000_000),
  rateLimiter = createRateLimiter({
    maxRequests: Number(process.env.LOCD_RATE_LIMIT_RPM || 0),
    windowMs: 60_000
  }),
  trustProxy = process.env.LOCD_TRUST_PROXY === "true",
  logger = createLogger({
    level: process.env.LOCD_LOG_LEVEL || "info"
  }),
  executionRegistry = null,
  executionEnabled = process.env.LOCD_EXECUTION_ENABLED === "true"
} = {}) {
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be >= 1");
  }
  return http.createServer(async (req, res) => {
    const requestId = createRequestId(req.headers["x-request-id"]);
    const startedAt = process.hrtime.bigint();
    let requestLogWritten = false;

    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;

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

      const idempotencyKey = String(req.headers["idempotency-key"] || "").trim() || null;
      const getReplay = body => {
        if (!idempotencyKey || !["POST", "PUT", "PATCH"].includes(req.method)) return null;
        return idempotencyStore.lookup(req.method + " " + pathname, idempotencyKey, body);
      };
      const rememberResponse = (body, status, responseBody) => {
        if (!idempotencyKey) return;
        idempotencyStore.remember(
          req.method + " " + pathname,
          idempotencyKey,
          body,
          { status, body: responseBody }
        );
      };
      const sendReplay = replay => sendJson(res, replay.status, replay.body, {
        "idempotency-replayed": "true"
      });

      if (pathname.startsWith("/v1/")) {
        const rate = rateLimiter.consume(getClientKey(req, { trustProxy }));
        if (rateLimiter.enabled) {
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

      if (pathname.startsWith("/v1/") && !isAuthorized(req, apiKey)) {
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "www-authenticate": "Bearer"
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          service: "locd-api",
          version: "0.1.0"
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/execute") {
        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
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
          if (!apiKey) {
            sendJson(res, 403, { error: "live_execution_requires_api_key" });
            return;
          }
        }

        const registry = executionRegistry ||
          await createConfiguredExecutionRegistry({ targetRegistry });

        const responseBody = await executePlan(body.plan, {
          registry,
          mode,
          timeoutMs: body.timeoutMs,
          failFast: body.failFast !== false,
          includeOutputs: body.includeOutputs === true
        });

        rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/hybrid-plan") {
        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }
        const hasRequestTargets = Array.isArray(body.targets) && body.targets.length > 0;
        const request = hasRequestTargets
          ? body
          : { ...body, targets: await targetRegistry.list() };

        if (!request.targets.length) {
          sendJson(res, 503, { error: "no_registered_targets" });
          return;
        }

        const responseBody = planHybridExecution(request);
        rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/decide") {
        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }
        const hasRequestTargets = Array.isArray(body.targets) && body.targets.length > 0;
        const request = hasRequestTargets
          ? body
          : { ...body, targets: await targetRegistry.list() };

        if (!request.targets.length) {
          sendJson(res, 503, { error: "no_registered_targets" });
          return;
        }

        const decision = decide(request);

        const event = decisionStore.record({
          decisionVersion: decision.decisionVersion,
          workloadType: body.workload?.type,
          route: decision.route,
          targetId: decision.targetId,
          confidence: decision.confidence,
          estimatedLatencyMs: decision.estimated?.latencyMs,
          estimatedCostUsd: decision.estimated?.costUsd,
          outcome: "pending"
        });

        const responseBody = { ...decision, decisionId: event.id };
        rememberResponse(body, 200, responseBody);
        sendJson(res, 200, responseBody);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/outcomes") {
        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }
        if (!body.decisionId) {
          sendJson(res, 400, { error: "decisionId is required" });
          return;
        }

        try {
          const event = decisionStore.recordOutcome(body.decisionId, body);
          rememberResponse(body, 200, event);
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

      if (req.method === "GET" && pathname === "/v1/policies") {
        sendJson(res, 200, { policies: listPolicyProfiles() });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/targets") {
        sendJson(res, 200, { targets: await targetRegistry.list() });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/targets") {
        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        const target = await targetRegistry.register(body);
        if (targetFile) await targetRegistry.saveToFile(targetFile);
        const responseBody = await target.getSnapshot();
        rememberResponse(body, 201, responseBody);
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

        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        try {
          const snapshot = await targetRegistry.probe(id);
          if (targetFile) await targetRegistry.saveToFile(targetFile);
          rememberResponse(body, 200, snapshot);
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

        const body = await readBody(req, maxBodyBytes);
        const replay = getReplay(body);
        if (replay) {
          sendReplay(replay);
          return;
        }

        try {
          const updated = await targetRegistry.heartbeat(id, body);
          if (targetFile) await targetRegistry.saveToFile(targetFile);
          rememberResponse(body, 200, updated);
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
        const removed = targetRegistry.remove(id);
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
        sendJson(res, 200, { decisions: decisionStore.list({ limit }) });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/metrics") {
        sendJson(res, 200, decisionStore.summary());
        return;
      }

      if (req.method === "GET") {
        await serveWeb(res, pathname);
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad_request";
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
      sendJson(res, 400, { error: message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const targetFile = process.env.LOCD_TARGETS_FILE?.trim() || null;
  const telemetryFile = process.env.LOCD_TELEMETRY_FILE?.trim() || null;
  const providerFile = process.env.LOCD_PROVIDERS_FILE?.trim() || null;
  const targetRegistry = await createConfiguredTargetRegistry({
    targetFile,
    providerFile
  });

  const decisionStore = telemetryFile
    ? createFileDecisionStore({ filePath: telemetryFile, maxEntries: 5000 })
    : createDecisionStore({ maxEntries: 1000 });

  const logger = createLogger({ level: process.env.LOCD_LOG_LEVEL || "info" });
  const probeScheduler = createConfiguredProbeScheduler({
    registry: targetRegistry,
    intervalMs: Number(process.env.LOCD_PROBE_INTERVAL_MS || 0),
    maxConcurrent: Number(process.env.LOCD_PROBE_MAX_CONCURRENT || 4),
    logger
  });
  const executionRegistry = await createConfiguredExecutionRegistry({
    targetRegistry
  });

  createServer({ targetFile, targetRegistry, decisionStore, logger, executionRegistry, executionEnabled: process.env.LOCD_EXECUTION_ENABLED === "true" }).listen(port, "0.0.0.0", () => {
    if (probeScheduler) {
      probeScheduler.start();
      void probeScheduler.runOnce();
    }
    console.log("LOCD Engine API listening on 0.0.0.0:" + port);
  });
}
