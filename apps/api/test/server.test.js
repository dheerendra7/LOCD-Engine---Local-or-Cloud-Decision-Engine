import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

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
});
