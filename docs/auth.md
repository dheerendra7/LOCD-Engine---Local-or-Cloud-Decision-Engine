# Scoped authorization

LOCD supports scoped API keys through a server-side JSON policy file.

Set:

    LOCD_API_KEYS_FILE=./config/api-keys.json

The file must contain key metadata only:

    {
      "keys": [
        {
          "id": "dashboard",
          "keyEnv": "LOCD_DASHBOARD_KEY",
          "scopes": ["read"]
        },
        {
          "id": "operator",
          "keyEnv": "LOCD_OPERATOR_KEY",
          "scopes": ["read", "decide", "targets:write", "telemetry:write"]
        },
        {
          "id": "executor",
          "keyEnv": "LOCD_EXECUTOR_KEY",
          "scopes": ["read", "decide", "execute", "telemetry:write"]
        }
      ]
    }

The actual credentials live in environment variables:

    LOCD_DASHBOARD_KEY=...
    LOCD_OPERATOR_KEY=...
    LOCD_EXECUTOR_KEY=...

Never put raw API keys in the JSON file.

## Scope mapping

| API surface | Scope |
| --- | --- |
| GET /v1/* | read |
| POST /v1/decide | decide |
| POST /v1/hybrid-plan | decide |
| POST /v1/outcomes | telemetry:write |
| POST /v1/targets | targets:write |
| POST /v1/targets/:id/probe | targets:write |
| POST /v1/targets/:id/heartbeat | targets:write |
| DELETE /v1/targets/:id | targets:write |
| Live POST /v1/execute | execute |

Dry-run execution remains available with the normal read/open-development path; live execution requires the execute scope plus LOCD_EXECUTION_ENABLED=true.

## Backward compatibility

LOCD_API_KEY remains supported as a legacy full-access credential. When LOCD_API_KEYS_FILE is configured, missing or invalid credentials are rejected with HTTP 401 and insufficient scopes return HTTP 403.
