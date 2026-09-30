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
- Browser dashboard shell.
- Structured observability utilities with secret redaction.
- Node built-in tests and GitHub Actions CI.

## Quick start

Requirements: Node.js 22+ (Node 22 and 24 are supported CI runtimes).

    npm test
    npm start

Then open http://localhost:8787/.

Decision endpoint:

    POST /v1/decide

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
                v
          telemetry/audit

The core is independent of HTTP, storage and UI so it can later power SDKs, a CLI, workers or embedded deployments.

## Roadmap

### Shipped foundation

Decision core, hard/soft policy semantics, explainability, hybrid planning, target registry, resource-fit checks, metadata-only telemetry with outcome feedback, browser dashboard, HTTP API, SDK, CLI, authentication baseline, Docker/Render deployment config, tests and CI.

### Next

Live health/utilization probes and provider adapters, durable production telemetry, persistent database-backed control-plane state, execution adapters, richer policy language, rate limiting and scoped authorization.

### Later

Multi-tenant control plane, advanced optimization, provider-specific execution integrations and calibrated placement models.

## Status

Early engineering foundation. Not production-certified yet. Provider availability, telemetry and cost estimates must be validated in the target environment.

## License

MIT.

## CLI

The repository also includes a dependency-free CLI package.

    node packages/cli/bin/locd.mjs health
    node packages/cli/bin/locd.mjs metrics
    node packages/cli/bin/locd.mjs decide examples/decision-request.json

Use --base-url to target a remote LOCD deployment.
