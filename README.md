# LOCD Engine

Local-Or-Cloud Decision Engine — a vendor-neutral decision intelligence layer for choosing where a workload should run.

> Decide where compute should run.

LOCD evaluates hard constraints first, then scores eligible execution targets against latency, cost, privacy, capacity, reliability, and policy requirements. The first release is deterministic and explainable; telemetry and calibration can improve estimates later.

## Why LOCD?

Many routing systems optimize model or provider selection. LOCD focuses on a different question:

Given this workload, policy, infrastructure and SLO, where should it execute?

Possible destinations:
- local
- private
- cloud
- hybrid

## V1 capabilities

- Deterministic decision engine with hard-constraint filtering.
- Explainable decisions with rejected-candidate reasons.
- Hybrid execution planning with policy-aware multi-stage validation.
- Privacy and residency controls.
- Cost and latency budgeting.
- Capacity and health awareness.
- Optional target heartbeats with enforceable freshness policies.
- Built-in policy profiles with per-request overrides.
- Pure JavaScript core with no runtime dependency.
- HTTP API for application integration.
- Provider-neutral execution boundary with safe dry-run support.
- Explicitly gated public execution endpoint for configured provider adapters.
- Structured observability utilities with secret redaction.
- Server-side provider configuration with environment-backed secrets.
- Scoped API authorization with least-privilege execution controls.
- Browser dashboard shell.
- Live provider probes and server-side provider configuration.
- Optional automatic probe scheduling with bounded concurrency.
- Gated execution API with dry-run fallbacks and explicit live-execution controls.
- Structured request observability with secret redaction.
- Durable metadata-only telemetry option for single-process restart persistence.
- Utilization-aware calibration by target/workload load bands.
- Node built-in tests and GitHub Actions CI.

## Quick start

Requirements: Node.js 22+ (Node 22 and 24 are supported CI runtimes).

    npm test
    npm start

Then open http://localhost:8787/.

Decision endpoint:

    POST /v1/decide

Cost estimation can use target pricing metadata with workload inputTokens/outputTokens, while explicit estimatedCostUsd remains authoritative.

Example request:

    {
      "workload": { "type": "llm-inference", "sensitivity": "high" },
      "constraints": { "latencyBudgetMs": 800, "maxCostUsd": 0.05 },
      "targets": [
        {
          "id": "local-gpu",
          "mode": "local",
          "health": 0.98,
          "capacity": 0.82,
          "privacy": 1,
          "estimatedLatencyMs": 420,
          "estimatedCostUsd": 0
        }
      ],
      "policy": { "sensitiveDataMode": "prefer-local" }
    }

## Automatic provider setup

Set LOCD_PROVIDERS_FILE to a JSON configuration like examples/providers.json. Provider credentials are referenced through environment variable names, never stored in the JSON file.

When LOCD_PROBE_INTERVAL_MS is greater than zero, configured probe-capable providers are checked on startup and periodically refreshed.

## Architecture

    Client / SDK / CLI / Dashboard
                |
                v
            HTTP API
                |
                v
          Decision Service
                |
                v
         LOCD Core Engine
        /       |        \
   policy    scoring   explanation
                |
                v
      local / private / cloud
                |
                +--> provider probes
                |
                v
          execution adapters
                |
                v
          telemetry/audit

The core is independent of HTTP, storage and UI so it can later power SDKs, a CLI, workers or embedded deployments.

## Roadmap

### Shipped foundation

Decision core, hard/soft policy semantics, workload-aware policy rules, explainability, hybrid planning, target registry, resource-fit checks, metadata-only telemetry with outcome feedback, durable single-process telemetry, optional telemetry calibration, browser dashboard, HTTP API, SDK, CLI, scoped authentication, request IDs/idempotency, rate limiting, provider probes, automatic probe scheduling, OpenAI-compatible and native Ollama provider adapters, gated execution API, readiness/status endpoints, graceful shutdown, shared coordination contract, SQLite-backed state option, network state service with shared telemetry, Docker/Render deployment config, tests and CI.

### Next

Shared database/event telemetry, distributed rate-limit and idempotency coordination, utilization-aware calibration, richer provider-specific adapters and multi-instance deployment hardening.

### Later

Multi-tenant control plane and advanced optimization across fleets/providers.

## Status

Early engineering foundation. Not production-certified yet. Provider availability, telemetry and cost estimates must be validated in the target environment.

## License

MIT.

## CLI

The repository also includes a dependency-free CLI package.

    node packages/cli/bin/locd.mjs health
    node packages/cli/bin/locd.mjs metrics
    node packages/cli/bin/locd.mjs decide examples/decision-request.json
    node packages/cli/bin/locd.mjs targets
    node packages/cli/bin/locd.mjs probe local-ollama
    node packages/cli/bin/locd.mjs execute examples/execution-plan.json

Use --base-url to target a remote LOCD deployment. Set LOCD_API_KEY in the environment for protected /v1 APIs. The execute command is dry-run by default; add --live only when live execution has been explicitly enabled on the server.
