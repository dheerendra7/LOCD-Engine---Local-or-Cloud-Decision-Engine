import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredExecutionRegistry, createConfiguredProbeScheduler, createConfiguredTargetRegistry, createGracefulShutdown, createServer } from "../src/server.js";
import { createFileDecisionStore } from "../../../packages/telemetry/src/index.js";
import { createCalibrator } from "../../../packages/calibration/src/index.js";
import { createScopedAuthorizer } from "../../../packages/auth/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import { createSQLiteStateStores } from "../../../packages/sqlite/src/index.js";
import { createStateServiceServer } from "../../state-service/src/server.js";
import {
  createHTTPStateStores,
  createHTTPCoordinationStore
} from "../../../packages/state-client/src/index.js";
import { createTargetRegistry } from "../../../packages/registry/src/index.js";
import { createExecutionRegistry } from "../../../packages/execution/src/index.js";
import { createInMemoryCoordinationStore } from "../../../packages/coordination/src/index.js";
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

test("tenant namespaces keep identical idempotency keys independent", async () => {
  const scopedServer = createServer({
    authorizer: createScopedAuthorizer({
      keys: [
        { id: "acme", secret: "acme-idem", tenantId: "acme", scopes: ["decide"] },
        { id: "beta", secret: "beta-idem", tenantId: "beta", scopes: ["decide"] }
      ]
    })
  });

  await new Promise(resolve => scopedServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + scopedServer.address().port;

  const makeRequest = (secret, targetId) => fetch(url + "/v1/decide", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      "idempotency-key": "same-key"
    },
    body: JSON.stringify({
      workload: { type: "tenant-idempotency", sensitivity: "low" },
      targets: [{
        id: targetId,
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 20,
        estimatedCostUsd: 0
      }]
    })
  });

  try {
    const acme = await makeRequest("acme-idem", "acme-target");
    const beta = await makeRequest("beta-idem", "beta-target");

    assert.equal(acme.status, 200);
    assert.equal(beta.status, 200);
    assert.equal(acme.headers.get("idempotency-replayed"), null);
    assert.equal(beta.headers.get("idempotency-replayed"), null);

    assert.equal((await acme.json()).targetId, "acme-target");
    assert.equal((await beta.json()).targetId, "beta-target");
  } finally {
    await new Promise(resolve => scopedServer.close(resolve));
  }
});

