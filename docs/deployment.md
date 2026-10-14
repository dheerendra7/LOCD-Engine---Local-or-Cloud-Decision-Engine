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

## CI runner reproducibility

The CI workflow pins GitHub-hosted Linux jobs to `ubuntu-24.04` instead of `ubuntu-latest`. GitHub has announced that `ubuntu-latest` will migrate to Ubuntu 26.04 during October-November 2026, so the explicit label keeps the test environment stable until the project intentionally upgrades it. citeturn163986search10turn163986search0

## Runtime version

The repository pins Render's Node.js runtime to `24.21.0` through `.node-version`. The package engine range is bounded to Node.js `>=22.16.0 <25`, and the Docker image is pinned to `node:24.21.0-alpine3.24`. CI continues to exercise the supported 22.x and 24.x lines.

Keeping an upper bound prevents an unrelated future Node major from silently changing deployment behavior.

## Docker

Build and run locally:

    docker compose up --build

Then open:

    http://localhost:8787/

## Container deployment

The Docker image runs the application as the unprivileged `node` user. The Compose configuration mounts `/data` as a named persistent volume and configures `LOCD_STATE_DB_FILE=/data/locd.db`, so the reference container deployment keeps telemetry, coordination and policy state across container restarts.

For production, place a TLS-terminating reverse proxy or load balancer in front of the container and use managed persistent storage with backup/restore controls. The image healthcheck remains a local liveness check against `/health`.

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

For multi-instance deployments, the internal State Service also provides tenant-scoped transactional policy storage when LOCD_STATE_SERVICE_URL is configured. LOCD_POLICIES_FILE remains the local/file-backed fallback when shared state is not enabled.

## Strict production safety mode

Set `LOCD_PRODUCTION_STRICT=true` for hosted production deployments that should fail closed at startup when core control-plane safety requirements are missing.

Strict mode requires API authentication, an enabled rate limiter, durable telemetry, and durable policy state. Local development remains unchanged with the default `false`.

## Production checklist

Before production use, add:

- authentication and authorization
- secret management
- durable database-backed telemetry
- managed/shared policy storage with backup and migration controls (the built-in State Service now provides a reference shared policy store)
- persistent target registry (LOCD_TARGETS_FILE; use durable storage for hosted production)
- rate limiting
- structured logs and traces with request-correlated internal error logging
- provider credential isolation
- backups and migration strategy
- uptime/error monitoring
- SLOs for the LOCD control plane
- generic 500 responses with request-correlated server-side diagnostics

The free deployment is a useful demo and evaluation environment, not a production SLA.

## Persistent target registry

Set:

    LOCD_TARGETS_FILE=/var/lib/locd/targets.json

The server restores targets from this JSON file at startup and writes the file after target registration/removal.

The file is an operator-controlled configuration/state artifact. On managed platforms with ephemeral filesystems, attach persistent storage or use a database-backed registry before depending on restart durability.

## HTTP resource guards

The API applies explicit Node.js HTTP resource limits so incomplete requests and idle keep-alive connections cannot consume server resources indefinitely.

- `LOCD_REQUEST_TIMEOUT_MS`: maximum time to receive the full request (default 30 seconds).
- `LOCD_HEADERS_TIMEOUT_MS`: maximum time to receive HTTP headers (default 10 seconds). It must not exceed the request timeout.
- `LOCD_KEEP_ALIVE_TIMEOUT_MS`: idle keep-alive timeout (default 5 seconds).
- `LOCD_MAX_REQUESTS_PER_SOCKET`: maximum requests served per connection; `0` means unlimited.

Tune these with the deployment proxy/load balancer in mind.

## API hardening configuration

Use LOCD_MAX_BODY_BYTES to cap JSON request size.

Use `LOCD_RATE_LIMIT_RPM` to enable an in-process `/v1` rate limit. Only enable `LOCD_TRUST_PROXY=true` when the API cannot be reached directly from untrusted networks and a trusted ingress proxy appends or overwrites `X-Forwarded-For`. Configure `LOCD_TRUST_PROXY_HOPS` to the exact number of trusted proxy hops (default `1`). LOCD selects the client address by counting from the right edge of the forwarding chain, so untrusted entries on the left do not override the address appended by the trusted ingress. If the selected entry is not a valid IP address or the chain is shorter than configured, LOCD falls back to the socket peer address. Incorrect hop counts may group users behind a proxy or select the wrong address; do not turn on proxy trust without matching the real network topology.

Rate limiting is intentionally local to a process; distributed deployments need a shared limiter for a global quota.

Live execution also requires the API rate limiter to be enabled. Set `LOCD_RATE_LIMIT_RPM` to a positive value (or supply an enabled custom limiter) before enabling live execution; otherwise `POST /v1/execute` returns HTTP 503 without invoking a provider.

## HTTP security headers

The API and internal State Service add `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer` to responses. Browser-served console assets additionally receive a restrictive Content Security Policy allowing only the local application script and inline styles already embedded in the static page.

