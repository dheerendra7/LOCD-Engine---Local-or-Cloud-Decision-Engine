import test from "node:test";
import assert from "node:assert/strict";
import { assertCoordinationStore, createInMemoryCoordinationStore } from "../src/index.js";

test("coordination store supports get/set/delete", async () => {
  const store = createInMemoryCoordinationStore();
  assert.equal(await store.get("missing"), null);

  await store.set("key", { value: 1 });
  assert.deepEqual(await store.get("key"), { value: 1 });

  assert.equal(await store.delete("key"), true);
  assert.equal(await store.get("key"), null);
});

test("coordination store supports increment with first-write TTL", async () => {
  const store = createInMemoryCoordinationStore();
  assert.equal(await store.incr("counter", { ttlMs: 1000 }), 1);
  assert.equal(await store.incr("counter", { ttlMs: 1000 }), 2);
});

test("coordination store expires values after TTL", async () => {
  const store = createInMemoryCoordinationStore();
  await store.set("key", "value", { ttlMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await store.get("key"), null);
});

test("coordination store clones values to prevent mutation leaks", async () => {
  const store = createInMemoryCoordinationStore();
  const value = { nested: { number: 1 } };
  await store.set("key", value);
  value.nested.number = 99;

  const read = await store.get("key");
  assert.equal(read.nested.number, 1);
});

test("coordination store contract is validated", () => {
  const store = createInMemoryCoordinationStore();
  assert.equal(assertCoordinationStore(store), store);

  assert.throws(
    () => assertCoordinationStore({ get() {} }),
    /must implement set/
  );
});

test("increment rejects invalid or overflowing counters without mutation", async () => {
  const store = createInMemoryCoordinationStore();

  for (const value of ["3", "not-a-counter", -1, 1.5, null]) {
    await store.set("invalid-counter", value);
    await assert.rejects(
      () => store.incr("invalid-counter"),
      /coordination counter must be a non-negative safe integer/
    );
    assert.equal(await store.get("invalid-counter"), value);
  }

  await store.set("max-counter", Number.MAX_SAFE_INTEGER);
  await assert.rejects(
    () => store.incr("max-counter"),
    /coordination counter overflow/
  );
  assert.equal(await store.get("max-counter"), Number.MAX_SAFE_INTEGER);
});

test("invalid TTL configuration fails before mutating coordination state", async () => {
  const store = createInMemoryCoordinationStore();

  await assert.rejects(
    () => store.set("new-key", "value", { ttlMs: 0 }),
    /ttlMs must be >= 1/
  );
  assert.equal(await store.get("new-key"), null);

  await store.set("existing-key", "original");
  await assert.rejects(
    () => store.set("existing-key", "replacement", { ttlMs: -1 }),
    /ttlMs must be >= 1/
  );
  assert.equal(await store.get("existing-key"), "original");

  await assert.rejects(
    () => store.incr("new-counter", { ttlMs: 0 }),
    /ttlMs must be >= 1/
  );
  assert.equal(await store.get("new-counter"), null);

  assert.equal(await store.incr("existing-counter", { ttlMs: 1000 }), 1);
  await assert.rejects(
    () => store.incr("existing-counter", { ttlMs: 0 }),
    /ttlMs must be >= 1/
  );
  assert.equal(await store.get("existing-counter"), 1);
});


test("fractional TTLs use safe whole-millisecond expiry deadlines", async () => {
  const store = createInMemoryCoordinationStore();

  await store.set("fractional", "value", { ttlMs: 1500.5 });
  assert.equal(await store.get("fractional"), "value");

  await assert.rejects(
    () => store.set("unsafe-expiry", "value", { ttlMs: Number.MAX_VALUE }),
    /ttlMs exceeds supported expiry range/
  );
  assert.equal(await store.get("unsafe-expiry"), null);
});
