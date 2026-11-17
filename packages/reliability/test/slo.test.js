import test from "node:test";
import assert from "node:assert/strict";
import { createReliabilitySloEvaluator } from "../src/slo.js";

function report({ attempts = 100, failures = 0, providers = [], truncated = false, historyWriteFailures = 0 } = {}) {
  return {
    available: true,
    windowMs: 3_600_000,
    to: 10_000,
    truncated,
    historyWriteFailures,
    retainedEventCount: attempts,
    droppedEventCount: truncated ? 5 : 0,
    summary: { attempts, failures, successes: attempts - failures },
    providers
  };
}

test("SLO evaluator reports healthy availability and an unused error budget", () => {
  const evaluator = createReliabilitySloEvaluator({ availabilityTarget: 0.99, minimumSamples: 20 });
  const result = evaluator.evaluate(report({ attempts: 1000, failures: 5 }));
  assert.equal(result.overall.status, "healthy");
  assert.equal(result.overall.availability, 0.995);
  assert.equal(result.overall.errorBudgetBurnRate, 0.5);
  assert.equal(result.overall.errorBudgetConsumedPercent, 50);
  assert.equal(result.overall.errorBudgetRemainingPercent, 50);
  assert.equal(result.alertCount, 0);
  assert.equal(result.dataQuality.complete, true);
});

test("SLO warning and critical alerts follow configured burn-rate thresholds", () => {
  const evaluator = createReliabilitySloEvaluator({
    availabilityTarget: 0.99,
    minimumSamples: 100,
    warningBurnRate: 2,
    criticalBurnRate: 5
  });
  const warning = evaluator.evaluate(report({ attempts: 1000, failures: 20 }));
  assert.equal(warning.overall.status, "warning");
  assert.equal(warning.overall.errorBudgetBurnRate, 2);
  assert.equal(warning.alerts[0].severity, "warning");

  const critical = evaluator.evaluate(report({ attempts: 1000, failures: 60 }));
  assert.equal(critical.overall.status, "critical");
  assert.equal(critical.overall.errorBudgetBurnRate, 6);
  assert.equal(critical.overall.errorBudgetConsumedPercent, 600);
  assert.equal(critical.overall.errorBudgetRemainingPercent, 0);
  assert.equal(critical.alerts[0].severity, "critical");
});

test("low sample volume suppresses SLO alerts without hiding observed counts", () => {
  const evaluator = createReliabilitySloEvaluator({ availabilityTarget: 0.999, minimumSamples: 20 });
  const result = evaluator.evaluate(report({ attempts: 3, failures: 3 }));
  assert.equal(result.overall.status, "insufficient_data");
  assert.equal(result.overall.attempts, 3);
  assert.equal(result.overall.availability, 0);
  assert.equal(result.overall.errorBudgetBurnRate, null);
  assert.equal(result.alertCount, 0);
});

test("truncated history and history-write gaps suppress SLO assertions", () => {
  const evaluator = createReliabilitySloEvaluator({ availabilityTarget: 0.99, minimumSamples: 10 });
  const truncated = evaluator.evaluate(report({ attempts: 100, failures: 50, truncated: true }));
  assert.equal(truncated.overall.status, "incomplete_data");
  assert.equal(truncated.overall.errorBudgetBurnRate, null);
  assert.equal(truncated.dataQuality.complete, false);
  assert.equal(truncated.alertCount, 0);

  const writeGap = evaluator.evaluate(report({ attempts: 100, failures: 50, historyWriteFailures: 1 }));
  assert.equal(writeGap.overall.status, "incomplete_data");
  assert.equal(writeGap.dataQuality.historyWriteFailures, 1);
});

test("provider-level SLO alerts are isolated and sorted by severity", () => {
  const evaluator = createReliabilitySloEvaluator({
    availabilityTarget: 0.99,
    minimumSamples: 20,
    warningBurnRate: 2,
    criticalBurnRate: 5
  });
  const result = evaluator.evaluate(report({
    attempts: 100,
    failures: 0,
    providers: [
      { targetId: "healthy-provider", attempts: 100, failures: 0 },
      { targetId: "warning-provider", attempts: 100, failures: 2 },
      { targetId: "critical-provider", attempts: 100, failures: 8 },
      { targetId: "low-volume-provider", attempts: 5, failures: 5 }
    ]
  }));
  assert.equal(result.overall.status, "healthy");
  assert.equal(result.providers.find(item => item.targetId === "low-volume-provider").status, "insufficient_data");
  assert.deepEqual(result.alerts.map(item => [item.targetId, item.severity]), [
    ["critical-provider", "critical"],
    ["warning-provider", "warning"]
  ]);
});

test("SLO evaluator validates objectives, samples and burn thresholds", () => {
  assert.throws(() => createReliabilitySloEvaluator({ availabilityTarget: 1 }), /availabilityTarget/);
  assert.throws(() => createReliabilitySloEvaluator({ minimumSamples: 0 }), /minimumSamples/);
  assert.throws(() => createReliabilitySloEvaluator({ warningBurnRate: 0 }), /warningBurnRate/);
  assert.throws(() => createReliabilitySloEvaluator({ warningBurnRate: 5, criticalBurnRate: 2 }), /criticalBurnRate/);
  assert.throws(() => createReliabilitySloEvaluator().evaluate({ available: false }), /valid reliability history/);
});
