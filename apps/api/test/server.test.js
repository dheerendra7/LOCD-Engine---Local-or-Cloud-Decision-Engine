import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredProbeScheduler, createConfiguredTargetRegistry, createServer } from "../src/server.js";
import { createFileDecisionStore } from "../../../packages/telemetry/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import { createTargetRegistry } from "../../../packages/registry/src/index.js";
import { createExecutionRegistry } from "../../../packages/execution/src/index.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let server;
let baseUrl;

test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = "http://127.0.0.1:" + address.port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test("health endpoint reports service readiness", async () => {
  const response = await fetch(baseUrl + "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "locd-api",
    version: "0.1.0"
  });
});

test("decision endpoint returns an explainable route", async () => {
  const response = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "llm-inference", sensitivity: "high" },
      constraints: { latencyBudgetMs: 800, maxCostUsd: 0.05 },
      policy: { sensitiveDataMode: "local-only" },
      targets: [
        {
          id: "gpu-local",
          mode: "local",
          health: 0.98,
          capacity: 0.2,
          privacy: 1,
          estimatedLatencyMs: 420,
          estimatedCostUsd: 0
        },
        {
          id: "public-cloud",
          mode: "cloud",
          health: 0.999,
          capacity: 0.1,
          privacy: 0.1,
          estimatedLatencyMs: 200,
          estimatedCostUsd: 0.01
        }
      ]
    })
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route, "local");
  assert.equal(body.targetId, "gpu-local");
  assert.ok(Array.isArray(body.rejected));
});

test("malformed JSON returns a client error", async () => {
  const response = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid JSON" });
});

test("unsupported methods are rejected", async () => {
  const response = await fetch(baseUrl + "/v1/decide", { method: "PUT" });
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("decision history and metrics expose metadata without request payloads", async () => {
  await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [
        { id: "local", mode: "local", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 20, estimatedCostUsd: 0 }
      ]
    })
  });

  const history = await fetch(baseUrl + "/v1/decisions?limit=10");
  assert.equal(history.status, 200);
  const historyBody = await history.json();
  assert.equal(historyBody.decisions.length > 0, true);
  assert.equal("prompt" in historyBody.decisions[0], false);

  const metrics = await fetch(baseUrl + "/v1/metrics");
  assert.equal(metrics.status, 200);
  const metricsBody = await metrics.json();
  assert.equal(metricsBody.totalDecisions >= 1, true);
  assert.equal(metricsBody.routes.local >= 1, true);
});

test("policy catalog endpoint returns reusable profiles", async () => {
  const response = await fetch(baseUrl + "/v1/policies");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.policies.some(profile => profile.id === "balanced"), true);
});

test("target registry can drive decisions when request omits targets", async () => {
  const register = await fetch(baseUrl + "/v1/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "registered-local",
      mode: "local",
      health: 1,
      capacity: 0.1,
      privacy: 1,
      estimatedLatencyMs: 40,
      estimatedCostUsd: 0,
      capabilities: ["text-generation"]
    })
  });
  assert.equal(register.status, 201);

  const listed = await fetch(baseUrl + "/v1/targets");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).targets.some(target => target.id === "registered-local"), true);

  const decision = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "llm-inference", sensitivity: "high" },
      policy: { profile: "strictLocalSensitive" }
    })
  });
  assert.equal(decision.status, 200);
  assert.equal((await decision.json()).targetId, "registered-local");

  const removed = await fetch(baseUrl + "/v1/targets/registered-local", { method: "DELETE" });
  assert.equal(removed.status, 200);

  const missing = await fetch(baseUrl + "/v1/targets/registered-local", { method: "DELETE" });
  assert.equal(missing.status, 404);
});

test("request-scoped decision does not require a populated registry", async () => {
  const response = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [
        {
          id: "request-local",
          mode: "local",
          health: 1,
          capacity: 0.1,
          privacy: 1,
          estimatedLatencyMs: 30,
          estimatedCostUsd: 0
        }
      ]
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).targetId, "request-local");
});

test("empty target registry is readable", async () => {
  const response = await fetch(baseUrl + "/v1/targets");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).targets, []);
});

