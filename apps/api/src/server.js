import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../../../packages/core/src/index.js";
import { createDecisionStore } from "../../../packages/telemetry/src/index.js";
import { listPolicyProfiles } from "../../../packages/policy/src/index.js";
import { createTargetRegistry } from "../../../packages/registry/src/index.js";
import { planHybridExecution } from "../../../packages/planner/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../../web");
const decisionStore = createDecisionStore({ maxEntries: 1000 });
const targetRegistry = createTargetRegistry();


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

export function createServer({ apiKey = process.env.LOCD_API_KEY?.trim() || null } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;

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

      if (req.method === "POST" && pathname === "/v1/hybrid-plan") {
        const body = await readBody(req);
        const hasRequestTargets = Array.isArray(body.targets) && body.targets.length > 0;
        const request = hasRequestTargets
          ? body
          : { ...body, targets: await targetRegistry.list() };

        if (!request.targets.length) {
          sendJson(res, 503, { error: "no_registered_targets" });
          return;
        }

        sendJson(res, 200, planHybridExecution(request));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/decide") {
        const body = await readBody(req);
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

        sendJson(res, 200, { ...decision, decisionId: event.id });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/outcomes") {
        const body = await readBody(req);
        if (!body.decisionId) {
          sendJson(res, 400, { error: "decisionId is required" });
          return;
        }

        try {
          const event = decisionStore.recordOutcome(body.decisionId, body);
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
        const target = await targetRegistry.register(await readBody(req));
        sendJson(res, 201, await target.getSnapshot());
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
      sendJson(res, 400, { error: message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, "0.0.0.0", () => {
    console.log("LOCD Engine API listening on 0.0.0.0:" + port);
  });
}
