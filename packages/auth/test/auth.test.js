import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SCOPES,
  createAuthorizer,
  loadAuthorizerFromFile,
  requiredScopeForRequest
} from "../src/index.js";

test("legacy key grants admin access to every scope", () => {
  const auth = createAuthorizer({ legacyKey: "legacy-secret" });
  const result = auth.authenticate({
    headers: { authorization: "Bearer legacy-secret" }
  });

  assert.equal(result.authenticated, true);
  assert.deepEqual(result.principal.scopes, ["admin"]);
  for (const scope of SCOPES) {
    assert.equal(auth.authorize(result.principal, scope), true);
  }
});

test("scoped key grants only configured scopes", () => {
  const auth = createAuthorizer({
    keyEntries: [
      {
        id: "dashboard",
        keyEnv: "DASHBOARD_KEY",
        scopes: ["read"]
      },
      {
        id: "operator",
        keyEnv: "OPERATOR_KEY",
        scopes: ["read", "decide", "targets:write", "telemetry:write"]
      }
    ],
    env: {
      DASHBOARD_KEY: "dashboard-secret",
      OPERATOR_KEY: "operator-secret"
    }
  });

  const result = auth.authenticate({
    headers: { "x-locd-api-key": "dashboard-secret" }
  });

  assert.equal(result.principal.id, "dashboard");
  assert.equal(auth.authorize(result.principal, "read"), true);
  assert.equal(auth.authorize(result.principal, "decide"), false);
  assert.equal(auth.authorize(result.principal, "execute"), false);
});

test("wrong or missing credentials are rejected when scoped auth is configured", () => {
  const auth = createAuthorizer({
    keyEntries: [{
      id: "reader",
      keyEnv: "READER_KEY",
      scopes: ["read"]
    }],
    env: { READER_KEY: "reader-secret" }
  });

  const wrong = auth.authenticate({
    headers: { "x-locd-api-key": "wrong" }
  });
  const missing = auth.authenticate({ headers: {} });

  assert.equal(wrong.authenticated, false);
  assert.equal(missing.authenticated, false);
  assert.equal(auth.authorize(wrong.principal, "read"), false);
});

test("anonymous mode remains compatible when no credentials are configured", () => {
  const auth = createAuthorizer({ allowAnonymous: true });
  const result = auth.authenticate({ headers: {} });

  assert.equal(result.principal.id, "anonymous");
  assert.equal(auth.authorize(result.principal, "read"), true);
  assert.equal(auth.authorize(result.principal, "targets:write"), true);
  assert.equal(auth.authorize(result.principal, "execute"), false);
});

test("config loader resolves secrets through environment names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-auth-"));
  const file = path.join(dir, "keys.json");

  try {
    await writeFile(file, JSON.stringify({
      keys: [{
        id: "executor",
        keyEnv: "EXECUTOR_KEY",
        scopes: ["execute"]
      }]
    }), "utf8");

    const auth = await loadAuthorizerFromFile({
      filePath: file,
      env: { EXECUTOR_KEY: "executor-secret" }
    });

    const result = auth.authenticate({
      headers: { authorization: "Bearer executor-secret" }
    });

    assert.equal(result.principal.id, "executor");
    assert.equal(auth.authorize(result.principal, "execute"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed auth config fails clearly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-auth-invalid-"));
  const file = path.join(dir, "keys.json");

  try {
    await writeFile(file, "{not-json}", "utf8");
    await assert.rejects(
      () => loadAuthorizerFromFile({ filePath: file }),
      /auth config file is invalid JSON/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope mapping is explicit and denies unknown v1 routes by default", () => {
  assert.equal(requiredScopeForRequest("GET", "/v1/metrics"), "read");
  assert.equal(requiredScopeForRequest("POST", "/v1/decide"), "decide");
  assert.equal(requiredScopeForRequest("POST", "/v1/targets/x/probe"), "targets:write");
  assert.equal(requiredScopeForRequest("POST", "/v1/targets/x/heartbeat"), "targets:write");
  assert.equal(requiredScopeForRequest("POST", "/v1/outcomes"), "telemetry:write");
  assert.equal(requiredScopeForRequest("POST", "/v1/execute"), "execute");
  assert.equal(requiredScopeForRequest("PATCH", "/v1/unknown"), "admin");
});

test("blank scoped key environment values fail closed", () => {
  assert.throws(
    () => createAuthorizer({
      keyEntries: [{
        id: "empty",
        keyEnv: "EMPTY_KEY",
        scopes: ["read"]
      }],
      env: { EMPTY_KEY: "   " }
    }),
    /auth key environment variable is empty/
  );
});
