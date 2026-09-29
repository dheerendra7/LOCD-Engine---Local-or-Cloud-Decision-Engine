# Decision Model

## Request

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
        "allowedRegions": []
      },
      "targets": []
    }

## Response

    {
      "route": "local",
      "targetId": "local-gpu",
      "confidence": 0.92,
      "score": 0.91,
      "estimated": {
        "latencyMs": 420,
        "costUsd": 0
      },
      "reasons": [],
      "alternatives": []
    }

Confidence is a deterministic decision-margin signal, not a probability that the selected target will succeed.

## Normalized target

Each target should expose:
- id
- mode
- health
- capacity
- privacy
- estimatedLatencyMs
- estimatedCostUsd
- available
- regions
- capabilities

Adapters can later translate real GPU metrics, quotas, network measurements and pricing into this normalized shape.
