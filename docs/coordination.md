# Shared Coordination

LOCD keeps the core decision engine independent from distributed infrastructure.

For a single-process deployment, the default in-memory rate limiter and idempotency store are sufficient.

For a multi-instance deployment, inject a coordination store that implements:

- get(key)
- set(key, value, options)
- setIfAbsent(key, value, options)
- delete(key)
- incr(key, options)

The contract is asynchronous so the backing system can be Redis, a database-backed service, or another atomic shared-state implementation.

## Coordinated rate limiting

The fixed-window limiter uses an atomic increment per client/bucket. The backend must make increment operations atomic across instances.

## Coordinated idempotency

Completed POST responses can be stored in shared state and replayed by another instance.

The coordination package also exposes claim() using setIfAbsent(). A future execution gateway can use this primitive to prevent concurrent duplicate work before a response exists.

## Important boundary

The current repository ships the coordination contract and in-memory implementation. It does not pretend that the in-memory backend is distributed.

The GET /v1/status endpoint reports:

    rateLimitMode: "process-local" | "shared"
    idempotencyMode: "process-local" | "shared"

The status values reflect the server instance configuration.

## Operational recommendation

Use shared coordination before putting more than one LOCD API instance behind a load balancer. Keep telemetry storage, rate limiting and idempotency semantics on the same operational consistency model.
