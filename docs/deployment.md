# Deployment

## Render

The repository includes render.yaml for a simple Node web-service deployment.

Current configuration:

- runtime: Node
- branch: main
- build: npm install
- start: npm start
- health check: /health
- compute plan: free

Render currently documents free web services as suitable for testing, hobby projects and previews, with limitations; they should not be treated as production infrastructure. Free web services also spin down after 15 minutes of inactivity.

Source: https://render.com/docs/free

## Docker

Build and run locally:

    docker compose up --build

Then open:

    http://localhost:8787/

## Multi-tenant deployment

Bind each scoped API credential to a tenant using its tenantId in LOCD_API_KEYS_JSON. Keep tenant identifiers stable because they become part of target, telemetry, calibration, idempotency and rate-limit namespaces.

LOCD_TARGETS_FILE now supports a versioned tenant-aware format:

    {
      "version": 1,
      "tenants": {
        "acme": [ ... ],
        "beta": [ ... ]
      }
    }

A legacy target array is still loaded into the default tenant.

The tenant model is an application-level isolation boundary. For strong production isolation, the state service/database and operational credentials must remain inside the same trusted deployment boundary.

## Policy control plane

Set LOCD_POLICIES_FILE to persist tenant-scoped custom policies and their bounded version history. Built-in profiles remain read-only. Policy mutations require an admin credential and are resolved server-side during /v1/decide.

The file is written atomically. On hosted platforms with ephemeral filesystems, use durable storage or a managed configuration backend before relying on restart persistence.

## Production checklist

Before production use, add:

- authentication and authorization
- secret management
- durable database-backed telemetry
- centralized policy storage
- persistent target registry (LOCD_TARGETS_FILE; use durable storage for hosted production)
- rate limiting
- structured logs and traces
- provider credential isolation
- backups and migration strategy
- uptime/error monitoring
- SLOs for the LOCD control plane

The free deployment is a useful demo and evaluation environment, not a production SLA.

## Persistent target registry

Set:

    LOCD_TARGETS_FILE=/var/lib/locd/targets.json

The server restores targets from this JSON file at startup and writes the file after target registration/removal.

The file is an operator-controlled configuration/state artifact. On managed platforms with ephemeral filesystems, attach persistent storage or use a database-backed registry before depending on restart durability.

## API hardening configuration

Use LOCD_MAX_BODY_BYTES to cap JSON request size.

Use LOCD_RATE_LIMIT_RPM to enable an in-process /v1 rate limit. Use LOCD_TRUST_PROXY=true only behind a trusted reverse proxy.

Rate limiting is intentionally local to a process; distributed deployments need a shared limiter for a global quota.

## Structured logs

LOCD emits structured JSON request lifecycle events to stdout. Use LOCD_LOG_LEVEL to control verbosity. The logger redacts credentials and other sensitive fields and does not log request bodies.

## Provider adapters

Set LOCD_PROVIDERS_FILE to load server-side provider adapters at startup. Provider credentials are referenced by environment variable name inside the JSON config; do not place secrets in the file.

Providers remain unavailable until their first successful probe unless explicitly configured with initial.available=true.

## Health and shutdown

Use `GET /health` for liveness and `GET /ready` for readiness. Both are intentionally public so load balancers and platform health checks can call them without application credentials.

The application handles SIGTERM/SIGINT and stops the probe scheduler before closing the HTTP listener.

## Telemetry calibration

LOCD_CALIBRATION_ENABLED enables outcome-driven latency/cost estimate correction. For reproducible rollout, enable it only after the telemetry pipeline and outcome data are trustworthy.

Calibration state can be rebuilt from durable telemetry on restart.

## SQLite state backend

Set LOCD_STATE_DB_FILE to a persistent SQLite database path to enable durable decision telemetry and shared coordination from one LOCD host.

The SQLite path uses Node's built-in node:sqlite, WAL mode and a busy timeout for concurrent writers. It is appropriate for a single host or deployment that provides a reliable shared filesystem. It is not a network database for unrelated hosts.

When LOCD_STATE_DB_FILE is set, it becomes the source for telemetry persistence and coordination-backed rate limiting/idempotency.

## Network coordination service

For multiple LOCD API instances on different hosts, set LOCD_COORDINATION_URL and LOCD_COORDINATION_API_KEY to use the reference network state service.

The local SQLite mode remains the simpler single-host option. The network service is a coordination endpoint, not a public-facing application API.

## Multi-instance shared state

For multiple API instances, set LOCD_STATE_SERVICE_URL and LOCD_STATE_SERVICE_API_KEY to share telemetry and coordination through the internal State Service.

Use LOCD_COORDINATION_URL instead when you need shared rate limiting/idempotency without moving decision telemetry off the API process.
