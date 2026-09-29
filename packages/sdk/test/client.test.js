import test from "node:test";
import assert from "node:assert/strict";
import { createLocdClient } from "../src/index.js";

test("client validates configuration", () => {
  assert.throws(() => createLocdClient(), /baseUrl is required/);
});

test("client sends decision requests to the LOCD API", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ route: "local" }), { status: 200 });
  };

  const client = createLocdClient({ baseUrl: "http://localhost:8787", fetchImpl });
  const result = await client.decide({ workload: { type: "batch" }, targets: [] });

  assert.equal(result.route, "local");
  assert.equal(calls[0].url, "http://localhost:8787/v1/decide");
  assert.equal(JSON.parse(calls[0].options.body).workload.type, "batch");
});

test("client exposes history and metrics helpers", async () => {
  const paths = [];
  const fetchImpl = async url => {
    paths.push(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createLocdClient({ baseUrl: "http://localhost:8787/", fetchImpl });
  await client.health();
  await client.policies();
  await client.decisions(2001);
  await client.metrics();

  assert.deepEqual(paths, [
    "http://localhost:8787/health",
    "http://localhost:8787/v1/policies",
    "http://localhost:8787/v1/decisions?limit=1000",
    "http://localhost:8787/v1/metrics"
  ]);
});

test("client surfaces API errors with status and body", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "bad request" }), { status: 400 });

  const client = createLocdClient({ baseUrl: "http://localhost:8787", fetchImpl });
  await assert.rejects(
    () => client.health(),
    error => error.status === 400 && error.body.error === "bad request"
  );
});
