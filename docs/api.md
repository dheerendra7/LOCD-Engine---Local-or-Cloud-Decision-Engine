# HTTP API

## GET /health

Returns service readiness metadata.

    {
      "status": "ok",
      "service": "locd-api",
      "version": "0.1.0"
    }

## POST /v1/decide

Accepts a workload, constraints, policy and normalized execution targets.

### Request

    {
      "workload": {
        "type": "llm-inference",
        "sensitivity": "high",
        "requiredCapabilities": ["text-generation"]
      },
      "constraints": {
        "latencyBudgetMs": 800,
        "maxCostUsd": 0.05,
        "strictLatency": true,
        "strictCost": true
      },
      "policy": {
        "sensitiveDataMode": "local-only",
        "allowedModes": ["local", "private", "cloud", "hybrid"],
        "allowedRegions": [],
        "blockedModes": []
      },
      "targets": [
        {
          "id": "local-gpu",
          "mode": "local",
          "health": 0.98,
          "capacity": 0.2,
          "privacy": 1,
          "estimatedLatencyMs": 420,
          "estimatedCostUsd": 0,
          "available": true,
          "regions": ["local"],
          "capabilities": ["text-generation"]
        }
      ]
    }

### Response

A successful decision returns:

- decisionVersion: version of the decision contract.
- route: selected mode, or none.
- targetId: selected target, or null.
- confidence: deterministic margin signal from 0 to 1.
- score: normalized decision score.
- estimated: selected target latency/cost estimate.
- reasons: positive explanations for the selected candidate.
- alternatives: other eligible candidates ranked below the winner.
- rejected: hard-rejected candidates and rule reasons.
- evaluated: full candidate trace for audit/debugging.

### Hard-constraint behavior

With strict constraints enabled, missing telemetry is treated as a rejection:

- missing latency estimate -> latency_estimate_missing
- missing cost estimate -> cost_estimate_missing

This is intentional: a system must not claim an SLO or budget constraint is satisfied when the corresponding estimate is unknown.

### Errors

Malformed JSON and validation failures return HTTP 400.

Unsupported methods return HTTP 405.

Oversized request bodies are rejected before decision evaluation.

## Integration boundary

The HTTP API accepts normalized targets. Provider-specific integrations should live behind adapters that translate live infrastructure state into that normalized shape.

Execution is intentionally a separate concern:

    POST /v1/decide
          |
          v
       Decision
          |
          v
       Executor
          |
          v
    Provider Adapter

This keeps policy and placement logic testable without requiring real GPUs or paid cloud APIs.

## GET /v1/decisions

Returns a bounded list of recent decision metadata. The API intentionally does not persist prompts, completions or provider credentials.

Optional query parameter:

    /v1/decisions?limit=25

## GET /v1/metrics

Returns in-memory aggregate decision metrics:

    {
      "totalDecisions": 42,
      "routes": {
        "local": 25,
        "private": 8,
        "cloud": 7,
        "none": 2
      },
      "estimatedCostUsd": 0.43,
      "averageEstimatedLatencyMs": 318.5,
      "averageConfidence": 0.84
    }

V1 telemetry is process-local and bounded. A durable production event pipeline is a later milestone.

## GET /v1/policies

Returns the built-in policy profiles for dashboard and client discovery.

A request can select a profile with policy.profile and override individual fields without changing the underlying preset definition.

