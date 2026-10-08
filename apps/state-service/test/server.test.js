import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGracefulShutdown, createStateServiceServer } from "../src/server.js";
import { createSQLiteStateStores } from "../../../packages/sqlite/src/index.js";

async function startServer(apiKey = "state-secret") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-state-service-"));
  const file = path.join(dir, "state.db");
  const stores = createSQLiteStateStores({ filePath: file, maxEntries: 100 });
  const server = createStateServiceServer({ stores, apiKey });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    stores,
    url: "http://127.0.0.1:" + server.address().port,
    cleanup: async () => {
      await new Promise(resolve => server.close(resolve));
      stores.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("readBody rejects oversized declared content before consuming the stream", async () => {
  let consumed = false;
  const request = {
    headers: { "content-length": "100" },
    async *[Symbol.asyncIterator]() {
      consumed = true;
      yield '{"should":"not be read"}';
    }
  };

  await assert.rejects(
    () => readBody(request, 10),
    /request body too large/
  );
  assert.equal(consumed, false);
});

test("readBody enforces the limit across streamed chunks", async () => {
  const request = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield "12345";
      yield "67890";
      yield "x";
    }
  };

  await assert.rejects(
    () => readBody(request, 10),
    /request body too large/
  );
});

test("state service graceful shutdown force-closes active connections after its deadline", async () => {
  const events = [];
  let closeCallback;
  let forcedClose = 0;
  let storesClosed = 0;
  const server = {
    close(callback) {
      closeCallback = callback;
    },
    closeAllConnections() {
      forcedClose += 1;
      closeCallback();
    }
  };
  const stores = {
    close() {
      storesClosed += 1;
    }
  };
  const logger = {
    info(event) {
      events.push(event.event);
    },
    warn(event) {
      events.push(event.event);
      assert.equal(event.timeoutMs, 10);
    },
    error(event) {
      events.push(event.event);
    }
  };

  const shutdown = createGracefulShutdown({
    server,
    stores,
    logger,
    shutdownTimeoutMs: 10
  });

  assert.equal(await shutdown("SIGTERM"), true);
  assert.equal(forcedClose, 1);
  assert.equal(storesClosed, 1);
  assert.deepEqual(events, [
    "shutdown_started",
    "shutdown_timeout",
    "shutdown_complete"
  ]);
});

test("state service applies HTTP resource guards", () => {
  const guarded = createStateServiceServer({
    stores: {
      telemetry: {},
      coordination: {},
      policies: {}
    },
    requestTimeoutMs: 15_000,
    headersTimeoutMs: 7_000,
    keepAliveTimeoutMs: 3_000,
    maxRequestsPerSocket: 25
  });

  assert.equal(guarded.requestTimeout, 15_000);
  assert.equal(guarded.headersTimeout, 7_000);
  assert.equal(guarded.keepAliveTimeout, 3_000);
  assert.equal(guarded.maxRequestsPerSocket, 25);
});

test("state service rejects missing authentication configuration", () => {
  const stores = {
    telemetry: {},
    coordination: {},
    policies: {}
  };

  assert.throws(
    () => createStateServiceServer({ stores, apiKey: null }),
    /state service apiKey is required/
  );
  assert.throws(
    () => createStateServiceServer({ stores, apiKey: "   " }),
    /state service apiKey is required/
  );
});

test("state service rejects invalid HTTP resource guard configuration", () => {
  const stores = {
    telemetry: {},
    coordination: {},
    policies: {}
  };

  assert.throws(
    () => createStateServiceServer({ stores, requestTimeoutMs: 0 }),
    /requestTimeoutMs must be >= 1/
  );
  assert.throws(
    () => createStateServiceServer({ stores, headersTimeoutMs: 0 }),
    /headersTimeoutMs must be >= 1/
  );
  assert.throws(
    () => createStateServiceServer({
      stores,
      requestTimeoutMs: 5_000,
      headersTimeoutMs: 5_001
    }),
    /headersTimeoutMs must be <= requestTimeoutMs/
  );
  assert.throws(
    () => createStateServiceServer({ stores, keepAliveTimeoutMs: -1 }),
    /keepAliveTimeoutMs must be >= 0/
  );
  assert.throws(
    () => createStateServiceServer({ stores, maxRequestsPerSocket: 1.5 }),
    /maxRequestsPerSocket must be a non-negative integer/
  );
});

test("state service rejects body-bearing requests without JSON content type", async () => {
  const instance = await startServer();

  try {
    const response = await fetch(instance.url + "/v1/state/decisions", {
      method: "POST",
      headers: { authorization: "Bearer state-secret" },
      body: JSON.stringify({
        id: "bad-content-type",
        route: "local",
        workloadType: "test"
      })
    });

    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: "unsupported_media_type" });
  } finally {
    await instance.cleanup();
  }
});

