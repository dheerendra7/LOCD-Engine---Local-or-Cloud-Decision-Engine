import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, createRequestId } from "../src/index.js";

test("logger emits structured JSON and includes timestamp", () => {
  const lines = [];
  const logger = createLogger({
    sink: value => lines.push(value),
    clock: () => new Date("2026-10-01T00:00:00Z")
  });

  logger.info({ event: "request_complete", requestId: "req-1", status: 200 });

  const event = JSON.parse(lines[0]);
  assert.deepEqual(event, {
    timestamp: "2026-10-01T00:00:00.000Z",
    level: "info",
    event: "request_complete",
    requestId: "req-1",
    status: 200
  });
});

test("sensitive fields are redacted recursively", () => {
  const lines = [];
  const logger = createLogger({
    sink: value => lines.push(value)
  });

  logger.info({
    headers: {
      Authorization: "Bearer secret",
      "X-LOCD-API-Key": "abc",
      "content-type": "application/json"
    },
    nested: {
      token: "do-not-log"
    }
  });

  const event = JSON.parse(lines[0]);
  assert.equal(event.headers.Authorization, "[redacted]");
  assert.equal(event.headers["X-LOCD-API-Key"], "[redacted]");
  assert.equal(event.nested.token, "[redacted]");
  assert.equal(event.headers["content-type"], "application/json");
});

test("long strings are bounded", () => {
  const lines = [];
  const logger = createLogger({ sink: value => lines.push(value) });
  logger.info({ body: "x".repeat(2000) });

  const event = JSON.parse(lines[0]);
  assert.equal(event.body.length, 1001);
  assert.equal(event.body.endsWith("…"), true);
});

test("log levels filter lower-priority events", () => {
  const lines = [];
  const logger = createLogger({ level: "warn", sink: value => lines.push(value) });

  logger.info({ event: "ignored" });
  logger.warn({ event: "kept" });
  logger.error({ event: "kept-error" });

  assert.equal(lines.length, 2);
  assert.match(lines[0], /kept/);
  assert.match(lines[1], /kept-error/);
});

test("request IDs preserve valid caller values and generate fallback IDs", () => {
  assert.equal(createRequestId("req-123"), "req-123");
  assert.match(createRequestId("x".repeat(129)), /^[0-9a-f-]{36}$/);
});

test("camelCase API keys are redacted", () => {
  const lines = [];
  const logger = createLogger({ sink: value => lines.push(value) });

  logger.info({ apiKey: "hidden-value" });

  const event = JSON.parse(lines[0]);
  assert.equal(event.apiKey, "[redacted]");
});
