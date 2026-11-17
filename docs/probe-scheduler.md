# Probe scheduler

The probe scheduler periodically refreshes registered target adapters through the registry's `probe()` operation.

It provides:

- bounded probe concurrency
- per-target overlap protection
- per-target success/failure result events
- explicit start/stop lifecycle
- a deterministic `runOnce()` operation for tests and one-shot jobs

The scheduler stores no workload payloads. It only consumes target IDs and normalized probe results.

Recommended deployment pattern:

    registered providers
          |
          v
      probe scheduler
          |
          v
      target registry
          |
          v
     fresh snapshots
          |
          v
      decision engine

Keep interval and concurrency settings conservative for external providers. The scheduler is process-local; multi-instance deployments should coordinate ownership or use an external scheduler to avoid duplicate probing.

## API integration

Set LOCD_PROBE_INTERVAL_MS to a positive interval to enable automatic probing from the API process. The API performs an immediate probe cycle at startup and then repeats on the configured interval.

LOCD_PROBE_MAX_CONCURRENT bounds simultaneous adapter probes.

Automatic probing is disabled by default. This avoids unexpected provider traffic and cost until an operator explicitly enables it.