test("state service exposes public health and protects state APIs", async () => {
  const instance = await startServer();

  try {
    const health = await fetch(instance.url + "/health");
    assert.equal(health.status, 200);

    const denied = await fetch(instance.url + "/v1/state/metrics");
    assert.equal(denied.status, 401);

    const allowed = await fetch(instance.url + "/v1/state/metrics", {
      headers: { authorization: "Bearer state-secret" }
    });
    assert.equal(allowed.status, 200);
  } finally {
    await instance.cleanup();
  }
});

test("state service hides unexpected storage failures behind a generic 500", async () => {
  const instance = await startServer();
  const originalRecord = instance.stores.telemetry.record;
  instance.stores.telemetry.record = () => {
    throw new Error("internal sqlite password should never reach the client");
  };

  try {
    const response = await fetch(instance.url + "/v1/state/decisions", {
      method: "POST",
      headers: {
        authorization: "Bearer state-secret",
        "content-type": "application/json",
        "x-request-id": "state-error-contract"
      },
      body: JSON.stringify({
        id: "unexpected-failure",
        route: "local",
        workloadType: "test"
      })
    });

    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-request-id"), "state-error-contract");
    const body = await response.json();
    assert.deepEqual(body, {
      error: "internal_server_error",
      requestId: "state-error-contract"
    });
    assert.equal("internal sqlite password should never reach the client" in JSON.stringify(body), false);
  } finally {
    instance.stores.telemetry.record = originalRecord;
    await instance.cleanup();
  }
});

test("state service stores telemetry and outcomes", async () => {
  const instance = await startServer();

  try {
    const headers = {
      authorization: "Bearer state-secret",
      "content-type": "application/json"
    };

    const saved = await fetch(instance.url + "/v1/state/decisions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "state-d1",
        route: "local",
        targetId: "gpu",
        workloadType: "llm",
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.01
      })
    });
    assert.equal(saved.status, 201);

    const outcome = await fetch(instance.url + "/v1/state/outcomes/state-d1", {
      method: "POST",
      headers,
      body: JSON.stringify({
        outcome: "success",
        actualLatencyMs: 120,
        actualCostUsd: 0.012
      })
    });
    assert.equal(outcome.status, 200);

    const metrics = await fetch(instance.url + "/v1/state/metrics", {
      headers: { authorization: "Bearer state-secret" }
    });
    const summary = await metrics.json();
    assert.equal(summary.successRate, 1);
    assert.equal(summary.meanAbsoluteLatencyErrorMs, 20);
  } finally {
    await instance.cleanup();
  }
});

test("state service exposes tenant-scoped policy CRUD and rollback", async () => {
  const instance = await startServer();

  try {
    const headers = {
      authorization: "Bearer state-secret",
      "content-type": "application/json",
      "x-locd-tenant-id": "acme"
    };
    const policy = {
      id: "shared-policy",
      name: "Shared Policy",
      baseProfile: "balanced",
      allowedModes: ["local"]
    };

    const created = await fetch(instance.url + "/v1/state/policies", {
      method: "POST",
      headers,
      body: JSON.stringify({ policy, updatedBy: "admin" })
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).version, 1);

    const updated = await fetch(instance.url + "/v1/state/policies", {
      method: "POST",
      headers,
      body: JSON.stringify({ policy: { ...policy, description: "v2" } })
    });
    assert.equal((await updated.json()).version, 2);

    const history = await fetch(
      instance.url + "/v1/state/policies/shared-policy/history",
      { headers }
    );
    assert.equal(history.status, 200);
    assert.equal((await history.json()).versions.length, 2);

    const otherTenant = await fetch(
      instance.url + "/v1/state/policies/shared-policy",
      { headers: { authorization: "Bearer state-secret", "x-locd-tenant-id": "beta" } }
    );
    assert.equal(otherTenant.status, 404);

    const rollback = await fetch(
      instance.url + "/v1/state/policies/shared-policy/rollback",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ version: 1, updatedBy: "rollback" })
      }
    );
    assert.equal(rollback.status, 200);
    const rollbackBody = await rollback.json();
    assert.equal(rollbackBody.version, 3);
    assert.equal(rollbackBody.rolledBackFromVersion, 1);
  } finally {
    await instance.cleanup();
  }
});

