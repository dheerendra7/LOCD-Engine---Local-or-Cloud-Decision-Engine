# LOCD Architecture

## Design principles

1. Constraints before scoring. A policy violation is not made acceptable by a high score.
2. Explainability by default. Every decision records the selected target, score, confidence and reasons.
3. Determinism. The same normalized input produces the same decision.
4. Core isolation. The engine does not depend on HTTP, a database or a specific provider.
5. Vendor neutrality. Targets describe normalized capabilities and operating properties.
6. Fail closed for policy. Missing data must not silently weaken a required policy.

## Decision pipeline

    raw request
       |
       v
    validation + defaults
       |
       v
    candidate normalization
       |
       v
    hard-constraint filtering
       |
       +--> no eligible target --> NO_ROUTE
       |
       v
    soft scoring
       |
       v
    deterministic tie-break
       |
       v
    explanation + confidence

## V1 hard constraints

- target available
- required capabilities present
- strict maximum latency satisfied
- strict maximum cost satisfied
- residency compatible
- privacy policy does not forbid the target

## V1 soft signals

- privacy fit
- latency fit
- cost fit
- capacity headroom
- target health/reliability

The future executor should remain outside the core:

    Decision -> Executor -> Provider Adapter

Hybrid execution can later be represented as a multi-step plan, for example local redaction -> private/cloud inference -> local post-processing.
