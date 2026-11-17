# Observability

LOCD uses structured JSON events so operators can trace requests without logging workload payloads or credentials.

## Logger contract

Each event may include:

- timestamp
- level
- event name
- requestId
- decisionId
- status
- durationMs
- route
- targetId
- errorClass

The logger recursively redacts authentication material, cookies, API keys, idempotency keys, tokens, passwords and secrets. Long strings and deeply nested objects are bounded.

## Request correlation

The API returns X-Request-ID. A caller can supply its own value for trace correlation.

Decision responses also return a decisionId. This ID connects decision metadata to later observed outcome feedback.

## Deployment

Write structured JSON logs to stdout in hosted environments and let the platform or log collector handle retention, search and alerting.

The logger is intentionally dependency-free so the core API does not require a third-party logging stack.
