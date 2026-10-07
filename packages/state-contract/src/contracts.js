const DECISION_METHODS = ["record", "recordOutcome", "list", "summary", "clear"];
const COORDINATION_METHODS = ["get", "set", "setIfAbsent", "delete", "incr"];

function assertMethods(value, methods, name) {
  if (!value || typeof value !== "object") {
    throw new Error(name + " is required");
  }
  const missing = methods.filter(method => typeof value[method] !== "function");
  if (missing.length) {
    throw new Error(name + " is missing methods: " + missing.join(", "));
  }
  return value;
}

function normalizeCapabilities(capabilities = {}) {
  if (!capabilities || typeof capabilities !== "object") {
    throw new Error("backend capabilities must be an object");
  }
  return {
    durable: capabilities.durable === true,
    shared: capabilities.shared === true,
    tenantScoped: capabilities.tenantScoped === true,
    transactional: capabilities.transactional === true
  };
}

export function assertDecisionStore(store, { name = "decisionStore" } = {}) {
  assertMethods(store, DECISION_METHODS, name);
  if (store.capabilities != null) normalizeCapabilities(store.capabilities);
  return store;
}

export function assertCoordinationStore(store, { name = "coordinationStore" } = {}) {
  assertMethods(store, COORDINATION_METHODS, name);
  if (store.capabilities != null) normalizeCapabilities(store.capabilities);
  return store;
}

export function describeStateBackend({
  telemetry = null,
  coordination = null,
  kind = "process-local"
} = {}) {
  const telemetryCapabilities = telemetry?.capabilities
    ? normalizeCapabilities(telemetry.capabilities)
    : normalizeCapabilities();
  const coordinationCapabilities = coordination?.capabilities
    ? normalizeCapabilities(coordination.capabilities)
    : normalizeCapabilities();

  return {
    kind: String(kind),
    telemetry: telemetryCapabilities,
    coordination: coordination
      ? coordinationCapabilities
      : null
  };
}
