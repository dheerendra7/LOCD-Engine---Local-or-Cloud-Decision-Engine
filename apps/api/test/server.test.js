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
