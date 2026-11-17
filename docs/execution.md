# Execution Boundary

LOCD separates **where a workload should run** from **how that workload is actually executed**.

The decision engine and hybrid planner produce normalized metadata. The execution package consumes a validated plan through an execution adapter.

## Adapter contract

An execution adapter provides:

- id
- targetId
- execute(context)

The executor passes a normalized step descriptor and execution mode. Provider-specific code owns actual credentials, transport, model calls, process management, and returned data.

## Dry-run

V1 includes a dry-run adapter for deterministic testing and demonstrations.

Dry-run receipts contain only metadata:

- stepId
- targetId
- adapterId
- status
- timestamps
- errorClass

Raw workload payloads are not stored in receipts.

## Failure semantics

Execution supports:

- fail-fast, for dependency chains where later stages should not run after an error
- continue-on-failure, for workflows where later stages are independent
- timeout classification
- missing-adapter detection
- explicit refusal to use dry-run-only adapters in live mode

## Provider integration boundary

A future adapter might wrap:

    local process / Ollama / private inference server / cloud API
                       |
                       v
                execution adapter
                       |
                       v
                LOCD executor

The adapter should not contain routing policy. LOCD remains responsible for placement decisions and policy semantics.

Live execution must be introduced as a separate, security-reviewed milestone because it creates a data-processing boundary and can incur provider costs.

## Public execution API

POST /v1/execute consumes a validated plan and routes it to server-registered execution adapters.

Dry-run is the default and uses dry-run-only fallback adapters for static target snapshots.

Live mode is gated by LOCD_EXECUTION_ENABLED=true and a configured LOCD_API_KEY. This prevents an accidental deployment from becoming an unauthenticated provider proxy.

When includeOutputs=true, successful provider responses are returned directly to the caller. They are not written to execution receipts or decision telemetry.
