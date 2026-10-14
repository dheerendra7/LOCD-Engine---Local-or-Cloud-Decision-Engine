# Execution-time policy boundary probe

## Purpose

This is a research-only, deterministic probe of the boundary between LOCD's planning policy and its live execution API. It tests whether an authenticated caller can submit a caller-constructed `plan.valid = true` plan for a cloud target that conflicts with the configured tenant policy, and whether the configured provider adapter receives the synthetic payload.

The probe uses a loopback HTTP server and an injected fake provider `fetchImpl`. It must not call a real model provider, require API keys, or send real user data.

## Run

From the repository root, with the repository's supported Node.js version installed:

```sh
node research/temporal-residency/probe.mjs
```

The script prints one JSON object containing the HTTP response status, whether the fake provider observed an outbound request, and a bounded interpretation. It does not modify application code or persistent state.

## Interpretation

- `REPRODUCED`: the supplied plan was accepted and the fake provider observed the synthetic request despite the configured tenant policy excluding that cloud mode/region. This is a reproducible policy-boundary finding in this harness, not proof of a real-world geographic residency breach.
- `NOT_REPRODUCED`: the fake provider did not observe the request. Inspect the HTTP status and response body; this alone does not prove a complete policy enforcement guarantee.
- Any result is limited to this code path and this policy configuration. It does not establish provider-side physical processing location, behavior of other adapters, or general novelty.

## Research guardrails

1. Do not use real provider credentials or payloads.
2. Do not claim physical data residency from adapter metadata alone.
3. Compare against existing execution-time authorization, egress enforcement, and policy-revocation work before making a novelty claim.
4. Keep production fixes separate from this experiment until the behavior is reproduced and the intended policy contract is confirmed.
