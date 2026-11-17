## JSON request media types

All body-bearing API endpoints require a JSON media type. `application/json` and structured JSON suffixes such as `application/*+json` are accepted; media-type parameters are ignored. Missing or unsupported content types return HTTP 415 before request-body parsing.

## Request IDs

Every HTTP response includes an `X-Request-ID`. Callers may supply a request ID for distributed correlation; it is accepted only when it matches LOCD's safe request-ID character set and length limit. Invalid, control-character-containing or otherwise unsafe values are replaced with a generated UUID so structured logs cannot be split or forged through the correlation field.

## Error handling

Malformed client input returns a stable 4xx response. Unexpected server or dependency failures return 500 with an `internal_server_error` code and the request ID. An internal State Service request timeout is a dependency-availability case and returns HTTP 503 with `state_service_unavailable`. The internal error message is logged as a structured server-side event and is not returned to the caller. Use the request ID with deployment logs to correlate the failure without exposing internal credentials, storage paths or dependency details.

## Request size limits

JSON request bodies are bounded by `LOCD_MAX_BODY_BYTES` (default 1 MB). A declared `Content-Length` above the limit is rejected before the request body is consumed. Chunked requests are counted as they arrive and are rejected as soon as the cumulative UTF-8 byte count exceeds the configured limit.

Oversized requests return HTTP 413 with the stable `request body too large` error. This limit protects both the public API and the internal State Service from oversized payload buffering.

# HTTP API

## GET /health

Returns service readiness metadata.

    {
      "status": "ok",
      "service": "locd-api",
      "version": "0.1.0"
    }

## GET /ready

Returns deployment readiness based on the API's critical backing stores.

- HTTP `200` with `status: "ready"` when all configured checks pass.
- HTTP `503` with `status: "not_ready"` when a dependency check fails.
- `checks` reports telemetry, target registry, policy store, and coordination state.

The endpoint is intended for load balancers and orchestrators. A `503` must remove the instance from service until the dependency recovers.

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
- rejected: hard-rejected candidates and rule reasons, including `circuit_breaker_open` and `circuit_breaker_half_open_busy`.
- evaluated: full candidate trace for audit/debugging, including circuit state for registered targets.

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

Returns in-memory aggregate decision metrics. `estimatedCostUsd` is the subtotal of known estimates only; use `estimatedCostKnownCount` and `estimatedCostUnknownCount` to determine whether that subtotal covers every decision. An unknown estimate is not counted as zero.

    {
      "totalDecisions": 42,
      "routes": {
        "local": 25,
        "private": 8,
        "cloud": 7,
        "none": 2
      },
      "estimatedCostUsd": 0.43,
      "estimatedCostKnownCount": 38,
      "estimatedCostUnknownCount": 4,
      "averageEstimatedLatencyMs": 318.5,
      "averageConfidence": 0.84
    }

V1 telemetry is process-local and bounded. A durable production event pipeline is a later milestone.

## Policies

### GET /v1/policies

Returns built-in policy profiles plus authenticated tenant-scoped custom policies.

A request can select a built-in or custom profile with policy.profile and override individual fields without changing built-in preset definitions.

### GET /v1/policies/:id

Returns one built-in profile or the authenticated tenant's custom policy.

### POST /v1/policies

Creates a custom tenant policy or creates a new version of an existing custom policy. Requires admin scope. Built-in policy IDs are read-only.

### PUT /v1/policies/:id

Creates or versions the named custom tenant policy. The path ID is authoritative; built-in policy IDs cannot be overwritten.

### GET /v1/policies/:id/history

Returns the bounded version history for an authenticated tenant's custom policy.

### POST /v1/policies/:id/rollback

Creates a new policy version from a selected historical version. Requires admin scope.

### DELETE /v1/policies/:id

Removes an authenticated tenant's custom policy. Built-in profiles cannot be deleted.

Policy state can be persisted with LOCD_POLICIES_FILE. The file-backed store serializes concurrent writes inside the API process and writes snapshots atomically. Hosted deployments with ephemeral filesystems still need durable storage or a managed configuration backend for restart persistence.

