import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatibleAdapter } from "../src/index.js";
import { createTargetRegistry } from "../../registry/src/index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("adapter rejects insecure remote HTTP by default", () => {
  assert.throws(
    () => createOpenAICompatibleAdapter({
      id: "remote",
      targetId: "remote",
      baseUrl: "http://example.com"
    }),
    /insecure remote HTTP/
  );
});

test("localhost HTTP is allowed for local providers", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "ollama-like",
    targetId: "local-1",
    baseUrl: "http://localhost:11434",
    mode: "local",
    fetchImpl: async () => jsonResponse({ data: [] })
  });

  assert.equal((await adapter.getSnapshot()).mode, "local");
});

test("probe marks a healthy target and records latency", async () => {
  const calls = [];
  const adapter = createOpenAICompatibleAdapter({
    id: "vllm",
    targetId: "private-vllm",
    baseUrl: "https://inference.example.com",
    mode: "private",
    apiKey: "secret-not-logged",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ object: "list", data: [] });
    }
  });

  const snapshot = await adapter.probe();

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.health, 1);
  assert.equal(typeof snapshot.estimatedLatencyMs, "number");
  assert.match(snapshot.lastHeartbeatAt, /^202/);
  assert.equal(calls[0].url, "https://inference.example.com/v1/models");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-not-logged");
});

test("probe classifies unauthorized/unhealthy responses", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "bad",
    targetId: "bad-target",
    baseUrl: "https://inference.example.com",
    fetchImpl: async () => jsonResponse({}, 401)
  });

  const snapshot = await adapter.probe();

  assert.equal(snapshot.available, false);
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.errorClass, "probe_http_401");
});

test("probe classifies timeouts", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "slow",
    targetId: "slow-target",
    baseUrl: "https://slow.example.com",
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
  });

  const snapshot = await adapter.probe();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.errorClass, "probe_timeout");
});

test("execute uses OpenAI-compatible chat completion endpoint", async () => {
  const calls = [];
  const adapter = createOpenAICompatibleAdapter({
    id: "provider",
    targetId: "provider-target",
    baseUrl: "https://inference.example.com",
    apiKey: "secret",
    model: "demo-model",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        id: "chatcmpl-1",
        choices: [{ message: { role: "assistant", content: "hello" } }]
      });
    }
  });

  const result = await adapter.execute({
    payload: {
      messages: [{ role: "user", content: "hello" }]
    },
    mode: "live"
  });

  assert.equal(result.choices[0].message.content, "hello");
  assert.equal(calls[0].url, "https://inference.example.com/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0].options.body).model, "demo-model");
});

test("execute refuses dry-run mode", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "provider",
    targetId: "target",
    baseUrl: "https://inference.example.com",
    fetchImpl: async () => jsonResponse({})
  });

  await assert.rejects(
    () => adapter.execute({ payload: {}, mode: "dry-run" }),
    /requires live mode/
  );
});

test("provider adapter rejects invalid target modes", () => {
  assert.throws(
    () => createOpenAICompatibleAdapter({
      id: "bad-mode",
      targetId: "bad-mode",
      baseUrl: "https://inference.example.com",
      mode: "satellite"
    }),
    /mode must be local, private, cloud or hybrid/
  );
});

test("probe error metadata survives snapshot normalization", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "unauthorized",
    targetId: "unauthorized",
    baseUrl: "https://inference.example.com",
    fetchImpl: async () => jsonResponse({}, 503)
  });

  const snapshot = await adapter.probe();
  assert.equal(snapshot.errorClass, "probe_http_503");
  assert.equal((await adapter.getSnapshot()).errorClass, "probe_http_503");
});

test("OpenAI-compatible provider preserves configured pricing", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "priced-provider",
    targetId: "priced-provider",
    baseUrl: "https://inference.example.com",
    pricing: {
      unit: "per-1k-tokens",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.012
    }
  });

  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.pricing.inputUsdPer1kTokens, 0.003);
  assert.equal(snapshot.pricing.outputUsdPer1kTokens, 0.012);
});


test("OpenAI-compatible provider keeps unspecified cost and capacity telemetry unknown", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "unknown-metrics",
    targetId: "unknown-metrics",
    baseUrl: "https://inference.example.com",
    pricing: {
      unit: "per-1k-tokens",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.012
    }
  });

  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
  assert.equal(snapshot.pricing.inputUsdPer1kTokens, 0.003);
});


test("registry does not turn unknown provider cost into a free target", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "unpriced-provider",
    targetId: "unpriced-provider",
    baseUrl: "https://inference.example.com",
    pricing: {
      unit: "per-1k-tokens",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.012
    }
  });
  const registry = createTargetRegistry([adapter]);
  const [target] = await registry.list();

  assert.equal(target.estimatedCostUsd, null);
  assert.equal(target.estimatedLatencyMs, null);
  assert.equal(target.pricing.unit, "per-1k-tokens");
  assert.equal(target.pricing.inputUsdPer1kTokens, 0.003);
});


test("blank cost and telemetry values do not become numeric zero", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "blank-metrics",
    targetId: "blank-metrics",
    baseUrl: "https://inference.example.com",
    estimatedCostUsd: " ",
    initial: {
      health: " ",
      capacity: " ",
      privacy: " ",
      estimatedLatencyMs: " ",
      availableMemoryGb: " ",
      maxContextTokens: " "
    },
    pricing: {
      unit: "per-1k-tokens",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.012
    }
  });
  const snapshot = await adapter.getSnapshot();

  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.capacity, 1);
  assert.equal(snapshot.privacy, 0);
});


test("negative estimates and capacity telemetry remain unknown or use safe defaults", async () => {
  const adapter = createOpenAICompatibleAdapter({
    id: "negative-metrics",
    targetId: "negative-metrics",
    baseUrl: "https://inference.example.com",
    estimatedCostUsd: -1,
    initial: {
      health: -1,
      capacity: -1,
      privacy: -1,
      estimatedLatencyMs: -1,
      availableMemoryGb: -1,
      maxContextTokens: -1
    },
    pricing: {
      unit: "per-1k-tokens",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.012
    }
  });
  const snapshot = await adapter.getSnapshot();

  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.capacity, 1);
  assert.equal(snapshot.privacy, 0);
});
