import test from "node:test";
import assert from "node:assert/strict";
import { createScopedAuthorizer, loadScopedAuthFromEnv } from "../src/index.js";

const req = key => ({
  headers: {
    authorization: key ? "Bearer " + key : ""
  }
});

test("no configured keys keep the development API open", () => {
  const authorizer = createScopedAuthorizer();
  assert.equal(authorizer.enabled, false);
  assert.equal(authorizer.authorize(req("anything"), "execute").ok, true);
});

test("legacy API key keeps full admin compatibility", () => {
  const authorizer = createScopedAuthorizer({ legacyApiKey: "legacy-secret" });
  assert.deepEqual(authorizer.authorize(req("legacy-secret"), "execute").scopes, ["admin"]);
  assert.equal(authorizer.authorize(req("wrong"), "read").ok, false);
});

test("scoped keys allow only declared operations", () => {
  const authorizer = createScopedAuthorizer({
    keys: [
      { id: "reader", secret: "read-secret", scopes: ["read"] },
      { id: "executor", secret: "exec-secret", scopes: ["execute", "telemetry"] }
    ]
  });

  assert.equal(authorizer.authorize(req("read-secret"), "read").ok, true);
  assert.equal(authorizer.authorize(req("read-secret"), "execute").reason, "forbidden_scope");
  assert.equal(authorizer.authorize(req("exec-secret"), "execute").ok, true);
  assert.equal(authorizer.authorize(req("exec-secret"), "telemetry").ok, true);
  assert.equal(authorizer.authorize(req("exec-secret"), "targets").ok, false);
});

test("environment loader resolves secretEnv references without embedding secrets in JSON", () => {
  const authorizer = loadScopedAuthFromEnv({
    legacyApiKey: null,
    raw: JSON.stringify([
      { id: "reader", secretEnv: "READER_KEY", scopes: ["read"] }
    ]),
    env: { READER_KEY: "top-secret" }
  });

  assert.equal(authorizer.authorize(req("top-secret"), "read").ok, true);
});

test("missing and blank secret environment variables fail closed", () => {
  assert.throws(
    () => loadScopedAuthFromEnv({
      legacyApiKey: null,
      raw: JSON.stringify([{ id: "reader", secretEnv: "MISSING", scopes: ["read"] }]),
      env: {}
    }),
    /environment variable is not set/
  );

  assert.throws(
    () => loadScopedAuthFromEnv({
      legacyApiKey: null,
      raw: JSON.stringify([{ id: "reader", secretEnv: "EMPTY", scopes: ["read"] }]),
      env: { EMPTY: "   " }
    }),
    /environment variable is empty/
  );
});

test("invalid scope configuration is rejected", () => {
  assert.throws(
    () => createScopedAuthorizer({
      keys: [{ id: "bad", secret: "secret", scopes: ["root"] }]
    }),
    /unknown auth scope/
  );
});

test("duplicate key IDs are rejected", () => {
  assert.throws(
    () => createScopedAuthorizer({
      keys: [
        { id: "same", secret: "one", scopes: ["read"] },
        { id: "same", secret: "two", scopes: ["read"] }
      ]
    }),
    /duplicate auth key id/
  );
});

test("authorization header and x-api-key header share the same verifier", () => {
  const authorizer = createScopedAuthorizer({
    keys: [{ id: "reader", secret: "read-secret", scopes: ["read"] }]
  });

  assert.equal(authorizer.authorize({
    headers: { "x-locd-api-key": "read-secret" }
  }, "read").ok, true);
});

test("duplicate API secret values are rejected even with different IDs", () => {
  assert.throws(
    () => createScopedAuthorizer({
      keys: [
        { id: "one", secret: "same-secret", scopes: ["read"] },
        { id: "two", secret: "same-secret", scopes: ["execute"] }
      ]
    }),
    /duplicate auth key secret/
  );
});

test("authorization returns trusted tenant context", () => {
  const authorizer = createScopedAuthorizer({
    keys: [
      { id: "acme-reader", secret: "acme-secret", tenantId: "Acme-Prod", scopes: ["read"] },
      { id: "beta-reader", secret: "beta-secret", tenantId: "beta", scopes: ["read"] }
    ]
  });

  assert.equal(authorizer.authorize(req("acme-secret"), "read").tenantId, "acme-prod");
  assert.equal(authorizer.authorize(req("beta-secret"), "read").tenantId, "beta");
});

test("legacy API key uses explicit default tenant configuration", () => {
  const authorizer = createScopedAuthorizer({
    legacyApiKey: "legacy",
    legacyTenantId: "platform-demo"
  });

  const context = authorizer.authorize(req("legacy"), "read");
  assert.equal(context.tenantId, "platform-demo");
});

test("environment loader preserves tenant metadata", () => {
  const authorizer = loadScopedAuthFromEnv({
    legacyApiKey: null,
    raw: JSON.stringify([
      {
        id: "tenant-reader",
        secretEnv: "TENANT_KEY",
        tenantId: "Customer-One",
        scopes: ["read"]
      }
    ]),
    env: { TENANT_KEY: "secret" }
  });

  assert.equal(authorizer.authorize(req("secret"), "read").tenantId, "customer-one");
});

test("unsafe tenant IDs are rejected from auth configuration", () => {
  assert.throws(
    () => createScopedAuthorizer({
      keys: [{ id: "bad", secret: "secret", tenantId: "../escape", scopes: ["read"] }]
    }),
    /tenantId must match/
  );
});
