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

## Unknown versus zero telemetry

Optional quantitative signals such as `estimatedLatencyMs`, `estimatedCostUsd`, `availableMemoryGb` and `maxContextTokens` must remain `null` (or be omitted) when they are unknown. A numeric `0` means a real zero value has been measured or explicitly configured. Do not normalize `null` or an empty string through numeric coercion: JavaScript converts `Number(null)` and `Number("")` to zero, which can make an unpriced target appear free or unknown capacity appear measured as zero. This distinction must survive provider normalization, shared adapter normalization and registry snapshot collection.

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
