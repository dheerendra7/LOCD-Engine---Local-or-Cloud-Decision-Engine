# Shared Coordination

LOCD keeps the core decision engine independent from distributed infrastructure.

For a single-process deployment, the default in-memory rate limiter and idempotency store are sufficient.

For a multi-instance deployment, inject a coordination store that implements:

- get(key)
- set(key, value, options)
- setIfAbsent(key, value, options)
- delete(key)
- incr(key, options)
- deleteIfValue(key, expectedValue) — atomic compare-and-delete
- setIfValue(key, expectedValue, value, options) — atomic compare-and-set

All backends used for coordinated idempotency must implement the two compare operations. The idempotency store fails at construction if either operation is missing; it never silently falls back to an unsafe read-then-write sequence. Rate limiting alone still uses the base contract.

The contract is asynchronous so the backing system can be Redis, a database-backed service, or another atomic shared-state implementation.

## Coordinated rate limiting

The fixed-window limiter uses an atomic increment per client/bucket. The API prefixes the client identity with the authenticated tenant so identical client addresses in different tenants do not consume the same quota bucket. The backend must make increment operations atomic across instances.

## Coordinated idempotency

Completed POST responses can be stored in shared state and replayed by another instance. The API prefixes idempotency scopes with the authenticated tenant so an idempotency key is never replayed across tenants.

A claim carries an opaque owner token and a bounded lease. The built-in in-memory and coordinated idempotency stores renew that lease while the API request is still processing. Renewal uses the current owner token and, for shared stores, atomic compare-and-set; a stale owner cannot extend a replacement claim. The API releases its claim when an operation fails before producing its side effect, and only commits a completed response if the same claim still owns the key. If response caching fails after the side effect has been produced, the claim is deliberately retained until its lease expires rather than immediately allowing a duplicate operation.

If an application injects a custom `idempotencyStore`, implement `renew(scope, key, body, claimToken, lockTtlMs)` with owner-token fencing to receive the same long-running request protection. Without that optional method, the custom store's claim remains bounded only by the initial `LOCD_IDEMPOTENCY_LOCK_TTL_MS` lease. In-memory, SQLite and HTTP State Service coordination backends provide the atomic compare operations; custom distributed backends must implement them with native CAS/transactions rather than a separate GET followed by SET or DELETE.

## Important boundary

The current repository ships the coordination contract and in-memory implementation. It does not pretend that the in-memory backend is distributed.

The GET /v1/status endpoint reports:

    rateLimitMode: "process-local" | "shared"
    idempotencyMode: "process-local" | "shared"

The status values reflect the server instance configuration.

## Operational recommendation

Use shared coordination before putting more than one LOCD API instance behind a load balancer. Keep telemetry storage, rate limiting and idempotency semantics on the same operational consistency model.

## SQLite backend

LOCD includes a SQLite implementation of the shared coordination contract. It supports atomic set-if-absent and increment operations across separate connections to the same database file.

This provides cross-process coordination on one host or shared filesystem. Multi-host deployments still require a network-accessible shared coordination service.

## Network state service

LOCD can use a remote state service for coordination-backed rate limiting and idempotency.

Set:

    LOCD_COORDINATION_URL=http://state-service:8890
    LOCD_COORDINATION_API_KEY=...

When LOCD_STATE_DB_FILE is also configured, the local SQLite coordination backend takes precedence.

The reference state service in apps/state-service is backed by SQLite and exposes the coordination contract over authenticated HTTP. It is intended for a controlled internal network and does not by itself provide a highly available distributed datastore.

Do not expose the state service directly to the public internet without an authenticated network boundary, TLS and additional operational controls.

## Shared telemetry and coordination

LOCD_STATE_SERVICE_URL is the combined network state mode. It uses the same State Service for telemetry and coordination, so separate API instances share decisions, outcomes, rate-limit counters and idempotency state.