test("state service provides atomic coordination operations", async () => {
  const instance = await startServer();

  try {
    const headers = {
      authorization: "Bearer state-secret",
      "content-type": "application/json"
    };

    const first = await fetch(instance.url + "/v1/state/kv/lock/set-if-absent", {
      method: "POST",
      headers,
      body: JSON.stringify({ value: { owner: "one" }, ttlMs: 1000 })
    });
    const second = await fetch(instance.url + "/v1/state/kv/lock/set-if-absent", {
      method: "POST",
      headers,
      body: JSON.stringify({ value: { owner: "two" }, ttlMs: 1000 })
    });

    assert.deepEqual(await first.json(), { claimed: true });
    assert.deepEqual(await second.json(), { claimed: false });

    const increment = await fetch(instance.url + "/v1/state/kv/counter/incr", {
      method: "POST",
      headers,
      body: JSON.stringify({ ttlMs: 1000 })
    });
    assert.deepEqual(await increment.json(), { value: 1 });
  } finally {
    await instance.cleanup();
  }
});

test("state service limits request body size", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-state-body-"));
  const file = path.join(dir, "state.db");
  const stores = createSQLiteStateStores({ filePath: file });
  const server = createStateServiceServer({ stores, apiKey: "secret", maxBodyBytes: 10 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;

  try {
    const response = await fetch(url + "/v1/state/kv/x", {
      method: "PUT",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ value: "this is too large" })
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise(resolve => server.close(resolve));
    stores.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("state service keeps telemetry and coordination cleanup isolated", async () => {
  const instance = await startServer();

  try {
    const headers = {
      authorization: "Bearer state-secret",
      "content-type": "application/json"
    };

    await fetch(instance.url + "/v1/state/decisions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "clear-isolation",
        route: "local",
        workloadType: "batch"
      })
    });

    await fetch(instance.url + "/v1/state/kv/keep", {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: { keep: true } })
    });

    const telemetryClear = await fetch(instance.url + "/v1/state/telemetry/clear", {
      method: "POST",
      headers
    });
    assert.equal(telemetryClear.status, 200);

    const coordinationStillThere = await fetch(instance.url + "/v1/state/kv/keep", {
      headers: { authorization: "Bearer state-secret" }
    });
    assert.deepEqual(await coordinationStillThere.json(), { value: { keep: true } });

    const telemetryEmpty = await fetch(instance.url + "/v1/state/metrics", {
      headers: { authorization: "Bearer state-secret" }
    });
    assert.equal((await telemetryEmpty.json()).totalDecisions, 0);

    await fetch(instance.url + "/v1/state/decisions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "clear-isolation-2",
        route: "cloud",
        workloadType: "batch"
      })
    });

    const coordinationClear = await fetch(instance.url + "/v1/state/coordination/clear", {
      method: "POST",
      headers
    });
    assert.equal(coordinationClear.status, 200);

    const telemetryStillThere = await fetch(instance.url + "/v1/state/metrics", {
      headers: { authorization: "Bearer state-secret" }
    });
    assert.equal((await telemetryStillThere.json()).totalDecisions, 1);

    const coordinationEmpty = await fetch(instance.url + "/v1/state/kv/keep", {
      headers: { authorization: "Bearer state-secret" }
    });
    assert.deepEqual(await coordinationEmpty.json(), { value: null });
  } finally {
    await instance.cleanup();
  }
});

test("state service isolates telemetry by trusted tenant header", async () => {
  const instance = await startServer();

  try {
    const baseHeaders = {
      authorization: "Bearer state-secret",
      "content-type": "application/json"
    };

    const save = async (tenantId, id, route) => fetch(
      instance.url + "/v1/state/decisions",
      {
        method: "POST",
        headers: { ...baseHeaders, "x-locd-tenant-id": tenantId },
        body: JSON.stringify({ id, route, workloadType: "tenant-test" })
      }
    );

    assert.equal((await save("acme", "acme-shared", "local")).status, 201);
    assert.equal((await save("beta", "beta-shared", "cloud")).status, 201);

    const acme = await fetch(instance.url + "/v1/state/decisions", {
      headers: { authorization: "Bearer state-secret", "x-locd-tenant-id": "acme" }
    });
    const beta = await fetch(instance.url + "/v1/state/decisions", {
      headers: { authorization: "Bearer state-secret", "x-locd-tenant-id": "beta" }
    });

    assert.equal((await acme.json()).decisions[0].tenantId, "acme");
    assert.equal((await beta.json()).decisions[0].tenantId, "beta");

    const crossTenantOutcome = await fetch(
      instance.url + "/v1/state/outcomes/acme-shared",
      {
        method: "POST",
        headers: { ...baseHeaders, "x-locd-tenant-id": "gamma" },
        body: JSON.stringify({ outcome: "success", actualLatencyMs: 10 })
      }
    );
    assert.equal(crossTenantOutcome.status, 404);
  } finally {
    await instance.cleanup();
  }
});
