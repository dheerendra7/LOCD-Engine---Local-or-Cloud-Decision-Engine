# Network State Service

The reference State Service is a small internal HTTP service backed by SQLite.

It lets multiple LOCD API instances share:

- rate-limit counters
- idempotency responses
- decision telemetry

The service uses the same normalized metadata-only telemetry contract as the API.

## Run locally

Set:

    LOCD_STATE_DB_FILE=./data/locd-state.db
    LOCD_STATE_SERVICE_API_KEY=change-me

Run:

    npm run start:state

Then point each LOCD API instance at:

    LOCD_COORDINATION_URL=http://localhost:8890
    LOCD_COORDINATION_API_KEY=change-me

The API can use LOCD_STATE_SERVICE_URL to share both decision telemetry and coordination state across API instances. LOCD_COORDINATION_URL remains available when only shared coordination is needed.

## Multi-host boundary

This reference service removes the API process-local coordination limitation, but the service itself is a single state authority. Run it behind a private network boundary, TLS/reverse proxy and durable storage.

It is not a highly available distributed database.

## Security

Set LOCD_STATE_SERVICE_API_KEY to a strong secret. The service supports bearer credentials and X-LOCD-State-API-Key.

Do not expose /v1/state/* to untrusted public clients.

## API

Public liveness:

    GET /health

Authenticated state endpoints:

    POST /v1/state/decisions
    GET  /v1/state/decisions?limit=50
    GET  /v1/state/metrics
    POST /v1/state/outcomes/:id
    POST /v1/state/telemetry/clear
    POST /v1/state/coordination/clear

    GET    /v1/state/kv/:key
    PUT    /v1/state/kv/:key
    POST   /v1/state/kv/:key/set-if-absent
    POST   /v1/state/kv/:key/incr
    DELETE /v1/state/kv/:key

The coordination endpoints expose only primitive shared-state operations. Product routing policy remains in the LOCD API/core engine.
The two clear operations are intentionally separate so telemetry cleanup cannot reset coordination state and vice versa.


## Tenant context

The LOCD API sends the authenticated tenant context to the State Service through the internal X-LOCD-Tenant-ID header. The State Service authenticates the calling service separately and uses that trusted context to partition decision telemetry and outcome lookup.

Do not expose the State Service directly to untrusted clients. The tenant header is an internal service-to-service trust boundary, not a replacement for public API authentication.
