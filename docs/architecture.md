# LOCD Architecture

## Design principles

1. Constraints before scoring. A policy violation is not made acceptable by a high score.
2. Explainability by default. Every decision records the selected target, score, confidence and reasons.
3. Determinism. The same normalized input produces the same decision.
4. Core isolation. The engine does not depend on HTTP, a database or a specific provider.
5. Vendor neutrality. Targets describe normalized capabilities and operating properties.
6. Fail closed for policy. Missing data must not silently weaken a required policy.

## Decision pipeline

    raw request
       |
       v
    validation + defaults
       |
       v
    candidate normalization
       |
       v
    tenant-scoped circuit overlay
       |
       v
    hard policy/resource/circuit filtering
       |
       +--> no eligible target --> NO_ROUTE
       |
       v
    soft scoring
       |
       v
    deterministic tie-break
       |
       v
    explanation + confidence

## V1 hard constraints

- target available
- required capabilities present
- strict maximum latency satisfied
- strict maximum cost satisfied
- residency compatible
- privacy policy does not forbid the target

## V1 soft signals

- privacy fit
- latency fit
- cost fit
- capacity headroom
- target health/reliability

## Provider failure isolation

The deterministic core remains side-effect free. The API overlays tenant-scoped circuit state onto registered target snapshots before decision or hybrid-plan evaluation. Circuit-open and half-open-busy targets are hard-rejected before scoring; request-scoped target arrays remain simulation inputs and do not mutate or inherit registered provider state.

The live executor obtains a target admission permit before invoking an adapter. A closed circuit admits normal work. Reaching the configured failure threshold opens the circuit for a cooldown. After cooldown, a single owner-token-fenced half-open probe is admitted; success closes and clears the breaker, while failure reopens it with a fresh cooldown. Expired probe leases can be reclaimed, and stale probe owners cannot close a newer trial.

Circuit state uses atomic compare-and-set operations from the configured coordination store. SQLite and the network State Service therefore share breaker state across API instances. When no atomic shared backend is configured, the API uses process-local breaker state and reports that boundary in GET /v1/status.

Failover is policy-aware across subsequent decisions: once a provider is open, the normal engine re-runs capability, privacy, residency, latency, cost and health checks against the remaining candidates. LOCD does not silently replay an arbitrary failed payload to another provider inside the same execution; callers must submit a newly validated plan for another destination, preserving side-effect and data-boundary safety.

## Calibration recovery

Calibration observations are replayed in ascending observation time during startup hydration. Completed telemetry uses `outcomeTimestamp` because that is when feedback became available; legacy records fall back to the original decision `timestamp`. The replay is stable for equal timestamps and does not mutate the telemetry list. This preserves the same EWMA result after restart even when activity APIs return newest-first events.

The future executor should remain outside the core:

    Decision -> Executor -> Provider Adapter

Hybrid execution can later be represented as a multi-step plan, for example local redaction -> private/cloud inference -> local post-processing.
