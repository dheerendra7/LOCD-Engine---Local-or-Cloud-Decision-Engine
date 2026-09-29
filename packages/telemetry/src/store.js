const ROUTES = new Set(["local", "private", "cloud", "hybrid", "none"]);

function iso(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("event timestamp must be a valid date");
  return date.toISOString();
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeDecisionEvent(event) {
  if (!event || typeof event !== "object") throw new Error("decision event must be an object");
  if (!event.route || !ROUTES.has(event.route)) throw new Error("decision event route is invalid");

  return {
    id: String(event.id || globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)),
    timestamp: iso(event.timestamp),
    decisionVersion: String(event.decisionVersion || "1.0"),
    workloadType: event.workloadType ? String(event.workloadType) : "unknown",
    route: event.route,
    targetId: event.targetId == null ? null : String(event.targetId),
    confidence: finite(event.confidence, 0),
    estimatedLatencyMs: finite(event.estimatedLatencyMs),
    estimatedCostUsd: finite(event.estimatedCostUsd),
    outcome: event.outcome ? String(event.outcome) : "unknown"
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
      return normalized;
    },

    list({ limit = 50 } = {}) {
      const safeLimit = Math.min(maxEntries, Math.max(1, Number(limit) || 50));
      return events.slice(-safeLimit).reverse().map(event => ({ ...event }));
    },

    summary() {
      const routes = {};
      let estimatedCostUsd = 0;
      let latencyCount = 0;
      let latencyTotal = 0;
      let confidenceTotal = 0;

      for (const event of events) {
        routes[event.route] = (routes[event.route] || 0) + 1;
        if (event.estimatedCostUsd != null) estimatedCostUsd += event.estimatedCostUsd;
        if (event.estimatedLatencyMs != null) {
          latencyTotal += event.estimatedLatencyMs;
          latencyCount++;
        }
        confidenceTotal += event.confidence;
      }

      return {
        totalDecisions: events.length,
        routes,
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
        averageEstimatedLatencyMs: latencyCount ? Number((latencyTotal / latencyCount).toFixed(2)) : null,
        averageConfidence: events.length ? Number((confidenceTotal / events.length).toFixed(6)) : 0
      };
    },

    clear() {
      events.length = 0;
    }
  };
}
