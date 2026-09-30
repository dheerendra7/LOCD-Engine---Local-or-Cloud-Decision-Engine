# Target Adapter Contract

LOCD's decision core consumes normalized target snapshots rather than provider SDK objects.

An adapter implements a stable identity and a getSnapshot operation.

Example shape:

    {
      id,
      getSnapshot()
    }

The normalized target contract contains:

- id
- mode
- available
- health
- capacity
- privacy
- estimatedLatencyMs
- estimatedCostUsd
- regions
- capabilities

## Provider boundary

A future provider integration can translate vendor-specific state into this contract.

    Ollama adapter
       |
       +--> GPU utilization
       +--> model availability
       +--> queue depth
       +--> measured latency
       |
       v
    normalized snapshot
       |
       v
    LOCD decision engine

    Cloud provider adapter
       |
       +--> regional availability
       +--> quota
       +--> pricing estimate
       +--> health/latency probe
       |
       v
    normalized snapshot

Provider adapters should not contain routing policy. Policy remains centralized in LOCD.

The current V1 includes a static adapter for testing, simulation and deterministic demos. Live provider adapters are a separate integration layer.

## Probe lifecycle

Adapters that implement probe() can be refreshed through the generic registry.

    adapter.probe()
        |
        v
    normalized snapshot
        |
        v
    registry.probe()
        |
        +--> optional persistence
        |
        v
    decision engine

The probe result becomes the current target state. A decision policy can then reject stale targets using maxHeartbeatAgeMs.
