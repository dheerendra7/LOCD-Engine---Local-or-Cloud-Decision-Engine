# State Backend Contracts

LOCD treats telemetry and coordination as replaceable state backends. The decision engine does not depend on a specific database vendor.

## Decision telemetry contract

A decision store must implement:

- `record(event)`
- `recordOutcome(id, patch, options)`
- `list(options)`
- `summary(options)`
- `clear(options)`

Tenant-aware stores accept a tenant context through the existing options shape and must never widen a tenant-scoped query into another tenant.

## Coordination contract

A coordination store must implement:

- `get(key)`
- `set(key, value, options)`
- `setIfAbsent(key, value, options)`
- `delete(key)`
- `incr(key, options)`
- `deleteIfValue(key, expectedValue)` — optional for general coordination, required for coordinated idempotency claim release
- `setIfValue(key, expectedValue, value, options)` — optional for general coordination, required for safe idempotency completion

The two compare operations must be implemented as a single atomic backend operation. A read followed by a write/delete is not equivalent, because another request can replace the claim between those steps.

The coordination abstraction is intentionally key-oriented. LOCD creates tenant-scoped namespaces before coordination keys reach the backend.

## Capabilities

Backends may expose a capabilities descriptor:

    {
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: true
    }

Meaning:

- **durable** — state survives the owning process restarting.
- **shared** — multiple LOCD processes can observe the same backend state.
- **tenantScoped** — the backend contract supports the tenant-partitioned state semantics required by LOCD.
- **transactional** — the backend can provide atomic multi-step state transitions where its implementation requires them.

These flags describe backend semantics; they are not authorization controls.

## Current implementations

| Backend | Durable | Shared | Tenant scoped | Transactional |
| --- | --- | --- | --- | --- |
| Process-local telemetry | No | No | Yes | No |
| File telemetry | Yes | No | Yes | No |
| SQLite telemetry | Yes | Yes on a shared filesystem | Yes | Yes |
| HTTP State Service telemetry | Yes | Yes | Yes | No |
| Process-local coordination | No | No | Yes via namespaced keys | No |
| SQLite coordination | Yes | Yes on a shared filesystem | Yes via namespaced keys | Yes |
| HTTP State Service coordination | Yes | Yes | Yes via namespaced keys | No |

`shared=true` on SQLite means processes that access the same database file can coordinate. It does not imply a network database.

The API validates required backend operations during server construction. This turns malformed backend wiring into an immediate startup error instead of a delayed runtime failure.

## Managed backend direction

A future managed database or event backend should implement these same contracts and expose accurate capability flags. The API and decision engine should not need vendor-specific changes to consume it.