test("scoped API tenants cannot see or update each other's control-plane state", async () => {
  const scopedServer = createServer({
    authorizer: createScopedAuthorizer({
      keys: [
        { id: "acme", secret: "acme-secret", tenantId: "acme", scopes: ["read", "decide", "targets", "telemetry"] },
        { id: "beta", secret: "beta-secret", tenantId: "beta", scopes: ["read", "decide", "targets", "telemetry"] }
      ]
    })
  });

  await new Promise(resolve => scopedServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + scopedServer.address().port;

  const headersFor = secret => ({
    authorization: "Bearer " + secret,
    "content-type": "application/json"
  });

  const targetBody = {
    id: "shared-target-id",
    mode: "local",
    health: 1,
    capacity: 0.1,
    privacy: 1,
    estimatedLatencyMs: 30,
    estimatedCostUsd: 0
  };

  try {
    const acmeRegister = await fetch(url + "/v1/targets", {
      method: "POST",
      headers: headersFor("acme-secret"),
      body: JSON.stringify(targetBody)
    });
    const betaRegister = await fetch(url + "/v1/targets", {
      method: "POST",
      headers: headersFor("beta-secret"),
      body: JSON.stringify({ ...targetBody, estimatedLatencyMs: 80 })
    });

    assert.equal(acmeRegister.status, 201);
    assert.equal(betaRegister.status, 201);

    const acmeTargets = await (await fetch(url + "/v1/targets", {
      headers: { authorization: "Bearer acme-secret" }
    })).json();
    const betaTargets = await (await fetch(url + "/v1/targets", {
      headers: { authorization: "Bearer beta-secret" }
    })).json();

    assert.equal(acmeTargets.targets.length, 1);
    assert.equal(betaTargets.targets.length, 1);
    assert.equal(acmeTargets.targets[0].estimatedLatencyMs, 30);
    assert.equal(betaTargets.targets[0].estimatedLatencyMs, 80);

    const acmeDecision = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: headersFor("acme-secret"),
      body: JSON.stringify({
        workload: { type: "tenant-llm", sensitivity: "low" },
        policy: { sensitiveDataMode: "prefer-local" }
      })
    });
    const betaDecision = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: headersFor("beta-secret"),
      body: JSON.stringify({
        workload: { type: "tenant-llm", sensitivity: "low" },
        policy: { sensitiveDataMode: "prefer-local" }
      })
    });

    assert.equal(acmeDecision.status, 200);
    assert.equal(betaDecision.status, 200);
    assert.equal((await acmeDecision.json()).targetId, "shared-target-id");
    assert.equal((await betaDecision.json()).targetId, "shared-target-id");

    const acmeHistory = await (await fetch(url + "/v1/decisions", {
      headers: { authorization: "Bearer acme-secret" }
    })).json();
    const betaHistory = await (await fetch(url + "/v1/decisions", {
      headers: { authorization: "Bearer beta-secret" }
    })).json();

    assert.equal(acmeHistory.decisions.length, 1);
    assert.equal(betaHistory.decisions.length, 1);
    assert.equal(acmeHistory.decisions[0].tenantId, "acme");
    assert.equal(betaHistory.decisions[0].tenantId, "beta");

    const crossTenantOutcome = await fetch(url + "/v1/outcomes", {
      method: "POST",
      headers: headersFor("beta-secret"),
      body: JSON.stringify({
        decisionId: acmeHistory.decisions[0].id,
        outcome: "success",
        actualLatencyMs: 25
      })
    });
    assert.equal(crossTenantOutcome.status, 404);

    const acmeMetric = await (await fetch(url + "/v1/metrics", {
      headers: { authorization: "Bearer acme-secret" }
    })).json();
    const betaMetric = await (await fetch(url + "/v1/metrics", {
      headers: { authorization: "Bearer beta-secret" }
    })).json();

    assert.equal(acmeMetric.totalDecisions, 1);
    assert.equal(betaMetric.totalDecisions, 1);
  } finally {
    await new Promise(resolve => scopedServer.close(resolve));
  }
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

test("server bootstrap rejects provider configs sharing a target ID", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-bootstrap-dup-"));
  const providerFile = path.join(dir, "providers.json");

  try {
    await writeFile(providerFile, JSON.stringify({
      providers: [
        {
          id: "provider-one",
          targetId: "same-target",
          mode: "private",
          baseUrl: "https://one.example.com"
        },
        {
          id: "provider-two",
          targetId: "same-target",
          mode: "private",
          baseUrl: "https://two.example.com"
        }
      ]
    }), "utf8");

    await assert.rejects(
      () => createConfiguredTargetRegistry({
        providerFile,
        fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
      }),
      /duplicate provider target id/
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

test("live execution rejects static target fallbacks", async () => {
  const executionServer = createServer({
    targetRegistry: createTargetRegistry([{
      id: "static-live-target",
      mode: "local",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 1
    }]),
    executionEnabled: true,
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
          steps: [{ id: "static-live-step", targetId: "static-live-target" }]
        }
      })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.receipts[0].errorClass, "execution_adapter_dry_run_only");
  } finally {
    await new Promise(resolve => executionServer.close(resolve));
  }
});



