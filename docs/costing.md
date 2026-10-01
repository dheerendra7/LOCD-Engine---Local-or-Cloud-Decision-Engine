# Cost Estimation

LOCD can derive target execution cost from workload usage and server-side target pricing.

## Precedence

1. Explicit target.estimatedCostUsd
2. Target pricing + workload usage
3. Unknown cost

LOCD does not invent a cost when neither an explicit estimate nor a pricing model is available.

## Pricing units

- flat: fixed cost for the operation
- per-request: request count multiplied by requestUsd
- per-1k-tokens: input and output token counts multiplied by their respective rates

Only USD pricing is accepted in V1.

## Example

Target:

    {
      "id": "cloud-a",
      "mode": "cloud",
      "pricing": {
        "unit": "per-1k-tokens",
        "currency": "USD",
        "inputUsdPer1kTokens": 0.003,
        "outputUsdPer1kTokens": 0.012
      }
    }

Workload:

    {
      "type": "llm-inference",
      "inputTokens": 2000,
      "outputTokens": 500
    }

Estimated cost:

    2 * 0.003 + 0.5 * 0.012 = 0.012 USD

The estimate then participates in the existing hard budget and soft scoring logic.
