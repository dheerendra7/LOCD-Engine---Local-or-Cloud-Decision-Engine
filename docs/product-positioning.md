# Product Positioning

## Core category

LOCD is a **workload placement decision engine** rather than a model router.

The engine answers:

> Given a workload, policy, infrastructure state and SLO, where should this workload run?

The normalized destinations are:

- local
- private
- cloud
- hybrid

## Competitive boundary

### LiteLLM

LiteLLM provides a unified interface across providers and has mature routing features such as load balancing, latency/cost strategies, retries, fallbacks and spend tracking.

Source: https://docs.litellm.ai/docs/routing

LOCD should integrate with a router such as LiteLLM where useful, rather than compete at every provider-routing layer.

### OpenRouter Auto Router

OpenRouter's Auto Router selects a model for a prompt based on task-oriented routing and cost/quality tradeoffs.

Source: https://openrouter.ai/docs/guides/routing/routers/auto-router

LOCD should treat model selection as one signal or downstream concern. Its primary decision remains execution placement and policy compliance.

### OllamaRouter

OllamaRouter is a local/remote/cloud overflow proxy for Ollama workloads and already considers local capacity, request size, target availability and cloud overflow.

Source: https://github.com/jetelain/OllamaRouter

LOCD should not become another Ollama-specific overflow proxy.

### AllRouter

AllRouter combines local-first routing, cloud bursting, spend/privacy policy, fallback behavior and observability for AI clients.

Source: https://github.com/Lore-Hex/AllRouter

This reinforces the need for LOCD to differentiate at the decision/control-plane layer: normalized infrastructure inputs, explicit hard constraints, workload-level policy, explainable alternatives and future hybrid plans.

## LOCD wedge

The initial product wedge is:

**Policy-aware workload placement with explainable decisions.**

The engine should make it possible to answer, for every request:

1. What did we choose?
2. Which targets were eligible?
3. Which targets were rejected, and by which rule?
4. What cost/latency/privacy signals drove the choice?
5. What alternative was available?
6. What telemetry should be recorded to improve the estimate later?

## What not to build first

- a large provider SDK catalog
- a proprietary model benchmark leaderboard
- an opaque ML router
- a full multi-tenant enterprise control plane
- a general-purpose agent platform

Those can become integrations or later products. V1 should prove the decision model and its value.