test("scoped API keys enforce route permissions", async () => {
  const authorizer = createScopedAuthorizer({
    keys: [
      { id: "reader", secret: "reader-secret", scopes: ["read"] },
      { id: "decider", secret: "decider-secret", scopes: ["decide", "telemetry"] },
      { id: "executor", secret: "executor-secret", scopes: ["execute", "read"] }
    ]
  });

  const scopedServer = createServer({ authorizer });
  await new Promise(resolve => scopedServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + scopedServer.address().port;

  try {
    const read = await fetch(url + "/v1/policies", {
      headers: { authorization: "Bearer reader-secret" }
    });
    assert.equal(read.status, 200);

    const readDecide = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: {
        authorization: "Bearer reader-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workload: { type: "classification" },
        targets: [{ id: "x", mode: "local" }]
      })
    });
    assert.equal(readDecide.status, 403);
    assert.deepEqual(await readDecide.json(), { error: "insufficient_scope" });

    const decide = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: {
        authorization: "Bearer decider-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workload: { type: "classification" },
        targets: [{
          id: "decider-target",
          mode: "local",
          health: 1,
          capacity: 0.1,
          privacy: 1,
          estimatedLatencyMs: 25,
          estimatedCostUsd: 0
        }]
      })
    });
    assert.equal(decide.status, 200);

    const targetRead = await fetch(url + "/v1/targets", {
      headers: { authorization: "Bearer decider-secret" }
    });
    assert.equal(targetRead.status, 403);
    assert.deepEqual(await targetRead.json(), { error: "insufficient_scope" });

    const outcome = await fetch(url + "/v1/outcomes", {
      method: "POST",
      headers: {
        authorization: "Bearer decider-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        decisionId: "missing",
        outcome: "failure"
      })
    });
    assert.equal(outcome.status, 404);
  } finally {
    await new Promise(resolve => scopedServer.close(resolve));
  }
});

test("live execution requires execute scope even when execution is enabled", async () => {
  const authorizer = createScopedAuthorizer({
    keys: [
      { id: "reader", secret: "reader-secret", scopes: ["read"] },
      { id: "executor", secret: "executor-secret", scopes: ["execute"] }
    ]
  });

  const executionRegistry = createExecutionRegistry([{
    id: "live",
    targetId: "live-target",
    async execute() {
      return { status: "ok" };
    }
  }]);

  const scopedServer = createServer({
    authorizer,
    executionEnabled: true,
    executionRegistry
  });
  await new Promise(resolve => scopedServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + scopedServer.address().port;

  const plan = {
    valid: true,
    steps: [{ id: "step-1", targetId: "live-target", purpose: "inference" }]
  };

  try {
    const denied = await fetch(url + "/v1/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer reader-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ plan, mode: "live" })
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "insufficient_scope" });

    const allowed = await fetch(url + "/v1/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer executor-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ plan, mode: "live" })
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.status, "completed");
    assert.equal(body.receipts[0].adapterId, "live");
  } finally {
    await new Promise(resolve => scopedServer.close(resolve));
  }
});

test("provider config replaces a persisted target snapshot on bootstrap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-rehydrate-"));
  const targetFile = path.join(dir, "targets.json");
  const providerFile = path.join(dir, "providers.json");

  try {
    await writeFile(targetFile, JSON.stringify({
      version: 1,
      tenants: {
        default: [{
          id: "provider-target",
          mode: "cloud",
          available: false,
          health: 0,
          capacity: 1,
          privacy: 0.2,
          estimatedLatencyMs: 900,
          estimatedCostUsd: 0.1
        }]
      }
    }), "utf8");

    await writeFile(providerFile, JSON.stringify({
      providers: [{
        id: "provider-target",
        targetId: "provider-target",
        type: "openai-compatible",
        mode: "cloud",
        baseUrl: "https://inference.example.com",
        apiKeyEnv: "PROVIDER_KEY",
        model: "demo-model"
      }]
    }), "utf8");

    const registry = await createConfiguredTargetRegistry({
      targetFile,
      providerFile,
      env: { PROVIDER_KEY: "secret" },
      fetchImpl: async () => new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    });

    assert.equal(registry.forTenant("default").has("provider-target"), true);
    const snapshot = await registry.forTenant("default").probe("provider-target");
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.health, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server provider config loads native Anthropic adapter into the tenant target registry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-anthropic-bootstrap-"));
  const file = path.join(dir, "providers.json");

  try {
    await writeFile(file, JSON.stringify({
      providers: [{
        id: "bootstrap-anthropic",
        targetId: "bootstrap-anthropic",
        type: "anthropic",
        mode: "cloud",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        tenantId: "acme",
        model: "claude-opus-5"
      }]
    }), "utf8");

    const registry = await createConfiguredTargetRegistry({
      providerFile: file,
      env: { ANTHROPIC_API_KEY: "secret" },
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ id: "claude-opus-5", max_input_tokens: 200000 }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });

    assert.equal(registry.forTenant("acme").has("bootstrap-anthropic"), true);
    assert.equal(registry.forTenant("default").has("bootstrap-anthropic"), false);

    const snapshot = await registry.forTenant("acme").probe("bootstrap-anthropic");
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.maxContextTokens, 200000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server provider config loads native Ollama adapter into the target registry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-ollama-bootstrap-"));
  const file = path.join(dir, "providers.json");

  try {
    await writeFile(file, JSON.stringify({
      providers: [{
        id: "bootstrap-ollama",
        targetId: "bootstrap-ollama",
        type: "ollama",
        mode: "local",
        baseUrl: "http://localhost:11434/api",
        model: "llama3.2"
      }]
    }), "utf8");

    const registry = await createConfiguredTargetRegistry({
      providerFile: file,
      env: {},
      fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    });

    assert.equal(registry.has("bootstrap-ollama"), true);
    const snapshot = await registry.probe("bootstrap-ollama");
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.mode, "local");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("readiness endpoint reports public service readiness", async () => {
  const response = await fetch(baseUrl + "/ready");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ready",
    service: "locd-api",
    version: "0.1.0"
  });
});

