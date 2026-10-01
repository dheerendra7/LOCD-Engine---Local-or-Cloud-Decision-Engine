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

test("invalid TTL configuration fails clearly", async () => {
  const store = createInMemoryCoordinationStore();
  await assert.rejects(
    () => store.set("key", "value", { ttlMs: 0 }),
    /ttlMs must be >= 1/
  );
});
