function roundMetric(value) {
  return Number(value.toFixed(10));
}

function validateFraction(value, field) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(field + " must be greater than 0 and less than 1");
  }
  return value;
}

function validatePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(field + " must be a positive safe integer");
  }
  return value;
}

function validateBurnRate(value, field) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(field + " must be a positive finite number");
  }
  return value;
}

function normalizeCounts(input = {}) {
  const attempts = Number.isSafeInteger(input.attempts) && input.attempts >= 0
    ? input.attempts
    : 0;
  const failures = Number.isSafeInteger(input.failures) && input.failures >= 0 && input.failures <= attempts
    ? input.failures
    : 0;
  return { attempts, failures, successes: attempts - failures };
}

function metricFor(input, policy, complete) {
  const counts = normalizeCounts(input);
  const failureRate = counts.attempts > 0 ? counts.failures / counts.attempts : null;
  const availability = counts.attempts > 0 ? counts.successes / counts.attempts : null;
  const enoughSamples = counts.attempts >= policy.minimumSamples;
  const evaluable = complete && enoughSamples;
  const burnRate = evaluable && failureRate !== null
    ? roundMetric(failureRate / policy.errorBudgetRate)
    : null;
  const consumedPercent = burnRate === null ? null : burnRate * 100;
  const remainingPercent = consumedPercent === null
    ? null
    : Math.max(0, 100 - consumedPercent);

  let status = "insufficient_data";
  if (!complete) status = "incomplete_data";
  else if (enoughSamples) {
    status = burnRate >= policy.criticalBurnRate
      ? "critical"
      : burnRate >= policy.warningBurnRate
        ? "warning"
        : "healthy";
  }

  return {
    status,
    attempts: counts.attempts,
    successes: counts.successes,
    failures: counts.failures,
    availability,
    failureRate,
    errorBudgetBurnRate: burnRate,
    errorBudgetConsumedPercent: consumedPercent,
    errorBudgetRemainingPercent: remainingPercent,
    sampleThreshold: policy.minimumSamples,
    enoughSamples,
    dataComplete: complete
  };
}

/**
 * Builds a deterministic SLO evaluator over provider outcome event aggregates.
 * Alert evaluation is read-only; it does not deliver notifications or change routing.
 */
export function createReliabilitySloEvaluator({
  availabilityTarget = 0.999,
  minimumSamples = 20,
  warningBurnRate = 2,
  criticalBurnRate = 5
} = {}) {
  validateFraction(availabilityTarget, "availabilityTarget");
  validatePositiveInteger(minimumSamples, "minimumSamples");
  validateBurnRate(warningBurnRate, "warningBurnRate");
  validateBurnRate(criticalBurnRate, "criticalBurnRate");
  if (criticalBurnRate <= warningBurnRate) {
    throw new Error("criticalBurnRate must be greater than warningBurnRate");
  }

  const policy = Object.freeze({
    availabilityTarget,
    errorBudgetRate: 1 - availabilityTarget,
    errorBudgetPercent: roundMetric((1 - availabilityTarget) * 100),
    minimumSamples,
    warningBurnRate,
    criticalBurnRate
  });

  function evaluate(report) {
    if (!report || report.available !== true || !report.summary || !Array.isArray(report.providers)) {
      throw new Error("a valid reliability history report is required");
    }

    const historyWriteFailures = Number.isSafeInteger(report.historyWriteFailures) && report.historyWriteFailures >= 0
      ? report.historyWriteFailures
      : 0;
    const truncated = report.truncated === true;
    const complete = !truncated && historyWriteFailures === 0;
    const overall = metricFor(report.summary, policy, complete);
    const providers = report.providers.map(provider => ({
      targetId: String(provider?.targetId ?? "unknown"),
      ...metricFor(provider, policy, complete)
    })).sort((left, right) =>
      (right.errorBudgetBurnRate ?? -1) - (left.errorBudgetBurnRate ?? -1) ||
      left.targetId.localeCompare(right.targetId)
    );

    const alerts = [];
    function addAlert(scope, metric, targetId = null) {
      if (metric.status !== "warning" && metric.status !== "critical") return;
      const severity = metric.status;
      const burn = Number(metric.errorBudgetBurnRate.toFixed(2));
      alerts.push({
        id: scope === "overall" ? "overall:" + severity : "provider:" + targetId + ":" + severity,
        scope,
        targetId,
        severity,
        code: scope === "overall" ? "availability_slo_burn_high" : "provider_slo_burn_high",
        message: scope === "overall"
          ? "Overall provider availability is burning the error budget at " + burn + "×."
          : "Provider " + targetId + " is burning its availability error budget at " + burn + "×.",
        attempts: metric.attempts,
        errorBudgetBurnRate: metric.errorBudgetBurnRate,
        errorBudgetConsumedPercent: metric.errorBudgetConsumedPercent
      });
    }

    addAlert("overall", overall);
    for (const provider of providers) addAlert("provider", provider, provider.targetId);

    alerts.sort((left, right) =>
      (left.severity === "critical" ? 0 : 1) - (right.severity === "critical" ? 0 : 1) ||
      right.errorBudgetBurnRate - left.errorBudgetBurnRate ||
      String(left.targetId || "").localeCompare(String(right.targetId || ""))
    );

    return {
      enabled: true,
      windowMs: Number.isSafeInteger(report.windowMs) ? report.windowMs : null,
      evaluatedAt: Number.isFinite(report.to) ? report.to : null,
      dataQuality: {
        complete,
        truncated,
        historyWriteFailures,
        retainedEventCount: Number.isSafeInteger(report.retainedEventCount) ? report.retainedEventCount : 0,
        droppedEventCount: Number.isSafeInteger(report.droppedEventCount) ? report.droppedEventCount : 0
      },
      policy,
      overall,
      providers,
      alerts,
      alertCount: alerts.length
    };
  }

  return Object.freeze({ policy, evaluate });
}