test("status endpoint exposes explicit backend capability metadata", async () => {
  const server = createServer({ serviceVersion: "contract-test" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;

  try {
    const response = await fetch(url + "/v1/status");
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.stateBackend.kind, "process-local");
    assert.equal(body.stateBackend.telemetry.durable, false);
    assert.equal(body.stateBackend.telemetry.tenantScoped, true);
    assert.equal(body.stateBackend.coordination, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("server rejects invalid telemetry backends at construction time", () => {
  assert.throws(
    () => createServer({
      decisionStore: {
        record() {},
        recordOutcome() {},
        list() {},
        summary() {}
      }
    }),
    /decisionStore is missing methods: clear/
  );
});

test("status endpoint exposes safe operational counts", async () => {
  const probeable = {
    id: "ops-probeable",
    targetId: "ops-probeable",
    async getSnapshot() {
      return {
        id: "ops-probeable",
        mode: "local",
        available: true,
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 10,
        estimatedCostUsd: 0
      };
    },
    async probe() {
      return {
        id: "ops-probeable",
        mode: "local",
        available: true,
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 10,
        estimatedCostUsd: 0
      };
    },
    async execute() {
      return { ok: true };
    }
  };

  const staticOnly = {
    id: "ops-static",
    mode: "cloud",
    health: 1,
    capacity: 0.2,
    privacy: 0.1
  };

  const targetRegistry = createTargetRegistry([probeable, staticOnly]);
  const executionRegistry = createExecutionRegistry([probeable]);
  const opsServer = createServer({ targetRegistry, executionRegistry });

  await new Promise(resolve => opsServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + opsServer.address().port;

  try {
    const response = await fetch(url + "/v1/status");
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.counts.targets, 2);
    assert.equal(body.counts.probeableTargets, 1);
    assert.equal(body.counts.executionAdapters, 1);
    assert.equal(typeof body.capabilities.executionEnabled, "boolean");
    assert.equal("apiKey" in body, false);
  } finally {
    await new Promise(resolve => opsServer.close(resolve));
  }
});

test("status endpoint respects read authorization scope", async () => {
  const scopedServer = createServer({
    authorizer: createScopedAuthorizer({
      keys: [{ id: "reader", secret: "reader-secret", scopes: ["read"] }]
    })
  });
  await new Promise(resolve => scopedServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + scopedServer.address().port;

  try {
    const allowed = await fetch(url + "/v1/status", {
      headers: { authorization: "Bearer reader-secret" }
    });
    assert.equal(allowed.status, 200);

    const denied = await fetch(url + "/v1/status", {
      headers: { authorization: "Bearer wrong-secret" }
    });
    assert.equal(denied.status, 401);
  } finally {
    await new Promise(resolve => scopedServer.close(resolve));
  }
});

test("graceful shutdown stops scheduler and closes the server only once", async () => {
  const events = [];
  const server = http.createServer((req, res) => res.end("ok"));
  const scheduler = {
    stopped: false,
    stop() {
      this.stopped = true;
      events.push("scheduler_stop");
    }
  };
  const logger = {
    info(event) {
      events.push(event.event);
    }
  };

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const shutdown = createGracefulShutdown({ server, probeScheduler: scheduler, logger });

  assert.equal(await shutdown("SIGTERM"), true);
  assert.equal(await shutdown("SIGTERM"), false);
  assert.equal(scheduler.stopped, true);
  assert.deepEqual(events, [
    "shutdown_started",
    "scheduler_stop",
    "shutdown_complete"
  ]);
});


test("API calibration improves estimates after observed outcomes", async () => {
  const calibrator = createCalibrator({
    minSamples: 1,
    alpha: 1,
    minFactor: 0.25,
    maxFactor: 4
  });
  const calibrationServer = createServer({
    calibrator,
    calibrationEnabled: true
  });

  await new Promise(resolve => calibrationServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + calibrationServer.address().port;

  try {
    const request = {
      workload: { type: "calibration-test", sensitivity: "low" },
      targets: [{
        id: "calibration-target",
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.01
      }]
    };

    const first = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.estimated.latencyMs, 100);
    assert.deepEqual(firstBody.calibration.adjustedTargetIds, []);

    const outcome = await fetch(url + "/v1/outcomes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "calibration-outcome-1"
      },
      body: JSON.stringify({
        decisionId: firstBody.decisionId,
        outcome: "success",
        actualLatencyMs: 200,
        actualCostUsd: 0.02
      })
    });
    assert.equal(outcome.status, 200);

    const second = await fetch(url + "/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.estimated.latencyMs, 200);
    assert.equal(secondBody.estimated.costUsd, 0.02);
    assert.deepEqual(secondBody.calibration.adjustedTargetIds, ["calibration-target"]);

    const state = await fetch(url + "/v1/calibration");
    assert.equal(state.status, 200);
    const stateBody = await state.json();
    assert.equal(stateBody.enabled, true);
    assert.equal(stateBody.entries[0].samples, 1);
    assert.equal(stateBody.entries[0].latencyFactor, 2);
  } finally {
    await new Promise(resolve => calibrationServer.close(resolve));
  }
});

test("API calibration rehydrates from durable telemetry without double counting", async () => {
  const telemetryDir = await mkdtemp(path.join(os.tmpdir(), "locd-calibration-hydrate-"));
  const telemetryFile = path.join(telemetryDir, "events.json");

  try {
    const store = createFileDecisionStore({ filePath: telemetryFile, maxEntries: 100 });
    store.record({
      id: "hydration-event",
      route: "local",
      targetId: "hydrate-target",
      workloadType: "hydrate-test",
      estimatedLatencyMs: 100,
      estimatedCostUsd: 0.01,
      confidence: 0.9,
      outcome: "success",
      actualLatencyMs: 150,
      actualCostUsd: 0.015
    });
    await new Promise(resolve => setTimeout(resolve, 1));

    const calibrator = createCalibrator({
      minSamples: 1,
      alpha: 1
    });
    const hydrationServer = createServer({
      decisionStore: createFileDecisionStore({ filePath: telemetryFile, maxEntries: 100 }),
      calibrator,
      calibrationEnabled: true
    });

    await new Promise(resolve => hydrationServer.listen(0, "127.0.0.1", resolve));
    try {
      const state = await fetch("http://127.0.0.1:" + hydrationServer.address().port + "/v1/calibration");
      assert.equal(state.status, 200);
      const body = await state.json();
      assert.equal(body.entries[0].samples, 1);
      assert.equal(body.entries[0].latencyFactor, 1.5);
    } finally {
      await new Promise(resolve => hydrationServer.close(resolve));
    }
  } finally {
    await rm(telemetryDir, { recursive: true, force: true });
  }
});


test("two API instances can share coordination state through an async coordination backend", async () => {
  const coordination = createInMemoryCoordinationStore();
  const serverA = createServer({
    coordinationStore: coordination,
    rateLimitMaxRequests: 1,
    rateLimitWindowMs: 60_000
  });
  const serverB = createServer({
    coordinationStore: coordination,
    rateLimitMaxRequests: 1,
    rateLimitWindowMs: 60_000
  });

  await Promise.all([
    new Promise(resolve => serverA.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => serverB.listen(0, "127.0.0.1", resolve))
  ]);

  const urlA = "http://127.0.0.1:" + serverA.address().port;
  const urlB = "http://127.0.0.1:" + serverB.address().port;

  try {
    const first = await fetch(urlA + "/v1/metrics", {
      headers: { "x-request-id": "coord-a" }
    });
    assert.equal(first.status, 200);

    const second = await fetch(urlB + "/v1/metrics", {
      headers: { "x-request-id": "coord-b" }
    });
    assert.equal(second.status, 429);
  } finally {
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
  }
});

test("two API instances share idempotency responses through the same backend", async () => {
  const coordination = createInMemoryCoordinationStore();
  const serverA = createServer({ coordinationStore: coordination });
  const serverB = createServer({ coordinationStore: coordination });

  await Promise.all([
    new Promise(resolve => serverA.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => serverB.listen(0, "127.0.0.1", resolve))
  ]);

  const urlA = "http://127.0.0.1:" + serverA.address().port;
  const urlB = "http://127.0.0.1:" + serverB.address().port;
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "shared-idem"
  };
  const body = JSON.stringify({
    workload: { type: "classification", sensitivity: "low" },
    targets: [{
      id: "shared-idem-target",
      mode: "local",
      health: 1,
      capacity: 0.1,
      privacy: 1,
      estimatedLatencyMs: 25,
      estimatedCostUsd: 0
    }]
  });

  try {
    const first = await fetch(urlA + "/v1/decide", {
      method: "POST",
      headers,
      body
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();

    const second = await fetch(urlB + "/v1/decide", {
      method: "POST",
      headers,
      body
    });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("idempotency-replayed"), "true");
    assert.equal((await second.json()).decisionId, firstBody.decisionId);
  } finally {
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
  }
});


test("status endpoint reports shared coordination mode", async () => {
  const coordination = createInMemoryCoordinationStore();
  const statusServer = createServer({ coordinationStore: coordination });

  await new Promise(resolve => statusServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + statusServer.address().port;

  try {
    const response = await fetch(url + "/v1/status");
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.capabilities.sharedCoordination, true);
    assert.equal(body.capabilities.rateLimitMode, "shared");
    assert.equal(body.capabilities.idempotencyMode, "shared");
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
  }
});

test("SQLite state can back multiple API instances for telemetry and coordination", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-api-sqlite-state-"));
  const file = path.join(dir, "state.db");
  const stateA = createSQLiteStateStores({ filePath: file, maxEntries: 100 });
  const stateB = createSQLiteStateStores({ filePath: file, maxEntries: 100 });

  const serverA = createServer({
    decisionStore: stateA.telemetry,
    coordinationStore: stateA.coordination,
    rateLimitMaxRequests: 1,
    rateLimitWindowMs: 60_000,
    trustProxy: true
  });
  const serverB = createServer({
    decisionStore: stateB.telemetry,
    coordinationStore: stateB.coordination,
    rateLimitMaxRequests: 1,
    rateLimitWindowMs: 60_000,
    trustProxy: true
  });

  await Promise.all([
    new Promise(resolve => serverA.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => serverB.listen(0, "127.0.0.1", resolve))
  ]);

  const urlA = "http://127.0.0.1:" + serverA.address().port;
  const urlB = "http://127.0.0.1:" + serverB.address().port;

  try {
    const firstMetric = await fetch(urlA + "/v1/metrics");
    assert.equal(firstMetric.status, 200);

    const rateLimited = await fetch(urlB + "/v1/metrics");
    assert.equal(rateLimited.status, 429);

    // Clear coordination budget through a fresh DB bucket by using a new client identity.
    const headers = { "x-forwarded-for": "203.0.113.50" };
    const decisionBody = JSON.stringify({
      workload: { type: "sqlite-shared", sensitivity: "low" },
      targets: [{
        id: "sqlite-api-target",
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 20,
        estimatedCostUsd: 0
      }]
    });

    // The first request consumes the new client's shared budget.
    const firstDecision = await fetch(urlA + "/v1/decide", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "sqlite-shared-key"
      },
      body: decisionBody
    });
    assert.equal(firstDecision.status, 200);
    const firstBody = await firstDecision.json();

    // Use another client identity for the replay; idempotency storage is key-scoped
    // and still shared regardless of which API instance receives it.
    const replay = await fetch(urlB + "/v1/decide", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.51",
        "content-type": "application/json",
        "idempotency-key": "sqlite-shared-key"
      },
      body: decisionBody
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal((await replay.json()).decisionId, firstBody.decisionId);

    const history = await fetch(urlB + "/v1/decisions?limit=10", {
      headers: { "x-forwarded-for": "203.0.113.52" }
    });
    assert.equal(history.status, 200);
    assert.equal((await history.json()).decisions.length, 1);
  } finally {
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
    stateA.close();
    stateB.close();
    await rm(dir, { recursive: true, force: true });
  }
});



test("two LOCD API instances can coordinate through network State Service", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-network-state-"));
  const file = path.join(dir, "state.db");
  const stores = createSQLiteStateStores({ filePath: file, maxEntries: 100 });
  const stateServer = createStateServiceServer({
    stores,
    apiKey: "network-secret"
  });

  await new Promise(resolve => stateServer.listen(0, "127.0.0.1", resolve));
  const stateUrl = "http://127.0.0.1:" + stateServer.address().port;
  const sharedA = createHTTPCoordinationStore({
    baseUrl: stateUrl,
    apiKey: "network-secret"
  });
  const sharedB = createHTTPCoordinationStore({
    baseUrl: stateUrl,
    apiKey: "network-secret"
  });

  const serverA = createServer({
    coordinationStore: sharedA,
    rateLimitMaxRequests: 1,
    rateLimitWindowMs: 60_000,
    trustProxy: true
  });
  const serverB = createServer({
    coordinationStore: sharedB,
    rateLimitMaxRequests: 1,
    rateLimitWindowMs: 60_000,
    trustProxy: true
  });

  await Promise.all([
    new Promise(resolve => serverA.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => serverB.listen(0, "127.0.0.1", resolve))
  ]);

  const urlA = "http://127.0.0.1:" + serverA.address().port;
  const urlB = "http://127.0.0.1:" + serverB.address().port;

  try {
    const first = await fetch(urlA + "/v1/metrics", {
      headers: { "x-forwarded-for": "198.51.100.11" }
    });
    assert.equal(first.status, 200);

    const second = await fetch(urlB + "/v1/metrics", {
      headers: { "x-forwarded-for": "198.51.100.11" }
    });
    assert.equal(second.status, 429);
  } finally {
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve)),
      new Promise(resolve => stateServer.close(resolve))
    ]);
    stores.close();
    await rm(dir, { recursive: true, force: true });
  }

});


