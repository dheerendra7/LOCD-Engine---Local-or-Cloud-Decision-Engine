# Cost Estimation

LOCD can derive target execution cost from workload usage and server-side target pricing.

## Precedence

1. Explicit `target.estimatedCostUsd`
2. Target pricing + workload usage
3. Unknown cost

LOCD does not invent a cost when neither an explicit estimate nor a pricing model is available.

## Pricing units

- `flat`: fixed cost for the operation
- `per-request`: request count multiplied by `requestUsd`
- `per-1k-tokens`: input and output token counts multiplied by their respective rates

Only USD pricing is accepted in V1.

Each pricing unit must include its relevant rate fields: `flat` requires `flatUsd`, `per-request` requires `requestUsd`, and `per-1k-tokens` requires both `inputUsdPer1kTokens` and `outputUsdPer1kTokens`. A zero rate is valid when explicitly configured; an omitted rate is a configuration error and is never silently treated as free.

Token-based pricing requires both `workload.inputTokens` and `workload.outputTokens`. If either value is missing or is a blank string, the estimate is `unknown`; LOCD does not treat missing token usage as zero. Supply an explicit `0` when the workload genuinely has zero tokens. Blank/whitespace price fields and request counts are rejected instead of being coerced to zero. Flat and per-request pricing do not require token counts.

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

## How cost affects decisions

Hard budget filtering and soft scoring are separate controls:

- When `strictCost` is enabled and `maxCostUsd` is provided, a target above that budget is rejected. An unknown estimate is also rejected because compliance cannot be verified.
- When `maxCostUsd` is provided without strict filtering, the budget still supplies the reference point for the cost score.
- When no budget is provided and at least two eligible targets have distinct, known estimates, LOCD scores those targets relatively: the lowest known cost gets a cost factor of 1 and the highest gets 0, with intermediate costs scaled between them. Only eligible targets with known costs define this range; unknown estimates do not distort it.
- If the eligible targets do not provide at least two distinct known costs, relative normalization is not possible and the existing fallback cost factor is retained. Missing cost is reported as unknown rather than fabricated.

Relative scoring compares only the candidates in the current decision. It is not an absolute affordability threshold, a promise of savings, or a substitute for validating provider invoices and workload-specific pricing.