test("configured API key protects v1 endpoints while health remains public", async () => {
  const protectedServer = createServer({ apiKey: "test-api-key-1234567890" });
  await new Promise(resolve => protectedServer.listen(0, "127.0.0.1", resolve));
  const address = protectedServer.address();
  const protectedBaseUrl = "http://127.0.0.1:" + address.port;

  try {
    const health = await fetch(protectedBaseUrl + "/health");
    assert.equal(health.status, 200);

    const missing = await fetch(protectedBaseUrl + "/v1/policies");
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "unauthorized" });

    const wrong = await fetch(protectedBaseUrl + "/v1/policies", {
      headers: { authorization: "Bearer wrong-key" }
    });
    assert.equal(wrong.status, 401);

    const bearer = await fetch(protectedBaseUrl + "/v1/policies", {
      headers: { authorization: "Bearer test-api-key-1234567890" }
    });
    assert.equal(bearer.status, 200);

    const header = await fetch(protectedBaseUrl + "/v1/metrics", {
      headers: { "x-locd-api-key": "test-api-key-1234567890" }
    });
    assert.equal(header.status, 200);
  } finally {
    await new Promise(resolve => protectedServer.close(resolve));
  }
});

test("decision without request targets returns 503 when registry is empty", async () => {
  const response = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" }
    })
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "no_registered_targets" });
});

test("decision outcome endpoint closes the prediction feedback loop", async () => {
  const decision = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [
        {
          id: "feedback-local",
          mode: "local",
          health: 1,
          capacity: 0.1,
          privacy: 1,
          estimatedLatencyMs: 100,
          estimatedCostUsd: 0.01
        }
      ]
    })
  });

  assert.equal(decision.status, 200);
  const decisionBody = await decision.json();
  assert.match(decisionBody.decisionId, /^[0-9a-f-]{36}$/);

  const outcome = await fetch(baseUrl + "/v1/outcomes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decisionId: decisionBody.decisionId,
      outcome: "success",
      actualLatencyMs: 90,
      actualCostUsd: 0.012
    })
  });

  assert.equal(outcome.status, 200);
  const outcomeBody = await outcome.json();
  assert.equal(outcomeBody.outcome, "success");
  assert.equal(outcomeBody.actualLatencyMs, 90);

  const metrics = await fetch(baseUrl + "/v1/metrics");
  const metricsBody = await metrics.json();
  assert.equal(metricsBody.successRate > 0, true);
  assert.equal(metricsBody.meanAbsoluteLatencyErrorMs >= 0, true);
});

test("unknown decision outcome IDs return not found", async () => {
  const response = await fetch(baseUrl + "/v1/outcomes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decisionId: "does-not-exist",
      outcome: "failure"
    })
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "decision_not_found" });
});

test("hybrid plan endpoint validates multi-target execution", async () => {
  const response = await fetch(baseUrl + "/v1/hybrid-plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "llm-inference", sensitivity: "medium" },
      steps: [
        { id: "pre", purpose: "preprocess", targetId: "local-stage" },
        { id: "infer", purpose: "inference", targetId: "private-stage" }
      ],
      targets: [
        {
          id: "local-stage",
          mode: "local",
          available: true,
          estimatedLatencyMs: 30,
          estimatedCostUsd: 0
        },
        {
          id: "private-stage",
          mode: "private",
          available: true,
          estimatedLatencyMs: 200,
          estimatedCostUsd: 0.01
        }
      ]
    })
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.valid, true);
  assert.equal(body.route, "hybrid");
});

test("hybrid plan uses the registered target set when request targets are omitted", async () => {
  const register = await fetch(baseUrl + "/v1/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "planner-local",
      mode: "local",
      available: true,
      estimatedLatencyMs: 20,
      estimatedCostUsd: 0
    })
  });
  assert.equal(register.status, 201);

  const registerPrivate = await fetch(baseUrl + "/v1/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "planner-private",
      mode: "private",
      available: true,
      estimatedLatencyMs: 100,
      estimatedCostUsd: 0.01
    })
  });
  assert.equal(registerPrivate.status, 201);

  const response = await fetch(baseUrl + "/v1/hybrid-plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "batch", sensitivity: "low" },
      steps: [
        { id: "a", targetId: "planner-local" },
        { id: "b", targetId: "planner-private" }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).valid, true);

  await fetch(baseUrl + "/v1/targets/planner-local", { method: "DELETE" });
  await fetch(baseUrl + "/v1/targets/planner-private", { method: "DELETE" });
});