test("network State Service can provide shared telemetry across API instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-network-telemetry-"));
  const file = path.join(dir, "state.db");
  const stateStores = createSQLiteStateStores({ filePath: file, maxEntries: 100 });
  const stateServer = createStateServiceServer({
    stores: stateStores,
    apiKey: "telemetry-secret"
  });

  await new Promise(resolve => stateServer.listen(0, "127.0.0.1", resolve));
  const stateUrl = "http://127.0.0.1:" + stateServer.address().port;

  const stateA = createHTTPStateStores({
    baseUrl: stateUrl,
    apiKey: "telemetry-secret",
    maxEntries: 100
  });
  const stateB = createHTTPStateStores({
    baseUrl: stateUrl,
    apiKey: "telemetry-secret",
    maxEntries: 100
  });

  const serverA = createServer({
    decisionStore: stateA.telemetry,
    coordinationStore: stateA.coordination,
    calibrationEnabled: false,
    rateLimitMaxRequests: 100
  });
  const serverB = createServer({
    decisionStore: stateB.telemetry,
    coordinationStore: stateB.coordination,
    calibrationEnabled: false,
    rateLimitMaxRequests: 100
  });

  await Promise.all([
    new Promise(resolve => serverA.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => serverB.listen(0, "127.0.0.1", resolve))
  ]);

  const urlA = "http://127.0.0.1:" + serverA.address().port;
  const urlB = "http://127.0.0.1:" + serverB.address().port;

  try {
    const decision = await fetch(urlA + "/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workload: {
          type: "network-telemetry",
          sensitivity: "low"
        },
        targets: [{
          id: "network-telemetry-target",
          mode: "local",
          health: 1,
          capacity: 0.1,
          privacy: 1,
          estimatedLatencyMs: 100,
          estimatedCostUsd: 0.01
        }]
      })
    });

    assert.equal(decision.status, 200);
    const decisionBody = await decision.json();

    const history = await fetch(urlB + "/v1/decisions?limit=10");
    assert.equal(history.status, 200);
    const decisions = await history.json();
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].id, decisionBody.decisionId);

    const outcome = await fetch(urlB + "/v1/outcomes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisionId: decisionBody.decisionId,
        outcome: "success",
        actualLatencyMs: 125,
        actualCostUsd: 0.012
      })
    });
    assert.equal(outcome.status, 200);

    const metrics = await fetch(urlA + "/v1/metrics");
    assert.equal(metrics.status, 200);
    const metricBody = await metrics.json();
    assert.equal(metricBody.successRate, 1);
    assert.equal(metricBody.meanAbsoluteLatencyErrorMs, 25);
  } finally {
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve)),
      new Promise(resolve => stateServer.close(resolve))
    ]);
    stateStores.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("decision feedback records target utilization for calibration", async () => {
  const response = await fetch(baseUrl + "/v1/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [{
        id: "utilization-target",
        mode: "local",
        health: 1,
        capacity: 0.82,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0
      }]
    })
  });

  assert.equal(response.status, 200);
  const body = await response.json();

  const history = await (await fetch(baseUrl + "/v1/decisions?limit=1")).json();
  const event = history.decisions[0];
  assert.equal(event.id, body.decisionId);
  assert.equal(event.targetUtilization, 0.82);
});

