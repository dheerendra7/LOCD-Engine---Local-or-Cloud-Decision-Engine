import { createLocdClient } from "../packages/sdk/src/index.js";

const locd = createLocdClient({
  baseUrl: "http://localhost:8787"
});

const decision = await locd.decide({
  workload: {
    type: "llm-inference",
    sensitivity: "high"
  },
  constraints: {
    latencyBudgetMs: 800,
    maxCostUsd: 0.05,
    strictLatency: true,
    strictCost: true
  },
  policy: {
    sensitiveDataMode: "local-only"
  },
  targets: [
    {
      id: "local-gpu",
      mode: "local",
      health: 0.98,
      capacity: 0.20,
      privacy: 1,
      estimatedLatencyMs: 420,
      estimatedCostUsd: 0,
      available: true
    }
  ]
});

console.log(decision);