test("target writes persist when a target file is configured", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-api-persist-"));
  const targetFile = path.join(dir, "targets.json");
  const registry = createTargetRegistry();
  const persistentServer = createServer({ targetRegistry: registry, targetFile });

  await new Promise(resolve => persistentServer.listen(0, "127.0.0.1", resolve));
  const address = persistentServer.address();
  const url = "http://127.0.0.1:" + address.port;

  try {
    const response = await fetch(url + "/v1/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "persist-api-target",
        mode: "local",
        health: 1,
        capacity: 0.2,
        privacy: 1
      })
    });
    assert.equal(response.status, 201);

    const persisted = JSON.parse(await readFile(targetFile, "utf8"));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, "persist-api-target");

    const removed = await fetch(url + "/v1/targets/persist-api-target", { method: "DELETE" });
    assert.equal(removed.status, 200);

    const afterDelete = JSON.parse(await readFile(targetFile, "utf8"));
    assert.deepEqual(afterDelete, []);
  } finally {
    await new Promise(resolve => persistentServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("different server instances keep decision and registry state isolated", async () => {
  const a = createServer();
  const b = createServer();

  await Promise.all([
    new Promise(resolve => a.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => b.listen(0, "127.0.0.1", resolve))
  ]);

  const aUrl = "http://127.0.0.1:" + a.address().port;
  const bUrl = "http://127.0.0.1:" + b.address().port;

  try {
    await fetch(aUrl + "/v1/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "instance-a-target",
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 20,
        estimatedCostUsd: 0
      })
    });

    const aTargets = await (await fetch(aUrl + "/v1/targets")).json();
    const bTargets = await (await fetch(bUrl + "/v1/targets")).json();

    assert.equal(aTargets.targets.some(target => target.id === "instance-a-target"), true);
    assert.equal(bTargets.targets.some(target => target.id === "instance-a-target"), false);
  } finally {
    await Promise.all([
      new Promise(resolve => a.close(resolve)),
      new Promise(resolve => b.close(resolve))
    ]);
  }
});
test("target heartbeat endpoint updates live target telemetry", async () => {
  const register = await fetch(baseUrl + "/v1/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "api-heartbeat-target",
      mode: "local",
      health: 0.6,
      capacity: 0.7,
      privacy: 1,
      estimatedLatencyMs: 300
    })
  });
  assert.equal(register.status, 201);

  const heartbeat = await fetch(baseUrl + "/v1/targets/api-heartbeat-target/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      health: 0.98,
      capacity: 0.15,
      estimatedLatencyMs: 55,
      availableMemoryGb: 18,
      maxContextTokens: 64000
    })
  });

  assert.equal(heartbeat.status, 200);
  const body = await heartbeat.json();
  assert.equal(body.health, 0.98);
  assert.equal(body.capacity, 0.15);
  assert.equal(body.estimatedLatencyMs, 55);
  assert.equal(body.availableMemoryGb, 18);
  assert.equal(body.maxContextTokens, 64000);
  assert.match(body.lastHeartbeatAt, /^202/);

  const listed = await (await fetch(baseUrl + "/v1/targets")).json();
  const target = listed.targets.find(item => item.id === "api-heartbeat-target");
  assert.equal(target.health, 0.98);

  await fetch(baseUrl + "/v1/targets/api-heartbeat-target", { method: "DELETE" });
});

test("heartbeat returns not found for unknown targets", async () => {
  const response = await fetch(baseUrl + "/v1/targets/missing-heartbeat/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ health: 1 })
  });
  assert.equal(response.status, 404);
});

test("request IDs are returned and idempotency replays the same decision", async () => {
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "decision-retry-1",
    "x-request-id": "client-request-1"
  };
  const body = JSON.stringify({
    workload: { type: "classification", sensitivity: "low" },
    targets: [
      {
        id: "idem-local",
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 20,
        estimatedCostUsd: 0
      }
    ]
  });

  const first = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers,
    body
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-request-id"), "client-request-1");
  assert.equal(first.headers.get("idempotency-replayed"), null);

  const firstBody = await first.json();

  const second = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: {
      ...headers,
      "x-request-id": "client-request-2"
    },
    body
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-request-id"), "client-request-2");
  assert.equal(second.headers.get("idempotency-replayed"), "true");

  const secondBody = await second.json();
  assert.equal(secondBody.decisionId, firstBody.decisionId);
});

