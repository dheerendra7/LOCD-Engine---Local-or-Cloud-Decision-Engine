import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, runCli } from "../src/index.js";

test("parseArgs extracts base URL and positional arguments", () => {
  assert.deepEqual(
    parseArgs(["--base-url", "http://example.test", "metrics"]),
    { baseUrl: "http://example.test", positional: ["metrics"] }
  );
});

test("CLI help is available without a network request", async () => {
  const output = [];
  const code = await runCli(["help"], { write: value => output.push(value) });
  assert.equal(code, 0);
  assert.match(output[0], /LOCD CLI/);
});

test("CLI metrics command uses the configured API", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ totalDecisions: 4 }), { status: 200 });
  };
  const output = [];
  await runCli(["--base-url", "http://example.test", "metrics"], {
    fetchImpl,
    write: value => output.push(value)
  });
  assert.deepEqual(calls, ["http://example.test/v1/metrics"]);
  assert.match(output[0], /totalDecisions/);
});

test("CLI decide loads a JSON request file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-cli-"));
  const file = path.join(dir, "request.json");
  await writeFile(file, JSON.stringify({ workload: { type: "batch" }, targets: [] }));

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ route: "local" }), { status: 200 });
  };

  const output = [];
  try {
    await runCli(["decide", file], { fetchImpl, write: value => output.push(value) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.equal(calls[0].url, "http://localhost:8787/v1/decide");
  assert.equal(JSON.parse(calls[0].options.body).workload.type, "batch");
  assert.match(output[0], /local/);
});
