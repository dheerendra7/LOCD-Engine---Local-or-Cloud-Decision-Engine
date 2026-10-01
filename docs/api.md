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


## Target registry

### GET /v1/targets

Lists the normalized targets currently registered in the control plane process.

### POST /v1/targets

Registers a normalized target snapshot. Returns HTTP 201 on success.

### DELETE /v1/targets/:id

Removes a registered target. Returns HTTP 404 when the target does not exist.

When POST /v1/decide receives no targets in its request body, LOCD uses the registered target set. Supplying a non-empty targets array keeps request-scoped evaluation possible for simulations and advanced callers.

The registry is in-memory by default. Set LOCD_TARGETS_FILE to persist normalized target state as JSON and restore it on process startup. In containerized environments, use a persistent volume or move the registry to a database-backed store before relying on durability.


## Target heartbeat

### POST /v1/targets/:id/heartbeat

Accepts a partial target telemetry update and records a server-side lastHeartbeatAt timestamp.

Supported fields are limited to execution metadata such as availability, health, capacity, privacy, estimated latency/cost, memory/context capacity, regions and capabilities. Target identity and mode are not changed by a heartbeat.

When the target adapter does not support updates, the endpoint returns HTTP 501.

For placement policies that require fresh infrastructure telemetry, set policy.maxHeartbeatAgeMs. A candidate with a missing or stale heartbeat is rejected before scoring.

## Authentication

LOCD can enable API-key authentication by setting LOCD_API_KEY.

When enabled:

- GET /health remains public for health checks.
- All /v1/* endpoints require either Authorization: Bearer <key> or X-LOCD-API-Key: <key>.
- Invalid or missing credentials return HTTP 401.

For production deployments, use a high-entropy secret from the platform secret manager. Do not commit the key to Git.

## Resource fit

Workloads can optionally declare:

- requiredMemoryGb
- requiredContextTokens

Targets can expose:

- availableMemoryGb
- maxContextTokens

When a workload declares these requirements, missing capacity telemetry or insufficient capacity rejects the target before scoring. This keeps placement decisions from selecting infrastructure that cannot actually serve the workload.

When no request-scoped targets are supplied and the target registry is empty, POST /v1/decide returns HTTP 503 with error code no_registered_targets.


## POST /v1/hybrid-plan

Validates an explicit multi-stage hybrid execution plan against registered or request-scoped targets and policy.

Each step contains a stable id, purpose and targetId. The planner returns:

- valid: whether every step satisfies hard policy/availability checks
- steps: normalized stage information
- estimated.latencyMs: sequential sum of stage latency estimates
- estimated.costUsd: sum of stage cost estimates
- rejected: stage-level and plan-level rejection reasons

The planner is intentionally a planning layer. It does not move data, execute inference, or call providers. A future executor can consume its normalized plan.

## POST /v1/outcomes

Reports the observed result for a prior decision without sending the original workload payload.

Request example:

    {
      "decisionId": "9c2f...",
      "outcome": "success",
      "actualLatencyMs": 390,
      "actualCostUsd": 0.012
    }

Supported outcomes are success and failure. The event is matched by decisionId.

POST /v1/decide now returns decisionId so callers can correlate predicted and observed execution metadata.

Calibration fields in GET /v1/metrics include successRate, meanAbsoluteLatencyErrorMs and meanAbsoluteCostErrorUsd when enough observed data exists.


## Retry safety

All POST endpoints under /v1 support an optional Idempotency-Key header.

When the same key and request body are received within the bounded in-memory retention window, LOCD returns the original response and sets Idempotency-Replayed: true.

Reusing the same key with a different request body returns HTTP 409 with error idempotency_key_reused.

Every request also receives an X-Request-ID response header. Callers may provide their own value (up to 128 characters) for distributed tracing.

Idempotency state is process-local and bounded. Multi-instance production deployments require shared durable coordination before relying on replay behavior across replicas.


## API hardening

JSON request bodies are limited by LOCD_MAX_BODY_BYTES. Oversized bodies return HTTP 413 before route evaluation.

Set LOCD_RATE_LIMIT_RPM to a positive value to enable a process-local per-client requests-per-minute limit for /v1 traffic. Responses expose X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset. HTTP 429 responses include Retry-After.

Client identity uses the direct socket address by default. Set LOCD_TRUST_PROXY=true only when the deployment proxy is trusted and supplies X-Forwarded-For.

The limiter is process-local. Multi-instance production deployments need shared coordination for global quotas.


## Target probes

### POST /v1/targets/:id/probe

Runs a target adapter's live health probe and returns its refreshed normalized snapshot.

The adapter controls the actual probe protocol. The LOCD control plane only stores the normalized result and optionally persists it with LOCD_TARGETS_FILE.

A target without probe support returns HTTP 501. Unknown targets return HTTP 404.

The built-in OpenAI-compatible adapter probes GET /v1/models and measures round-trip latency.


## Execution

### POST /v1/execute

Executes a previously validated execution plan against server-registered adapters.

- mode: dry-run or live; dry-run is the default
- includeOutputs: optional boolean; successful adapter results are returned only when true
- timeoutMs: optional execution timeout
- failFast: optional boolean, default true
- plan: validated plan with target IDs and optional per-step payload

Live execution requires LOCD_EXECUTION_ENABLED=true and LOCD_API_KEY to be configured.

Static target snapshots receive dry-run-only execution adapters. They cannot be used for live execution.

Execution receipts remain metadata-only. Caller-scoped results are not written to telemetry.

## Scoped authorization

The API accepts either the legacy LOCD_API_KEY or scoped credentials configured through LOCD_API_KEYS_JSON.

Scoped credentials are resolved from environment-variable references. A valid credential without the required route scope returns HTTP 403 with insufficient_scope.

Live execution requires execute or admin scope in addition to LOCD_EXECUTION_ENABLED=true.
