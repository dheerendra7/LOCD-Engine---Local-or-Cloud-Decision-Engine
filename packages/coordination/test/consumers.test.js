import test from "node:test";
import assert from "node:assert/strict";
import {
  createCoordinatedFixedWindowRateLimiter,
  createCoordinatedIdempotencyStore,
  createInMemoryCoordinationStore
} from "../src/index.js";

test("setIfAbsent claims only the first writer", async () => {
  const store = createInMemoryCoordinationStore();
  assert.equal(await store.setIfAbsent("lock", { owner: 1 }), true);
  assert.equal(await store.setIfAbsent("lock", { owner: 2 }), false);
  assert.deepEqual(await store.get("lock"), { owner: 1 });
});

test("coordinated rate limiter shares the fixed window through the backend", async () => {
  const store = createInMemoryCoordinationStore();
  const one = createCoordinatedFixedWindowRateLimiter({
    store,
    maxRequests: 2,
    windowMs: 1000,
    namespace: "test-rate"
  });
  const two = createCoordinatedFixedWindowRateLimiter({
    store,
    maxRequests: 2,
    windowMs: 1000,
    namespace: "test-rate"
  });

  assert.equal((await one.consume("client", 100)).allowed, true);
  assert.equal((await two.consume("client", 200)).allowed, true);
  assert.equal((await one.consume("client", 300)).allowed, false);

  assert.equal((await two.consume("client", 1100)).allowed, true);
});

test("coordinated idempotency replays across store consumers", async () => {
  const store = createInMemoryCoordinationStore();
  const one = createCoordinatedIdempotencyStore({ store, namespace: "test-idem" });
  const two = createCoordinatedIdempotencyStore({ store, namespace: "test-idem" });

  await one.remember("POST /v1/decide", "key-1", { x: 1 }, {
    status: 200,
    body: { decisionId: "decision-1" }
  });

  assert.deepEqual(
    await two.lookup("POST /v1/decide", "key-1", { x: 1 }),
    {
      status: 200,
      body: { decisionId: "decision-1" },
      replayed: true
    }
  );
});

test("coordinated idempotency rejects key reuse with a different body", async () => {
  const store = createInMemoryCoordinationStore();
  const idempotency = createCoordinatedIdempotencyStore({ store });

  await idempotency.remember("scope", "key", { x: 1 }, { status: 200, body: {} });

  await assert.rejects(
    () => idempotency.lookup("scope", "key", { x: 2 }),
    /idempotency_key_reused/
  );
});

test("coordinated idempotency can claim a key and identify in-progress retries", async () => {
  const store = createInMemoryCoordinationStore();
  const one = createCoordinatedIdempotencyStore({ store, namespace: "claim-test" });
  const two = createCoordinatedIdempotencyStore({ store, namespace: "claim-test" });

  assert.deepEqual(
    await one.claim("scope", "key", { payload: 1 }),
    { claimed: true }
  );

  assert.deepEqual(
    await two.claim("scope", "key", { payload: 1 }),
    { claimed: false, reason: "in_progress" }
  );

  await assert.rejects(
    () => two.claim("scope", "key", { payload: 2 }),
    /idempotency_key_reused/
  );
});

test("coordinated consumer validates backend configuration", () => {
  assert.throws(
    () => createCoordinatedFixedWindowRateLimiter({ store: {}, maxRequests: 1 }),
    /must implement get/
  );
});
