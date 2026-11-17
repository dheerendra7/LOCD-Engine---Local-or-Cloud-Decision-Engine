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

test("trusted proxy mode resolves the client from the configured right-side hop", () => {
  const oneProxy = {
    headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.10" },
    socket: { remoteAddress: "10.0.0.2" }
  };
  assert.equal(getClientKey(oneProxy, { trustProxy: true }), "198.51.100.10");
  assert.equal(getClientKey(oneProxy), "10.0.0.2");

  const twoProxies = {
    headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.10, 10.0.0.1" },
    socket: { remoteAddress: "10.0.0.2" }
  };
  assert.equal(getClientKey(twoProxies, { trustProxy: true, trustedProxyHops: 2 }), "198.51.100.10");
});

test("trusted proxy mode falls back to the socket for malformed or short chains", () => {
  const malformed = {
    headers: { "x-forwarded-for": "not-an-ip" },
    socket: { remoteAddress: "10.0.0.2" }
  };
  assert.equal(getClientKey(malformed, { trustProxy: true }), "10.0.0.2");
  assert.equal(getClientKey(malformed, { trustProxy: true, trustedProxyHops: 2 }), "10.0.0.2");

  for (const header of [
    "203.0.113.99, , 198.51.100.10",
    "203.0.113.99, 198.51.100.10, ",
    ", 198.51.100.10"
  ]) {
    assert.equal(
      getClientKey({
        headers: { "x-forwarded-for": header },
        socket: { remoteAddress: "10.0.0.2" }
      }, { trustProxy: true }),
      "10.0.0.2",
      header
    );
  }

  assert.equal(
    getClientKey({
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.10, bad-proxy-ip" },
      socket: { remoteAddress: "10.0.0.2" }
    }, { trustProxy: true, trustedProxyHops: 2 }),
    "10.0.0.2"
  );
});

test("invalid limiter configuration fails clearly", () => {
  assert.throws(() => createRateLimiter({ maxRequests: -1 }), /maxRequests must be >= 0/);
  assert.throws(() => createRateLimiter({ maxRequests: 1.5 }), /safe integer/);
  assert.throws(() => createRateLimiter({ maxRequests: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  assert.throws(() => createRateLimiter({ windowMs: 0 }), /windowMs must be >= 1/);
  assert.throws(() => createRateLimiter({ windowMs: 1.5 }), /safe integer/);
  assert.throws(() => createRateLimiter({ windowMs: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
});

test("invalid clock inputs are rejected before mutating rate-limit state", () => {
  const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });

  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => limiter.consume("client", now),
      /now must be a non-negative safe integer and allow a safe window deadline/
    );
  }

  assert.equal(limiter.size(), 0);
  assert.equal(limiter.consume("client", 100).allowed, true);
});