TLS termination and HSTS remain deployment-layer concerns; configure HSTS at the trusted HTTPS reverse proxy/load balancer rather than enabling it against an HTTP-only local process.

## Structured logs

LOCD emits structured JSON request lifecycle events to stdout. Use LOCD_LOG_LEVEL to control verbosity. The logger redacts credentials and other sensitive fields and does not log request bodies.

## Provider adapters

Set LOCD_PROVIDERS_FILE to load server-side provider adapters at startup. Provider credentials are referenced by environment variable name inside the JSON config; do not place secrets in the file.

Providers remain unavailable until their first successful probe unless explicitly configured with initial.available=true.

## Health and shutdown

Use `GET /health` for liveness and `GET /ready` for readiness. Both are intentionally public so load balancers and platform health checks can call them without application credentials.

The API and internal State Service allow `LOCD_SHUTDOWN_TIMEOUT_MS` (default 10 seconds) for graceful termination. During the grace window, in-flight requests can complete normally; after the deadline, established HTTP connections are force-closed so process shutdown cannot hang indefinitely.

The application handles SIGTERM/SIGINT and stops the probe scheduler before closing the HTTP listener. Unexpected request failures are logged server-side and returned to clients only as a generic 500 error with the request ID.

## Telemetry calibration

LOCD_CALIBRATION_ENABLED enables outcome-driven latency/cost estimate correction. For reproducible rollout, enable it only after the telemetry pipeline and outcome data are trustworthy.

Calibration state can be rebuilt from durable telemetry on restart.

## SQLite state backend

Set LOCD_STATE_DB_FILE to a persistent SQLite database path to enable durable decision telemetry and shared coordination from one LOCD host.

The SQLite path uses Node's built-in node:sqlite, WAL mode and a busy timeout for concurrent writers. It is appropriate for a single host or deployment that provides a reliable shared filesystem. It is not a network database for unrelated hosts.

When LOCD_STATE_DB_FILE is set, it becomes the source for telemetry persistence and coordination-backed rate limiting/idempotency.

## SQLite schema migrations

The SQLite backend tracks schema versions per component in `locd_schema_migrations`. Database initialization applies any missing migrations before the store is used. Existing legacy decision databases are upgraded in place for tenant and utilization fields, while new databases start at the latest component schema.

Keep migrations backward-compatible and additive where possible. A failed migration rolls back its transaction so the process does not continue on a partially-applied schema.

## SQLite backup and recovery

Use `npm run state:backup -- <source.db> <destination.db>` or the equivalent CLI command to create a native online SQLite backup. The backup refuses to overwrite an existing destination unless `--force` is supplied, and writes through a temporary file before the final rename. The application declares Node.js >=22.16.0 <25.0.0. CI tests Node.js 22 and 24. Native SQLite online backup support requires Node.js 22.16+.

## State Service client timeout

When the API uses the network State Service, `LOCD_STATE_CLIENT_TIMEOUT_MS` bounds each HTTP state request (default 5 seconds). A timeout is converted to a safe HTTP 503 response by the API and does not invoke a provider after the dependency timeout is detected.

## State Service HTTP resource guards

The internal State Service has its own HTTP resource limits so its trust boundary cannot be left unprotected even when it is deployed separately.

- `LOCD_STATE_SERVICE_REQUEST_TIMEOUT_MS`: maximum time to receive a complete request (default 30 seconds).
- `LOCD_STATE_SERVICE_HEADERS_TIMEOUT_MS`: maximum time to receive HTTP headers (default 10 seconds); it must not exceed the request timeout.
- `LOCD_STATE_SERVICE_KEEP_ALIVE_TIMEOUT_MS`: idle keep-alive timeout (default 5 seconds).
- `LOCD_STATE_SERVICE_MAX_REQUESTS_PER_SOCKET`: maximum requests per connection; `0` means unlimited.

## Network coordination service

For multiple LOCD API instances on different hosts, set LOCD_COORDINATION_URL and LOCD_COORDINATION_API_KEY to use the reference network state service.

The local SQLite mode remains the simpler single-host option. The network service is a coordination endpoint, not a public-facing application API.

The State Service exposes `/health` for liveness and `/ready` for readiness. Readiness checks telemetry, policy and coordination storage and returns HTTP 503 while a dependency is unavailable.

## State Service authentication

The internal State Service requires `LOCD_STATE_SERVICE_API_KEY`. Its health endpoint remains public for liveness checks, but all `/v1/state/*` endpoints fail closed when the key is missing and require the configured credential.

## Multi-instance shared state

For multiple API instances, set LOCD_STATE_SERVICE_URL and LOCD_STATE_SERVICE_API_KEY to share telemetry and coordination through the internal State Service.

Use LOCD_COORDINATION_URL instead when you need shared rate limiting/idempotency without moving decision telemetry off the API process.
