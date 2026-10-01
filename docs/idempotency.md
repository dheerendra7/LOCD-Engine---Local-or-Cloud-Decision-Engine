# Idempotency

LOCD uses a claim-based idempotency lifecycle for POST operations.

    request
      |
      v
    claim key
      |
      +--> owner -> execute side effect -> remember response
      |
      +--> completed -> replay response
      |
      +--> in_progress -> HTTP 409
      |
      +--> key/body mismatch -> HTTP 409
      |
      +--> owner failure -> release claim

## Why this matters

Without a claim, two API instances can both start the same side effect before either one has written a completed response.

The claim primitive makes that race explicit.

## Retention

Claims have a bounded lock TTL. A stuck owner eventually becomes reclaimable. Successful responses remain replayable for the normal idempotency retention window.

## Backends

The local runtime store provides the same semantics inside one process.

The coordinated store uses the shared coordination contract so multiple LOCD API instances can share claims.

A production multi-host deployment should use the network State Service or another backend implementing atomic setIfAbsent, get, delete and set.