When LOCD_STATE_SERVICE_URL is configured, the API uses the State Service policy store instead of LOCD_POLICIES_FILE. This makes tenant custom policies shared across API instances and persists version history in the State Service SQLite database.


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

LOCD can enable API-key authentication by setting LOCD_API_KEY. Scoped credentials can additionally carry a trusted tenant binding.

When enabled:

- GET /health remains public for health checks.
- All /v1/* endpoints require either Authorization: Bearer <key> or X-LOCD-API-Key: <key>.
- Invalid or missing credentials return HTTP 401.

For production deployments, use a high-entropy secret from the platform secret manager. Do not commit the key to Git.

## Tenant isolation

When a scoped API credential has tenantId, the authenticated request is evaluated inside that tenant's control-plane namespace.

Tenant isolation covers:

- target registry and target IDs
- decision telemetry and outcome lookup
- calibration state
- idempotency keys
- rate-limit identity

The request body must not be used to select a tenant. Request-scoped targets are evaluated directly for the authenticated tenant but are not persisted into another tenant.

The existing single-tenant mode maps to the default tenant and remains backward-compatible.

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

Each step contains a stable id, purpose and targetId, plus optional dataSensitivity (which defaults to the workload sensitivity). Conditional policy rules are evaluated independently for each step using its effective sensitivity, the workload type and declared required capabilities. A rule matched by at least one step is listed once in policyRulesApplied.

The planner returns:

- valid: whether every step satisfies hard policy/availability checks
- steps: normalized stage information
- policyRulesApplied: unique IDs of rules matched by one or more stages
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

Outcome feedback is a write-once transition from pending to success or failure. A second update for an already completed decision returns HTTP 409 with `decision_already_completed`; send an Idempotency-Key when retrying the same feedback request so the original response is replayed instead of attempting a second transition.

Calibration fields in GET /v1/metrics include successRate, meanAbsoluteLatencyErrorMs and meanAbsoluteCostErrorUsd when enough observed data exists.


## Retry safety

All POST, PUT and PATCH endpoints under /v1 support an optional Idempotency-Key header.

When the same key and request body are received within the bounded retention window, LOCD returns the original response and sets Idempotency-Replayed: true. While the original request is processing, the built-in idempotency stores renew its owner-fenced lease so work that takes longer than the initial lock TTL remains protected from concurrent duplicate execution.

Reusing the same key with a different request body returns HTTP 409 with error idempotency_key_reused. A concurrent duplicate that arrives while the original request is still running returns HTTP 409 with error idempotency_request_in_progress.

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

Executes a planner-authorized execution plan against server-registered adapters.

- mode: dry-run or live; dry-run is the default
- includeOutputs: optional boolean; successful adapter results are returned only when true
- timeoutMs: optional execution timeout
- failFast: optional boolean, default true
- plan: planner-issued plan; optional per-step payloads may be attached after planning
- executionAuthorization: required signed authorization for live mode

A caller-provided `plan.valid: true` is not proof of validation. Live execution requires an HMAC authorization issued by `POST /v1/hybrid-plan` for a valid plan built from the authenticated tenant's registered targets. Request-scoped targets remain simulation-only and never receive a live-execution authorization.

The authorization binds the plan structure and tenant, expires after `LOCD_EXECUTION_PLAN_TTL_MS` (default 600 seconds; maximum 15 minutes), and excludes only each step's runtime `payload` field so payloads can be supplied at execution time. Any change to routing, target identity, sensitivity, or other signed plan fields invalidates the authorization. Each authorization is single-use. The consumed-token claim is stored in the coordination backend until expiry; without a shared coordination backend, single-use enforcement is process-local. An idempotent retry replays the original execution response without invoking providers again.

Before a provider is invoked, LOCD verifies the signature and tenant, reloads the tenant's registered targets, re-evaluates the plan against current policy and circuit-breaker state, and rejects stale or newly ineligible plans with HTTP 409. A target removed, unavailable, policy-rejected, or circuit-open since planning cannot be executed using an old authorization.

Live execution requires `LOCD_EXECUTION_ENABLED=true`, authentication with execute/admin scope, a configured `LOCD_EXECUTION_PLAN_SECRET` of at least 32 bytes, and an enabled rate limiter. The same plan secret must be configured on every API instance that may issue or consume the authorization. Configure shared atomic coordination (SQLite on a shared host or the network State Service) for fleet-wide single-use token claims. Missing signing configuration returns HTTP 503; an unsigned, expired, modified or cross-tenant authorization is rejected before provider admission.

Static target snapshots receive dry-run-only execution adapters. They cannot be used for live execution.

Execution receipts remain metadata-only. Caller-scoped results are not written to telemetry.

For live execution, each registered target must also pass circuit admission immediately before its provider adapter is called. Targets with open circuits or an active half-open probe return failed step receipts with `circuit_breaker_open` or `circuit_breaker_half_open_busy`; no provider call is made for those steps.

## Scoped authorization

The API accepts either the legacy LOCD_API_KEY or scoped credentials configured through LOCD_API_KEYS_JSON.

Scoped credentials are resolved from environment-variable references. A valid credential without the required route scope returns HTTP 403 with insufficient_scope.

Live execution requires execute or admin scope in addition to LOCD_EXECUTION_ENABLED=true.

## Policy rules

A decision request may include policy.rules for workload-aware overrides. Rules match workload context and are applied from low to high priority, with declaration order breaking ties.

Decision responses expose policyRulesApplied and include policy_rule_applied:<id> in explanation reasons for matched rules.

## Operational endpoints

### GET /ready

Public readiness endpoint. Returns HTTP 200 when the API process is initialized.

### GET /v1/reliability

Returns authenticated, tenant-scoped provider outcome and circuit-recovery analytics. The endpoint accepts:

- `windowMs`: aggregation window in milliseconds (default 24 hours; maximum is the configured history retention).
- `limit`: number of recent events to include (1–100, default 50).

The response contains summary success/failure rates, 24 time buckets, per-provider breakdown and recent operational events. It also includes an SLO evaluation with observed availability, error-budget burn/consumption, overall and per-provider status, and threshold alerts. Default policy: 99.9% availability target, 20 minimum outcomes, warning at 2× budget burn and critical at 5×. When sample volume is below the threshold, status is `insufficient_data`; when retention eviction or event-write gaps make the history incomplete, status is `incomplete_data` and alerts are suppressed. The SLO error-budget measurement applies to the requested history window, not a rolling monthly commitment unless the caller requests a 30-day retention/window configuration.

SLO alerts are returned by the API and displayed in the dashboard; they are read-only evaluations and do not send email, webhook, PagerDuty or other notifications. It records provider IDs, timestamps, operation source and circuit transitions only; prompts, request payloads, completions, provider response bodies and credentials are not stored. Event history uses the same atomic coordination backend as circuit state, so SQLite/State Service deployments share it across instances. Without a shared backend, history is process-local.

History is bounded per tenant: defaults are seven days and 2,000 events, configurable with `LOCD_CIRCUIT_BREAKER_HISTORY_RETENTION_MS` and `LOCD_CIRCUIT_BREAKER_HISTORY_MAX_ENTRIES`. SLO configuration uses `LOCD_RELIABILITY_SLO_TARGET`, `LOCD_RELIABILITY_SLO_MIN_SAMPLES`, `LOCD_RELIABILITY_SLO_WARNING_BURN_RATE` and `LOCD_RELIABILITY_SLO_CRITICAL_BURN_RATE`. The endpoint reports event eviction and process-local write gaps; it is operational analytics, not a permanent audit log.

### GET /v1/status

Authenticated operational snapshot for operators and dashboards. The response contains safe counts and capability flags, not credentials or workload payloads.

It includes target count, probeable target count, execution adapter count, decision count, execution-enabled state, persistence flags, automatic-probing state, circuit-breaker backend and open/half-open/closed target counts. The additive `circuitBreakers` object contains the effective failure threshold, failure window, cooldown and probe-lease durations, plus one safe detail row per registered target (`targetId`, `state`, `failureCount`, `openedAt`, `retryAt` and `probeInFlight`). It never returns internal probe ownership tokens. Target details and counts are evaluated against the authenticated tenant's registry and breaker namespace.

The capability flags are derived from each store's declared contract, not merely from whether a store object was supplied. `sharedCoordination` is true only when the coordination backend declares `shared: true`; `durableCoordination` reflects `durable: true`. A process-local in-memory coordination store therefore remains process-local even though it supports atomic operations within one process.

Derived capability modes use `shared` for explicitly shared stores, `durable-local` for durable stores that do not claim cross-instance sharing, and `process-local` when neither capability is declared. Concrete backend labels such as `sqlite`, `network` or `file` may still be supplied for diagnostics, but a `process-local` label cannot override a store that declares stronger capabilities. Circuit-breaker state is reported as shared only when the coordination store supports the required atomic compare-and-set operations and explicitly advertises shared capability. Rate-limit and idempotency modes report the capabilities of their effective backing adapters. `rateLimitMode` is `disabled` when the configured request limit is zero, regardless of which store is available.

### Graceful shutdown

The production bootstrap handles SIGTERM and SIGINT by stopping automatic probing first and then closing the HTTP server. Shutdown events are emitted through the structured logger.

## Telemetry calibration

Set LOCD_CALIBRATION_ENABLED=true to allow completed outcome telemetry to adjust target latency and cost estimates per target/workload pair.

Calibration waits for a configurable minimum sample count before changing estimates. Factors are bounded to prevent a single anomalous observation from producing an unbounded routing shift.

GET /v1/calibration returns the current calibration configuration and in-memory model state.

When durable telemetry is enabled, the API rebuilds calibration state from retained completed decision events at startup, replaying feedback in outcome-time order. Calibrated cost factors adjust either explicit target estimates or the active rate fields for flat, per-request and per-1k-token pricing.

## Cost estimation

A target can provide optional pricing metadata:

    {
      "pricing": {
        "unit": "per-1k-tokens",
        "currency": "USD",
        "inputUsdPer1kTokens": 0.003,
        "outputUsdPer1kTokens": 0.012
      }
    }

Workloads can provide inputTokens, outputTokens and requests. When target.estimatedCostUsd is absent, the decision engine derives estimatedCostUsd from pricing. Explicit target estimates always take precedence.

Supported pricing units are flat, per-request and per-1k-tokens. Unsupported currencies are rejected instead of silently converting or inventing exchange rates.

## Utilization-aware calibration

Calibration is bucketed by target utilization so estimates can adapt to load conditions.

Default bands:
- low: utilization <= 0.25
- moderate: utilization <= 0.60
- high: utilization <= 0.85
- saturated: utilization > 0.85

Targets use their capacity value as the current utilization signal. Historical telemetry without utilization remains in an unknown bucket and can be used as a fallback until enough band-specific observations exist.

The calibration endpoint exposes these bands through config.utilizationBands.


## POST /v1/policies/simulate

Runs a deterministic, read-only what-if comparison between currentPolicy and candidatePolicy using the canonical decision engine.

Request:

    {
      "workload": { "type": "llm-inference", "sensitivity": "high" },
      "constraints": { "latencyBudgetMs": 800, "maxCostUsd": 0.05 },
      "currentPolicy": { "profile": "balanced" },
      "candidatePolicy": { "profile": "localFirst" },
      "targets": []
    }

When targets is omitted or empty, the authenticated tenant's registered targets are evaluated. Custom policy profiles are resolved inside the authenticated tenant namespace.

A simulation never persists a policy, records a decision telemetry event, invokes a provider, or executes a plan. The optional Idempotency-Key only stores the replay response according to the normal API retry-safety rules.

The response includes current/candidate decisions and impact deltas for route, target, score, confidence, latency, cost, reasons, policy rules and rejection causes.

## Custom policies

GET /v1/policies returns built-in profiles plus the authenticated tenant custom policies. POST /v1/policies creates or versions a tenant custom policy and requires admin scope. GET /v1/policies/:id/history returns bounded policy versions. DELETE /v1/policies/:id removes a tenant custom policy; built-in profiles cannot be deleted or overwritten.

A custom policy references a built-in baseProfile and may override supported policy fields and rules. When /v1/decide receives that custom policy ID, the server resolves the stored tenant policy before decision evaluation. The caller cannot select another tenant's custom policy.
