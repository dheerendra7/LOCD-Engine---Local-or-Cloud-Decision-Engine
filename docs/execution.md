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

## API execution

The public execution endpoint is POST /v1/execute.

For safety, live mode has two explicit gates:

1. LOCD_EXECUTION_ENABLED=true
2. LOCD_API_KEY configured and supplied by the caller

This prevents a server that has been deployed with provider credentials from accidentally becoming a public execution proxy.

Configured provider adapters are registered from LOCD_PROVIDERS_FILE and become live execution targets. Static target snapshots do not expose live execution and receive a dry-run-only fallback.
