import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, getClientKey } from "../src/rate-limit.js";

test("disabled limiter allows unlimited requests without storing state", () => {
  const limiter = createRateLimiter({ maxRequests: 0 });
  assert.equal(limiter.enabled, false);
  assert.equal(limiter.consume("a").allowed, true);
  assert.equal(limiter.size(), 0);
});

test("enabled limiter blocks after configured request count", () => {
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000 });
  const first = limiter.consume("a", 100);
  const second = limiter.consume("a", 200);
  const third = limiter.consume("a", 300);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.equal(third.resetAt, 1100);
});

test("limiter resets after the window", () => {
  const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
  assert.equal(limiter.consume("a", 100).allowed, true);
  assert.equal(limiter.consume("a", 500).allowed, false);
  assert.equal(limiter.consume("a", 1100).allowed, true);
});

test("different keys have independent budgets", () => {
  const limiter = createRateLimiter({ maxRequests: 1 });
  assert.equal(limiter.consume("a", 1).allowed, true);
  assert.equal(limiter.consume("a", 2).allowed, false);
  assert.equal(limiter.consume("b", 2).allowed, true);
});

test("trusted proxy mode uses first forwarded address", () => {
  const req = {
    headers: { "x-forwarded-for": "198.51.100.10, 10.0.0.1" },
    socket: { remoteAddress: "10.0.0.2" }
  };
  assert.equal(getClientKey(req, { trustProxy: true }), "198.51.100.10");
  assert.equal(getClientKey(req), "10.0.0.2");
});

test("invalid limiter configuration fails clearly", () => {
  assert.throws(() => createRateLimiter({ maxRequests: -1 }), /maxRequests must be >= 0/);
  assert.throws(() => createRateLimiter({ windowMs: 0 }), /windowMs must be >= 1/);
});