test("concurrent identical idempotency keys reject the in-progress duplicate", async () => {
  const decisionStore = {
    async record(event) {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { ...event, id: "decision-concurrency-1" };
    },
    async recordOutcome() {
      throw new Error("not used");
    },
    async list() {
      return [];
    },
    async summary() {
      return { totalDecisions: 0 };
    },
    async clear() {}
  };

  const scopedServer = createServer({
    decisionStore,
    idempotencyLockTtlMs: 5000
  });
  await new Promise(resolve => scopedServer.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + scopedServer.address().port;

  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "concurrent-key"
    },
    body: JSON.stringify({
      workload: { type: "classification", sensitivity: "low" },
      targets: [{
        id: "concurrent-target",
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 10,
        estimatedCostUsd: 0
      }]
    })
  };

  try {
    const [first, second] = await Promise.all([
      fetch(url + "/v1/decide", request),
      fetch(url + "/v1/decide", request)
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const conflict = first.status === 409 ? first : second;
    assert.deepEqual(await conflict.json(), {
      error: "idempotency_request_in_progress"
    });

    const success = first.status === 200 ? first : second;
    assert.equal((await success.json()).decisionId, "decision-concurrency-1");
  } finally {
    await new Promise(resolve => scopedServer.close(resolve));
  }
});

test("invalid idempotency lock TTL fails at server creation", () => {
  assert.throws(
    () => createServer({ idempotencyLockTtlMs: 0 }),
    /idempotencyLockTtlMs must be >= 1/
  );
});
