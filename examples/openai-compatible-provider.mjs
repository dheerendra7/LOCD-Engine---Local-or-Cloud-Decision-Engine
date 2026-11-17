import { createOpenAICompatibleAdapter } from "../packages/providers/src/index.js";
import { createTargetRegistry } from "../packages/registry/src/index.js";
import { decide } from "../packages/core/src/index.js";

const provider = createOpenAICompatibleAdapter({
  id: "private-vllm",
  targetId: "private-vllm",
  mode: "private",
  baseUrl: "https://inference.example.com",
  apiKey: process.env.PROVIDER_API_KEY,
  model: "my-model",
  privacy: 0.95,
  regions: ["ap-south-1"],
  capabilities: ["text-generation"]
});

const registry = createTargetRegistry([provider]);

const freshTarget = await registry.probe("private-vllm");
console.log("probe:", freshTarget);

const decision = decide({
  workload: {
    type: "llm-inference",
    sensitivity: "high",
    requiredCapabilities: ["text-generation"]
  },
  constraints: {
    latencyBudgetMs: 800,
    strictLatency: true
  },
  policy: {
    sensitiveDataMode: "private-only",
    allowedRegions: ["ap-south-1"],
    maxHeartbeatAgeMs: 30_000
  },
  targets: await registry.list()
});

console.log("decision:", decision);
