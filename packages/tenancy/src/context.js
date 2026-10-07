const TENANT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export const DEFAULT_TENANT_ID = "default";

export function normalizeTenantId(value, fallback = DEFAULT_TENANT_ID) {
  const tenantId = String(value ?? fallback).trim().toLowerCase();
  if (!TENANT_PATTERN.test(tenantId)) {
    throw new Error("tenantId must match " + TENANT_PATTERN);
  }
  return tenantId;
}

export function tenantFromAuthContext(authContext, fallback = DEFAULT_TENANT_ID) {
  if (!authContext || authContext.ok !== true) {
    throw new Error("authenticated tenant context is required");
  }
  return normalizeTenantId(authContext.tenantId, fallback);
}

export function scopeKey(tenantId, key) {
  return normalizeTenantId(tenantId) + ":" + String(key);
}