test("reusing an idempotency key with a different payload returns 409", async () => {
  const commonHeaders = {
    "content-type": "application/json",
    "idempotency-key": "decision-conflict-1"
  };

  const first = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [
        { id: "conflict-a", mode: "local", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 20, estimatedCostUsd: 0 }
      ]
    })
  });
  assert.equal(first.status, 200);

  const second = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [
        { id: "conflict-b", mode: "local", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 20, estimatedCostUsd: 0 }
      ]
    })
  });

  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "idempotency_key_reused" });
});

test("oversized request bodies return HTTP 413", async () => {
  const server = createServer({ maxBodyBytes: 32 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;

  try {
    const response = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workload: { type: "classification", sensitivity: "low" },
        targets: [
          { id: "large-body", mode: "local", health: 1, capacity: 0.1, privacy: 1 }
        ]
      })
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request body too large" });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("rate limits apply to v1 traffic but not health checks", async () => {
  const server = createServer({
    rateLimiter: {
      enabled: true,
      consume() {
        return {
          allowed: false,
          limit: 1,
          remaining: 0,
          resetAt: Date.now() + 5000
        };
      }
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;

  try {
    const health = await fetch(url + "/health");
    assert.equal(health.status, 200);

    const blocked = await fetch(url + "/v1/policies");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("x-ratelimit-limit"), "1");
    assert.equal(blocked.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(blocked.headers.get("retry-after"), "5");
    assert.deepEqual(await blocked.json(), { error: "rate_limit_exceeded" });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("invalid body limit configuration fails at server creation", () => {
  assert.throws(
    () => createServer({ maxBodyBytes: 0 }),
    /maxBodyBytes must be >= 1/
  );
});

test("request ID falls back to a generated identifier when caller value is too long", async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;

  try {
    const response = await fetch(url + "/health", {
      headers: { "x-request-id": "x".repeat(129) }
    });
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId, /^[0-9a-f-]{36}$/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("file-backed telemetry survives server restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-api-telemetry-"));
  const telemetryFile = path.join(dir, "events.json");

  const firstStore = createFileDecisionStore({ filePath: telemetryFile, maxEntries: 100 });
  const first = createServer({ decisionStore: firstStore });
  await new Promise(resolve => first.listen(0, "127.0.0.1", resolve));
  const firstUrl = "http://127.0.0.1:" + first.address().port;

  try {
    const decision = await fetch(firstUrl + "/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workload: { type: "classification", sensitivity: "low" },
        targets: [
          {
            id: "persist-telemetry-target",
            mode: "local",
            health: 1,
            capacity: 0.1,
            privacy: 1,
            estimatedLatencyMs: 25,
            estimatedCostUsd: 0
          }
        ]
      })
    });
    assert.equal(decision.status, 200);
    await new Promise(resolve => first.close(resolve));

    const secondStore = createFileDecisionStore({ filePath: telemetryFile, maxEntries: 100 });
    const second = createServer({ decisionStore: secondStore });
    await new Promise(resolve => second.listen(0, "127.0.0.1", resolve));
    const secondUrl = "http://127.0.0.1:" + second.address().port;

    try {
      const metrics = await fetch(secondUrl + "/v1/metrics");
      assert.equal(metrics.status, 200);
      const body = await metrics.json();
      assert.equal(body.totalDecisions, 1);

      const history = await fetch(secondUrl + "/v1/decisions?limit=10");
      assert.equal((await history.json()).decisions.length, 1);
    } finally {
      await new Promise(resolve => second.close(resolve));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});



test("API emits structured request lifecycle logs without request payloads", async () => {
  const lines = [];
  const logger = createLogger({
    sink: value => lines.push(value),
    clock: () => new Date("2026-10-01T00:00:00Z")
  });
  const observabilityServer = createServer({ logger });

  await new Promise(resolve => observabilityServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + observabilityServer.address().port;

  try {
    const response = await fetch(url + "/health", {
      headers: {
        "x-request-id": "observability-test"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "observability-test");

    const event = JSON.parse(lines.at(-1));
    assert.equal(event.event, "http_request");
    assert.equal(event.requestId, "observability-test");
    assert.equal(event.method, "GET");
    assert.equal(event.path, "/health");
    assert.equal(event.status, 200);
    assert.equal(typeof event.durationMs, "number");
    assert.equal("body" in event, false);
  } finally {
    await new Promise(resolve => observabilityServer.close(resolve));
  }
});

test("target probe endpoint refreshes a provider adapter snapshot", async () => {
  let snapshot = {
    id: "probe-api-target",
    mode: "private",
    available: false,
    health: 0,
    estimatedLatencyMs: null
  };

  const registry = createTargetRegistry([{
    id: "probe-api-target",
    async getSnapshot() {
      return snapshot;
    },
    async setSnapshot(next) {
      snapshot = { ...snapshot, ...next };
      return snapshot;
    },
    async probe() {
      return {
        ...snapshot,
        available: true,
        health: 1,
        estimatedLatencyMs: 42,
        lastHeartbeatAt: new Date().toISOString()
      };
    }
  }]);

  const probeServer = createServer({ targetRegistry: registry });
  await new Promise(resolve => probeServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + probeServer.address().port;

  try {
    const response = await fetch(url + "/v1/targets/probe-api-target/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.health, 1);
    assert.equal(body.estimatedLatencyMs, 42);
  } finally {
    await new Promise(resolve => probeServer.close(resolve));
  }
});

test("probe endpoint returns 501 when target adapter has no probe operation", async () => {
  const registry = createTargetRegistry([{
    id: "probe-unsupported",
    async getSnapshot() {
      return { id: "probe-unsupported", mode: "local" };
    }
  }]);
  const probeServer = createServer({ targetRegistry: registry });
  await new Promise(resolve => probeServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + probeServer.address().port;

  try {
    const response = await fetch(url + "/v1/targets/probe-unsupported/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), { error: "target_does_not_support_probe" });
  } finally {
    await new Promise(resolve => probeServer.close(resolve));
  }
});

test("server bootstrap loads provider adapters from config file without exposing secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-bootstrap-"));
  const file = path.join(dir, "providers.json");

  try {
    await writeFile(file, JSON.stringify({
      providers: [{
        id: "bootstrap-provider",
        targetId: "bootstrap-provider",
        mode: "private",
        baseUrl: "https://inference.example.com",
        apiKeyEnv: "BOOTSTRAP_PROVIDER_KEY",
        model: "demo-model"
      }]
    }), "utf8");

    const registry = await createConfiguredTargetRegistry({
      providerFile: file,
      env: { BOOTSTRAP_PROVIDER_KEY: "not-exposed" },
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    });

    assert.equal(registry.has("bootstrap-provider"), true);
    const snapshot = await registry.get("bootstrap-provider");
    assert.equal(snapshot.available, false);
    assert.equal("apiKey" in snapshot, false);
    assert.equal(JSON.stringify(snapshot).includes("not-exposed"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server bootstrap fails on duplicate provider and target IDs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-bootstrap-dup-"));
  const targetFile = path.join(dir, "targets.json");
  const providerFile = path.join(dir, "providers.json");

  try {
    const target = {
      id: "same-id",
      mode: "local",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 1
    };
    await writeFile(targetFile, JSON.stringify([target]), "utf8");
    await writeFile(providerFile, JSON.stringify({
      providers: [{
        id: "same-id",
        targetId: "same-id",
        mode: "private",
        baseUrl: "https://inference.example.com"
      }]
    }), "utf8");

    await assert.rejects(
      () => createConfiguredTargetRegistry({
        targetFile,
        providerFile,
        fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
      }),
      /target already registered/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("configured probe scheduler can be disabled with zero interval", () => {
  const scheduler = createConfiguredProbeScheduler({
    registry: {
      async listProbeable() { return []; },
      async probe() { return {}; }
    },
    intervalMs: 0
  });
  assert.equal(scheduler, null);
});

test("configured probe scheduler emits normalized probe logs", async () => {
  const logs = [];
  const scheduler = createConfiguredProbeScheduler({
    registry: {
      async listProbeable() { return [{ id: "configured-target" }]; },
      async probe() {
        return {
          id: "configured-target",
          available: true,
          health: 0.97,
          estimatedLatencyMs: 31
        };
      }
    },
    intervalMs: 1000,
    logger: {
      info(event) {
        logs.push(event);
      }
    }
  });

  const results = await scheduler.runOnce();
  assert.equal(results[0].status, "success");
  assert.equal(logs[0].event, "target_probe");
  assert.equal(logs[0].targetId, "configured-target");
  assert.equal(logs[0].health, 0.97);
  assert.equal(logs[0].latencyMs, 31);
});


test("dry-run execution works through the public API", async () => {
  const executionServer = createServer({
    targetRegistry: createTargetRegistry([{
      id: "dry-run-target",
      mode: "local",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 1
    }])
  });

  await new Promise(resolve => executionServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + executionServer.address().port;

  try {
    const response = await fetch(url + "/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "dry-run",
        plan: {
          valid: true,
          steps: [
            { id: "step-1", targetId: "dry-run-target", purpose: "inference" }
          ]
        }
      })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "completed");
    assert.equal(body.mode, "dry-run");
    assert.equal(body.receipts[0].status, "completed");
    assert.deepEqual(body.results, []);
  } finally {
    await new Promise(resolve => executionServer.close(resolve));
  }
});

test("live execution is disabled unless explicitly enabled", async () => {
  const executionServer = createServer({
    targetRegistry: createTargetRegistry([{
      id: "live-target",
      mode: "private",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 1
    }]),
    executionRegistry: createExecutionRegistry([{
      id: "live-adapter",
      targetId: "live-target",
      async execute() {
        throw new Error("must-not-run");
      }
    }]),
    executionEnabled: false,
    apiKey: "server-secret"
  });

  await new Promise(resolve => executionServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + executionServer.address().port;

  try {
    const response = await fetch(url + "/v1/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer server-secret"
      },
      body: JSON.stringify({
        mode: "live",
        plan: {
          valid: true,
          steps: [{ id: "step-1", targetId: "live-target" }]
        }
      })
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "live_execution_disabled" });
  } finally {
    await new Promise(resolve => executionServer.close(resolve));
  }
});

test("live execution returns provider results only when requested", async () => {
  const adapter = {
    id: "provider-adapter",
    targetId: "provider-target",
    async execute({ payload }) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: payload.prompt
          }
        }]
      };
    }
  };

  const executionServer = createServer({
    targetRegistry: createTargetRegistry([{
      id: "provider-target",
      mode: "private",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 1
    }]),
    executionRegistry: createExecutionRegistry([adapter]),
    executionEnabled: true,
    apiKey: "server-secret"
  });

  await new Promise(resolve => executionServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + executionServer.address().port;

  try {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer server-secret"
    };

    const plan = {
      valid: true,
      steps: [{
        id: "provider-step",
        targetId: "provider-target",
        purpose: "inference",
        payload: { prompt: "hello" }
      }]
    };

    const hiddenResponse = await fetch(url + "/v1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "live", plan })
    });
    assert.equal(hiddenResponse.status, 200);
    const hidden = await hiddenResponse.json();
    assert.deepEqual(hidden.results, []);

    const visibleResponse = await fetch(url + "/v1/execute", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "execute-visible-1" },
      body: JSON.stringify({ mode: "live", plan, includeOutputs: true })
    });
    assert.equal(visibleResponse.status, 200);
    const visible = await visibleResponse.json();
    assert.equal(
      visible.results[0].result.choices[0].message.content,
      "hello"
    );
    assert.equal("payload" in visible.receipts[0], false);
  } finally {
    await new Promise(resolve => executionServer.close(resolve));
  }
});

test("execution retries replay the original result", async () => {
  let executions = 0;
  const executionServer = createServer({
    targetRegistry: createTargetRegistry([{
      id: "retry-target",
      mode: "local",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 1
    }]),
    executionRegistry: createExecutionRegistry([{
      id: "retry-adapter",
      targetId: "retry-target",
      async execute() {
        executions++;
        return { ok: true, executions };
      }
    }]),
    executionEnabled: true,
    apiKey: "server-secret"
  });

  await new Promise(resolve => executionServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + executionServer.address().port;

  try {
    const request = {
      mode: "live",
      includeOutputs: true,
      plan: {
        valid: true,
        steps: [{ id: "retry-step", targetId: "retry-target" }]
      }
    };
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer server-secret",
      "idempotency-key": "execution-retry-1"
    };

    const first = await fetch(url + "/v1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify(request)
    });
    const second = await fetch(url + "/v1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify(request)
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("idempotency-replayed"), "true");
    assert.equal(executions, 1);
  } finally {
    await new Promise(resolve => executionServer.close(resolve));
  }
});

test("configured execution registry adds dry-run fallbacks for static targets", async () => {
  const targetRegistry = createTargetRegistry([{
    id: "static-target",
    mode: "local",
    available: true,
    health: 1,
    capacity: 0.1,
    privacy: 1
  }]);

  const registry = await createConfiguredExecutionRegistry({ targetRegistry });
  assert.equal(registry.has("static-target"), true);
  assert.equal(registry.has("dry-run:static-target"), false);
});
