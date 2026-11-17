import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TENANT_ID,
  normalizeTenantId,
  scopeKey,
  tenantFromAuthContext
} from "../src/index.js";

test("normalizes tenant identifiers deterministically", () => {
  assert.equal(DEFAULT_TENANT_ID, "default");
  assert.equal(normalizeTenantId(" Acme-Prod "), "acme-prod");
  assert.equal(scopeKey("Acme-Prod", "target:1"), "acme-prod:target:1");
});

test("rejects unsafe tenant identifiers", () => {
  for (const value of ["", "../escape", "tenant/a", "tenant with spaces", "x".repeat(64)]) {
    assert.throws(() => normalizeTenantId(value), /tenantId must match/);
  }
});

test("tenant context must come from authenticated context", () => {
  assert.equal(
    tenantFromAuthContext({ ok: true, tenantId: "Tenant-1" }),
    "tenant-1"
  );
  assert.throws(
    () => tenantFromAuthContext({ ok: false }),
    /authenticated tenant context/
  );
});
