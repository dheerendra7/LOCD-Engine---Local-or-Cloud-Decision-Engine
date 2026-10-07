import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDecisionStore,
  assertCoordinationStore,
  describeStateBackend
} from "../src/index.js";

const telemetry = {
  record() {},
  recordOutcome() {},
  list() {},
  summary() {},
  clear() {},
  capabilities: {
    durable: true,
    shared: true,
    tenantScoped: true,
    transactional: true
  }
};

const coordination = {
  async get() {},
  async set() {},
  async setIfAbsent() {},
  async delete() {},
  async incr() {},
  capabilities: {
    durable: true,
    shared: true,
    tenantScoped: true,
    transactional: true
  }
};

test("decision store contract validates required methods", () => {
  assert.equal(assertDecisionStore(telemetry), telemetry);
  assert.throws(
    () => assertDecisionStore({ record() {} }),
    /missing methods/
  );
});

test("coordination store contract validates required methods", () => {
  assert.equal(assertCoordinationStore(coordination), coordination);
  assert.throws(
    () => assertCoordinationStore({ get() {} }),
    /missing methods/
  );
});

test("state backend descriptor normalizes capabilities", () => {
  assert.deepEqual(
    describeStateBackend({
      telemetry,
      coordination,
      kind: "sqlite"
    }),
    {
      kind: "sqlite",
      telemetry: {
        durable: true,
        shared: true,
        tenantScoped: true,
        transactional: true
      },
      coordination: {
        durable: true,
        shared: true,
        tenantScoped: true,
        transactional: true
      }
    }
  );
});
