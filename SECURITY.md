# Security

LOCD is early-stage software. Its implemented safeguards provide a baseline, not a certified security boundary. Do not send sensitive production data to an unreviewed deployment.

## Implemented safeguards

- API-key authentication through `LOCD_API_KEY` or scoped credentials configured with `LOCD_API_KEYS_JSON`.
- Least-privilege API scopes and tenant-scoped control-plane state for supported targets, policies, telemetry and coordination paths.
- Optional fixed-window rate limiting, with shared coordination available for multi-instance deployments.
- Request-body size limits, HTTP timeout/connection guards, request IDs, generic client errors, security headers and a restrictive dashboard content-security policy.
- Environment-backed provider credentials; provider configuration files refer to environment variable names rather than embedding secrets.
- Structured logging with secret redaction, graceful shutdown, SQLite schema migrations and integrity-checked online backups.
- Live execution is disabled by default. `LOCD_PRODUCTION_STRICT=true` fails startup unless authentication, rate limiting, durable telemetry and durable policy state are configured.

## Production deployment checklist

1. Keep API keys, provider credentials and State Service keys in deployment secrets, never in source control or browser code. Use separate credentials for separate environments and rotate them through your deployment process.
2. Enable `LOCD_PRODUCTION_STRICT=true`. Configure scoped keys with only the scopes each client needs. A single `LOCD_API_KEY` is a simpler compatibility option, not a substitute for service-specific credentials.
3. Enable a non-zero `LOCD_RATE_LIMIT_RPM`. For multiple API instances, configure the supported network State Service or coordination backend so rate limiting and idempotency state are shared.
4. Use persistent storage for `LOCD_STATE_DB_FILE` on a single host. For unrelated hosts, use the network State Service rather than treating a local SQLite file as a network database. Test restore procedures and keep backups outside the database's failure domain.
5. Keep `LOCD_EXECUTION_ENABLED=false` unless live provider execution is explicitly required. Review provider allowlists, credentials, spend limits and outbound network access before enabling it.
6. Keep `LOCD_TRUST_PROXY=false` unless the deployment is behind a trusted proxy that overwrites forwarded-client headers.
7. Keep the internal State Service private to trusted application hosts and set its own API key. Do not expose the internal coordination endpoint as a public client API.

## Known limitations

- LOCD has not been represented as externally audited, penetration-tested or compliance-certified.
- Enterprise identity features such as SSO/OIDC, centralized policy administration and automated credential rotation are not a substitute for the current API-key baseline and still require additional work.
- In-memory state is process-local. SQLite is intended for one host or a reliable shared filesystem; multi-host deployments require the supported network state path and a deployment-specific review.
- Provider health, cost and latency are estimates that must be validated in the target environment. A decision score is not a guarantee of availability, performance or savings.
