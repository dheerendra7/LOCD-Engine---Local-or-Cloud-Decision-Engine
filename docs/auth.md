# API Authorization

LOCD supports a legacy single API key and optional scoped API keys.

## Legacy key

Set:

    LOCD_API_KEY=...

A configured legacy key is treated as an admin credential for backward compatibility.

## Scoped keys

Set LOCD_API_KEYS_JSON to a JSON array. The JSON stores only environment-variable references, not secret values.

Example:

    [
      {
        "id": "dashboard-reader",
        "secretEnv": "LOCD_DASHBOARD_KEY",
        "tenantId": "acme",
        "scopes": ["read"]
      },
      {
        "id": "decision-service",
        "secretEnv": "LOCD_DECISION_KEY",
        "scopes": ["decide", "telemetry"]
      },
      {
        "id": "executor",
        "secretEnv": "LOCD_EXECUTOR_KEY",
        "scopes": ["execute"]
      },
      {
        "id": "target-operator",
        "secretEnv": "LOCD_TARGET_OPERATOR_KEY",
        "scopes": ["targets", "read"]
      }
    ]

Each scoped credential may be bound to a tenant with tenantId. Tenant identifiers are normalized and validated server-side. The tenant is taken from the authenticated credential, never from the workload request body.

Legacy LOCD_API_KEY access remains bound to LOCD_LEGACY_TENANT_ID (default: default).

Supported scopes:

- read — policies, targets, decisions and metrics
- decide — placement decisions and hybrid plans
- telemetry — outcome feedback
- targets — target registration, removal, heartbeats and probes
- execute — execution endpoint
- admin — all scopes

A request with valid credentials but insufficient scope receives HTTP 403 with insufficient_scope.

The live execution endpoint requires both LOCD_EXECUTION_ENABLED=true and a credential with execute or admin.

In production, keep secret values in the platform secret manager/environment and commit only the provider/auth JSON structure that references those variables.
