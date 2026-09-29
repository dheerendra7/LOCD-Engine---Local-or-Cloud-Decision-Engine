import { randomUUID } from "node:crypto";

const ROUTES = new Set(["local", "private", "cloud", "hybrid", "none"]);
const OUTCOMES = new Set(["pending", "success", "failure"]);

function iso(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("event timestamp must be a valid date");
  return date.toISOString();
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value) {
  const number = finite(value);
  return number == null ? null : Math.max(0, number);
}

function applyOutcome(event, patch) {
  const outcome = String(patch.outcome || "");
  if (!OUTCOMES.has(outcome) || outcome === "pending") {
    throw new Error("outcome must be success or failure");
  }

  event.outcome = outcome;
  event.actualLatencyMs = nonNegative(patch.actualLatencyMs);
  event.actualCostUsd = nonNegative(patch.actualCostUsd);
  event.errorClass = patch.errorClass ? String(patch.errorClass) : null;
  event.outcomeTimestamp = iso(patch.timestamp);
  return { ...event };
}

export function normalizeDecisionEvent(event) {
  if (!event || typeof event !== "object") throw new Error("decision event must be an object");
  if (!event.route || !ROUTES.has(event.route)) throw new Error("decision event route is invalid");

  const outcome = event.outcome ? String(event.outcome) : "pending";
  if (!OUTCOMES.has(outcome)) throw new Error("decision event outcome is invalid");

  return {
    id: String(event.id || randomUUID()),
    timestamp: iso(event.timestamp),
    decisionVersion: String(event.decisionVersion || "1.0"),
    workloadType: event.workloadType ? String(event.workloadType) : "unknown",
    route: event.route,
    targetId: event.targetId == null ? null : String(event.targetId),
    confidence: Math.min(1, Math.max(0, finite(event.confidence, 0))),
    estimatedLatencyMs: nonNegative(event.estimatedLatencyMs),
    estimatedCostUsd: nonNegative(event.estimatedCostUsd),
    outcome,
    actualLatencyMs: nonNegative(event.actualLatencyMs),
    actualCostUsd: nonNegative(event.actualCostUsd),
    errorClass: event.errorClass ? String(event.errorClass) : null
  };
}

export function createDecisionStore({ maxEntries = 500 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer");
  }

  const events = [];

  return {
    record(event) {
      const normalized = normalizeDecisionEvent(event);
      events.push(normalized);
      if (events.length > maxEntries) events.splice(0, events.length - maxEntries);
      return { ...normalized };
    },

    recordOutcome(id, patch) {
      const index = events.findIndex(event => event.id === String(id));
      if (index === -1) throw new Error("decision_not_found");
      events[index] = applyOutcome(events[index], patch);
      return { ...events[index] };
    },

    list({ limit = 50 } = {}) {
      const safeLimit = Math.min(maxEntries, Math.max(1, Number(limit) || 50));
      return events.slice(-safeLimit).reverse().map(event => ({ ...event }));
    },

    summary() {
      const routes = {};
      const outcomes = { pending: 0, success: 0, failure: 0 };
      let estimatedCostUsd = 0;
      let latencyCount = 0;
      let latencyTotal = 0;
      let confidenceTotal = 0;
      let completedCount = 0;
      let successCount = 0;
      let latencyErrorCount = 0;
      let latencyErrorTotal = 0;
      let costErrorCount = 0;
      let costErrorTotal = 0;

      for (const event of events) {
        routes[event.route] = (routes[event.route] || 0) + 1;
        outcomes[event.outcome] = (outcomes[event.outcome] || 0) + 1;

        if (event.estimatedCostUsd != null) estimatedCostUsd += event.estimatedCostUsd;
        if (event.estimatedLatencyMs != null) {
          latencyTotal += event.estimatedLatencyMs;
          latencyCount++;
        }
        confidenceTotal += event.confidence;

        if (event.outcome === "success" || event.outcome === "failure") {
          completedCount++;
          if (event.outcome === "success") successCount++;
        }

        if (event.actualLatencyMs != null && event.estimatedLatencyMs != null) {
          latencyErrorTotal += Math.abs(event.actualLatencyMs - event.estimatedLatencyMs);
          latencyErrorCount++;
        }

        if (event.actualCostUsd != null && event.estimatedCostUsd != null) {
          costErrorTotal += Math.abs(event.actualCostUsd - event.estimatedCostUsd);
          costErrorCount++;
        }
      }

      return {
        totalDecisions: events.length,
        routes,
        outcomes,
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
        averageEstimatedLatencyMs: latencyCount ? Number((latencyTotal / latencyCount).toFixed(2)) : null,
        averageConfidence: events.length ? Number((confidenceTotal / events.length).toFixed(6)) : 0,
        successRate: completedCount ? Number((successCount / completedCount).toFixed(6)) : null,
        meanAbsoluteLatencyErrorMs: latencyErrorCount
          ? Number((latencyErrorTotal / latencyErrorCount).toFixed(2))
          : null,
        meanAbsoluteCostErrorUsd: costErrorCount
          ? Number((costErrorTotal / costErrorCount).toFixed(6))
          : null
      };
    },

    clear() {
      events.length = 0;
    }
  };
}
