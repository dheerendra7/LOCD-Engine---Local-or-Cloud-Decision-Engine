import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, runCli } from "../src/index.js";

test("parseArgs extracts base URL and positional arguments", () => {
  assert.deepEqual(
    parseArgs(["--base-url", "http://example.test", "metrics"]),
    {
      baseUrl: "http://example.test",
      apiKey: null,
      idempotencyKey: null,
      live: false,
      includeOutputs: false,
      force: false,
      positional: ["metrics"]
    }
  );
});

test("parseArgs supports backup force mode", () => {
  assert.deepEqual(
    parseArgs(["backup", "state.db", "backup.db", "--force"]),
    {
      baseUrl: "http://localhost:8787",
      apiKey: null,
      idempotencyKey: null,
      live: false,
      includeOutputs: false,
      force: true,
      positional: ["backup", "state.db", "backup.db"]
    }
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

test("CLI backup command creates a database copy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-cli-backup-"));
  const source = path.join(dir, "source.db");
  const destination = path.join(dir, "backup.db");

  try {
    const database = new DatabaseSync(source);
    database.exec("CREATE TABLE data(key TEXT PRIMARY KEY, value TEXT) STRICT");
    database.prepare("INSERT INTO data(key, value) VALUES (?, ?)").run("k", "v");
    database.close();

    const output = [];
    const code = await runCli(
      ["backup", source, destination],
      { write: value => output.push(value) }
    );

    assert.equal(code, 0);
    assert.equal(JSON.parse(output[0]).destination, path.resolve(destination));

    const restored = new DatabaseSync(destination);
    assert.deepEqual(
      restored.prepare("SELECT value FROM data WHERE key = ?").get("k"),
      { value: "v" }
    );
    restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("targets and probe commands use API key headers", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  process.env.LOCD_API_KEY = "test-api-key";
  try {
    await runCli(["targets"], { fetchImpl, write() {} });
    await runCli(["probe", "gpu/1"], { fetchImpl, write() {} });

    assert.equal(calls[0].options.headers["x-locd-api-key"], "test-api-key");
    assert.equal(calls[1].options.headers["x-locd-api-key"], "test-api-key");
  } finally {
    delete process.env.LOCD_API_KEY;
  }
});

test("execute defaults to dry-run even when plan file asks for live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-cli-execute-"));
  const file = path.join(dir, "plan.json");

  try {
    await writeFile(file, JSON.stringify({
      mode: "live",
      plan: {
        valid: true,
        steps: [{ id: "step-1", targetId: "target-1" }]
      }
    }), "utf8");

    let request;
    const fetchImpl = async (_url, options = {}) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    };

    await runCli(["execute", file], { fetchImpl, write() {} });
    assert.equal(request.mode, "dry-run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("execute requires --live to send live mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-cli-live-"));
  const file = path.join(dir, "plan.json");

  try {
    await writeFile(file, JSON.stringify({
      mode: "dry-run",
      plan: {
        valid: true,
        steps: [{ id: "step-1", targetId: "target-1" }]
      }
    }), "utf8");

    let request;
    const fetchImpl = async (_url, options = {}) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    };

    await runCli(["execute", file, "--live"], { fetchImpl, write() {} });
    assert.equal(request.mode, "live");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
