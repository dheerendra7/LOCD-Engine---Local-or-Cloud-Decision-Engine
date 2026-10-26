import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaAdapter } from "../src/index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("local Ollama defaults to localhost native API", async () => {
  const calls = [];
  const adapter = createOllamaAdapter({
    id: "ollama",
    targetId: "ollama-local",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ models: [] });
    }
  });

  const snapshot = await adapter.probe();
  assert.equal(snapshot.mode, "local");
  assert.equal(snapshot.available, true);
  assert.equal(calls[0].url, "http://localhost:11434/api/tags");
});

test("remote HTTP requires explicit opt-in", () => {
  assert.throws(
    () => createOllamaAdapter({
      id: "remote",
      targetId: "remote",
      mode: "private",
      baseUrl: "http://10.0.0.10:11434/api"
    }),
    /insecure remote HTTP/
  );
});

test("cloud Ollama sends bearer auth to native API", async () => {
  const calls = [];
  const adapter = createOllamaAdapter({
    id: "ollama-cloud",
    targetId: "ollama-cloud",
    mode: "cloud",
    baseUrl: "https://ollama.com/api",
    apiKey: "ollama-secret",
    model: "gemma4:31b",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        model: "gemma4:31b",
        message: { role: "assistant", content: "hello" },
        done: true
      });
    }
  });

  const result = await adapter.execute({
    payload: {
      messages: [{ role: "user", content: "hello" }]
    }
  });

  assert.equal(result.message.content, "hello");
  assert.equal(calls[0].url, "https://ollama.com/api/chat");
  assert.equal(calls[0].options.headers.authorization, "Bearer ollama-secret");
  assert.equal(JSON.parse(calls[0].options.body).stream, false);
});

test("execute requires a model", async () => {
  const adapter = createOllamaAdapter({
    id: "ollama",
    targetId: "ollama",
    fetchImpl: async () => jsonResponse({})
  });

  await assert.rejects(
    () => adapter.execute({
      payload: { messages: [] }
    }),
    /requires a model/
  );
});

test("probe failures update availability and error metadata", async () => {
  const adapter = createOllamaAdapter({
    id: "broken",
    targetId: "broken",
    fetchImpl: async () => jsonResponse({}, 500)
  });

  const snapshot = await adapter.probe();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.errorClass, "probe_http_500");
});

test("probe timeouts are classified", async () => {
  const adapter = createOllamaAdapter({
    id: "slow",
    targetId: "slow",
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


test("Ollama provider leaves unspecified latency and capacity telemetry unknown", async () => {
  const adapter = createOllamaAdapter({
    id: "unknown-metrics",
    targetId: "unknown-metrics"
  });

  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
});


test("explicitly unknown Ollama cost does not fall back to zero", async () => {
  const adapter = createOllamaAdapter({
    id: "unknown-cost",
    targetId: "unknown-cost",
    initial: {
      estimatedCostUsd: null,
      estimatedLatencyMs: " ",
      capacity: " ",
      availableMemoryGb: " ",
      maxContextTokens: " "
    }
  });
  const snapshot = await adapter.getSnapshot();

  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.capacity, 1);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
});

test("whitespace Ollama cost configuration is unknown instead of zero", async () => {
  const adapter = createOllamaAdapter({
    id: "blank-cost",
    targetId: "blank-cost",
    estimatedCostUsd: " "
  });
  assert.equal((await adapter.getSnapshot()).estimatedCostUsd, null);
});


test("negative Ollama estimates stay unknown and negative capacity uses safe defaults", async () => {
  const adapter = createOllamaAdapter({
    id: "negative-metrics",
    targetId: "negative-metrics",
    estimatedCostUsd: -1,
    initial: {
      estimatedCostUsd: -2,
      estimatedLatencyMs: -1,
      availableMemoryGb: -1,
      maxContextTokens: -1,
      health: -1,
      capacity: -1,
      privacy: -1
    }
  });
  const snapshot = await adapter.getSnapshot();

  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.capacity, 1);
  assert.equal(snapshot.privacy, 1);
});


test("Ollama adapter rejects disabled or malformed request timeouts", () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, "5000", null]) {
    assert.throws(
      () => createOllamaAdapter({
        id: "bad-timeout",
        targetId: "bad-timeout",
        timeoutMs
      }),
      /timeoutMs must be a positive finite number/
    );
  }
});
