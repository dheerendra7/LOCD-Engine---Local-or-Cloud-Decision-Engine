import { performance } from "node:perf_hooks";
import { decide } from "../packages/core/src/index.js";

const DEFAULT_SIZES = [100, 1_000, 5_000];
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 30;
const MODES = ["local", "private", "cloud", "hybrid"];

function parseSizes(args) {
  if (args.length === 0) return DEFAULT_SIZES;
  const sizes = args.map(Number);
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 2 || size > 25_000)) {
    throw new Error("target counts must be whole numbers between 2 and 25000");
  }
  return sizes;
}

function createTargets(count) {
  return Array.from({ length: count }, (_, index) => {
    const mode = MODES[index % MODES.length];
    return {
      id: "target-" + index,
      mode,
      available: true,
      health: 0.9 + (index % 10) / 100,
      capacity: (index % 90) / 100,
      privacy: mode === "local" ? 1 : mode === "private" ? 0.95 : 0.7,
      estimatedLatencyMs: 20 + (index % 400),
      estimatedCostUsd: Number(((index % 100) * 0.0005).toFixed(6)),
      capabilities: ["text-generation"],
      regions: ["ap-south-1", "us-east-1"]
    };
  });
}

function percentile(sorted, quantile) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function benchmark(count) {
  const input = {
    workload: {
      type: "llm-inference",
      sensitivity: "medium",
      requiredCapabilities: ["text-generation"]
    },
    constraints: {
      latencyBudgetMs: null,
      maxCostUsd: null,
      strictLatency: false,
      strictCost: false
    },
    targets: createTargets(count)
  };

  for (let index = 0; index < WARMUP_RUNS; index++) {
    decide(input);
  }

  const samplesMs = [];
  for (let index = 0; index < MEASURED_RUNS; index++) {
    const startedAt = performance.now();
    const result = decide(input);
    samplesMs.push(performance.now() - startedAt);
    if (!result || !Array.isArray(result.evaluated)) {
      throw new Error("decision benchmark returned an invalid result");
    }
  }

  samplesMs.sort((left, right) => left - right);
  const p50Ms = percentile(samplesMs, 0.50);
  const p95Ms = percentile(samplesMs, 0.95);
  const averageMs = samplesMs.reduce((total, sample) => total + sample, 0) / samplesMs.length;

  return {
    targets: count,
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    p50Ms: Number(p50Ms.toFixed(3)),
    p95Ms: Number(p95Ms.toFixed(3)),
    averageMs: Number(averageMs.toFixed(3)),
    decisionsPerSecond: Number((1000 / averageMs).toFixed(2))
  };
}

try {
  const sizes = parseSizes(process.argv.slice(2));
  console.log(JSON.stringify({
    benchmark: "locd-decision-scoring",
    node: process.version,
    note: "Compare results only on the same machine and Node version.",
    results: sizes.map(benchmark)
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "benchmark_failed");
  process.exitCode = 1;
}
