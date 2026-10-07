import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicAdapter } from "../src/index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("Anthropic adapter rejects insecure remote HTTP by default", () => {
  assert.throws(
    () => createAnthropicAdapter({
      id: "remote",
      targetId: "remote",
      baseUrl: "http://example.com"
    }),
    /insecure remote HTTP/
  );
});

test("Anthropic probe uses the Models API and required headers", async () => {
  const calls = [];
  const adapter = createAnthropicAdapter({
    id: "anthropic",
    targetId: "anthropic-cloud",
    baseUrl: "https://api.anthropic.com",
    apiKey: "secret-not-logged",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ data: [] });
    }
  });

  const snapshot = await adapter.probe();

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.health, 1);
  assert.equal(typeof snapshot.estimatedLatencyMs, "number");
  assert.match(snapshot.lastHeartbeatAt, /^202/);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  assert.equal(calls[0].options.headers["x-api-key"], "secret-not-logged");
  assert.equal(calls[0].options.headers["anthropic-version"], "2023-06-01");
});

test("Anthropic probe classifies HTTP failures", async () => {
  const adapter = createAnthropicAdapter({
    id: "bad-anthropic",
    targetId: "bad-anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "secret",
    fetchImpl: async () => jsonResponse({}, 401)
  });

  const snapshot = await adapter.probe();

  assert.equal(snapshot.available, false);
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.errorClass, "probe_http_401");
});

test("Anthropic probe classifies timeouts", async () => {
  const adapter = createAnthropicAdapter({
    id: "slow-anthropic",
    targetId: "slow-anthropic",
    baseUrl: "https://api.anthropic.com",
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

test("Anthropic execute uses the Messages API and injects model defaults", async () => {
  const calls = [];
  const adapter = createAnthropicAdapter({
    id: "anthropic-provider",
    targetId: "anthropic-provider",
    baseUrl: "https://api.anthropic.com",
    apiKey: "secret",
    model: "configured-model",
    maxTokens: 2048,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      });
    }
  });

  const result = await adapter.execute({
    payload: {
      messages: [{ role: "user", content: "hello" }]
    },
    mode: "live"
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(result.content[0].text, "hello");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].options.headers["x-api-key"], "secret");
  assert.equal(calls[0].options.headers["anthropic-version"], "2023-06-01");
  assert.equal(body.model, "configured-model");
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.stream, false);
});

test("Anthropic execute preserves explicit model and max_tokens", async () => {
  const calls = [];
  const adapter = createAnthropicAdapter({
    id: "anthropic-provider",
    targetId: "anthropic-provider",
    baseUrl: "https://api.anthropic.com",
    apiKey: "secret",
    model: "configured-model",
    maxTokens: 1024,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ content: [] });
    }
  });

  await adapter.execute({
    payload: {
      model: "caller-model",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hello" }]
    },
    mode: "live"
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "caller-model");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, false);
});

test("Anthropic execute refuses dry-run mode", async () => {
  const adapter = createAnthropicAdapter({
    id: "anthropic-provider",
    targetId: "anthropic-provider",
    baseUrl: "https://api.anthropic.com",
    fetchImpl: async () => jsonResponse({})
  });

  await assert.rejects(
    () => adapter.execute({ payload: {}, mode: "dry-run" }),
    /requires live mode/
  );
});

test("Anthropic execute requires a model", async () => {
  const adapter = createAnthropicAdapter({
    id: "anthropic-provider",
    targetId: "anthropic-provider",
    baseUrl: "https://api.anthropic.com",
    fetchImpl: async () => jsonResponse({})
  });

  await assert.rejects(
    () => adapter.execute({
      payload: {
        messages: [{ role: "user", content: "hello" }]
      },
      mode: "live"
    }),
    /requires a model/
  );
});

test("Anthropic adapter hides API keys and preserves pricing metadata", async () => {
  const adapter = createAnthropicAdapter({
    id: "priced-anthropic",
    targetId: "priced-anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "super-secret",
    pricing: {
      unit: "per-1k-tokens",
      currency: "USD",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.015
    }
  });

  const snapshot = await adapter.getSnapshot();

  assert.equal("apiKey" in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes("super-secret"), false);
  assert.equal(snapshot.pricing.outputUsdPer1kTokens, 0.015);
});
