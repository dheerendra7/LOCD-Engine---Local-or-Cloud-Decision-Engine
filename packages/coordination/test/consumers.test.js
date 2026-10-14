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

  const initialClaim = await one.claim("scope", "key", { payload: 1 });
  assert.equal(initialClaim.claimed, true);
  assert.equal(typeof initialClaim.claimToken, "string");

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


test("coordinated idempotency releases claims only for their owner", async () => {
  const store = createInMemoryCoordinationStore();
  const one = createCoordinatedIdempotencyStore({ store, namespace: "release-test" });
  const two = createCoordinatedIdempotencyStore({ store, namespace: "release-test" });
  const body = { payload: "same" };
  const claim = await one.claim("scope", "key", body);
  assert.equal(claim.claimed, true);
  assert.equal(typeof claim.claimToken, "string");
  assert.equal(await two.release("scope", "key", body, claim.claimToken + "-wrong"), false);
  assert.equal((await two.claim("scope", "key", body)).reason, "in_progress");
  assert.equal(await one.release("scope", "key", body, claim.claimToken), true);
  const replacement = await two.claim("scope", "key", body);
  assert.equal(replacement.claimed, true);
  assert.equal(await one.release("scope", "key", body, claim.claimToken), false);
  assert.equal((await one.claim("scope", "key", body)).reason, "in_progress");
});


test("a stale coordinated request cannot complete a replacement claim", async () => {
  const store = createInMemoryCoordinationStore();
  const one = createCoordinatedIdempotencyStore({ store, namespace: "completion-fence" });
  const two = createCoordinatedIdempotencyStore({ store, namespace: "completion-fence" });
  const body = { payload: "same" };
  const oldClaim = await one.claim("scope", "key", body);

  assert.equal(await one.release("scope", "key", body, oldClaim.claimToken), true);
  const newClaim = await two.claim("scope", "key", body);
  assert.equal(newClaim.claimed, true);
  assert.notEqual(newClaim.claimToken, oldClaim.claimToken);

  assert.equal(
    await one.remember("scope", "key", body, { status: 200, body: { owner: "old" } }, oldClaim.claimToken),
    false
  );
  assert.equal((await one.claim("scope", "key", body)).reason, "in_progress");
  assert.equal(
    await two.remember("scope", "key", body, { status: 200, body: { owner: "new" } }, newClaim.claimToken),
    true
  );
  assert.equal((await one.lookup("scope", "key", body)).body.owner, "new");
});


test("coordinated idempotency fails fast when the backend lacks atomic claim fencing", () => {
  const base = createInMemoryCoordinationStore();
  const legacy = {
    get: base.get,
    set: base.set,
    setIfAbsent: base.setIfAbsent,
    delete: base.delete,
    incr: base.incr
  };
  assert.throws(
    () => createCoordinatedIdempotencyStore({ store: legacy }),
    /must implement deleteIfValue\(\) and setIfValue\(\) for safe idempotency claims/
  );
});


test("a missing shared lease can cache a late result without overwriting a new claim", async () => {
  const store = createInMemoryCoordinationStore();
  const one = createCoordinatedIdempotencyStore({ store, namespace: "late-result" });
  const body = { payload: "slow but successful" };

  const expired = await one.claim("scope", "empty-key", body, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(
    await one.remember("scope", "empty-key", body, { status: 200, body: { owner: "late" } }, expired.claimToken),
    true
  );
  assert.equal((await one.lookup("scope", "empty-key", body)).body.owner, "late");

  const oldClaim = await one.claim("scope", "replacement-key", body);
  assert.equal(await one.release("scope", "replacement-key", body, oldClaim.claimToken), true);
  const replacement = await one.claim("scope", "replacement-key", body);
  assert.equal(replacement.claimed, true);
  assert.notEqual(replacement.claimToken, oldClaim.claimToken);
  assert.equal(
    await one.remember("scope", "replacement-key", body, { status: 200, body: { owner: "stale" } }, oldClaim.claimToken),
    false
  );
  assert.equal((await one.claim("scope", "replacement-key", body)).reason, "in_progress");
});


test("coordinated idempotency retries when a claim disappears between set-if-absent and read", async () => {
  const base = createInMemoryCoordinationStore();
  let setIfAbsentCalls = 0;
  let getCalls = 0;
  const flakyStore = {
    get: async key => {
      getCalls++;
      if (getCalls === 1) return null;
      return base.get(key);
    },
    set: (...args) => base.set(...args),
    setIfAbsent: async (...args) => {
      setIfAbsentCalls++;
      if (setIfAbsentCalls === 1) return false;
      return base.setIfAbsent(...args);
    },
    delete: (...args) => base.delete(...args),
    incr: (...args) => base.incr(...args),
    setIfValue: (...args) => base.setIfValue(...args),
    deleteIfValue: (...args) => base.deleteIfValue(...args)
  };
  const idempotency = createCoordinatedIdempotencyStore({
    store: flakyStore,
    namespace: "claim-disappeared"
  });

  const claim = await idempotency.claim("scope", "key", { payload: 1 });
  assert.equal(claim.claimed, true);
  assert.equal(typeof claim.claimToken, "string");
  assert.equal(setIfAbsentCalls, 2);
  assert.equal((await idempotency.claim("scope", "key", { payload: 1 })).reason, "in_progress");
});
