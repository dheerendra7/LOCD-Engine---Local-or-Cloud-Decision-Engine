const MODES = ["local", "private", "cloud", "hybrid"];
const SENSITIVE_MODES = ["balanced", "prefer-local", "local-only", "private-only"];
const SCALAR_RULE_FIELDS = new Set(["sensitiveDataMode", "maxHeartbeatAgeMs"]);
const ARRAY_RULE_FIELDS = new Set(["allowedModes", "blockedModes", "allowedRegions"]);

const PRESETS = Object.freeze({
  balanced: {
    name: "Balanced",
    description: "Balances privacy, latency, cost, capacity and reliability.",
    sensitiveDataMode: "balanced",
    weights: { privacy: 0.30, latency: 0.25, cost: 0.20, capacity: 0.10, reliability: 0.15 }
  },
  localFirst: {
    name: "Local First",
    description: "Prefer local execution while preserving eligible fallbacks.",
    sensitiveDataMode: "prefer-local",
    allowedModes: MODES,
    weights: { privacy: 0.35, latency: 0.20, cost: 0.25, capacity: 0.10, reliability: 0.10 }
  },
  privacyFirst: {
    name: "Privacy First",
    description: "Keep high-sensitivity workloads inside local or private boundaries.",
    sensitiveDataMode: "private-only",
    allowedModes: ["local", "private", "cloud", "hybrid"],
    weights: { privacy: 0.55, latency: 0.15, cost: 0.10, capacity: 0.05, reliability: 0.15 }
  },
  latencyFirst: {
    name: "Latency First",
    description: "Prioritize low estimated latency while honoring hard constraints.",
    sensitiveDataMode: "balanced",
    weights: { privacy: 0.15, latency: 0.50, cost: 0.10, capacity: 0.10, reliability: 0.15 }
  },
  costFirst: {
    name: "Cost First",
    description: "Prefer lower estimated execution cost while keeping reliability visible.",
    sensitiveDataMode: "balanced",
    weights: { privacy: 0.20, latency: 0.15, cost: 0.45, capacity: 0.10, reliability: 0.10 }
  },
  strictLocalSensitive: {
    name: "Strict Local Sensitive",
    description: "High-sensitivity workloads may execute only on local targets.",
    sensitiveDataMode: "local-only",
    allowedModes: ["local"],
    weights: { privacy: 0.60, latency: 0.15, cost: 0.10, capacity: 0.05, reliability: 0.10 }
  }
});

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function matchingField(value, expected) {
  if (expected == null) return true;
  return asList(expected).includes(String(value));
}

function matchesRule(rule, context) {
  const when = rule.when || {};
  const workload = context.workload || {};

  if (!matchingField(workload.type, when.workloadType)) return false;
  if (!matchingField(workload.sensitivity, when.sensitivity)) return false;

  const required = asList(workload.requiredCapabilities);
  const requiredByRule = asList(when.requiredCapability);
  if (requiredByRule.length && !requiredByRule.every(value => required.includes(value))) {
    return false;
  }

  return true;
}

function validateRule(rule, index) {
  if (!rule || typeof rule !== "object") {
    throw new Error("policy rule at index " + index + " must be an object");
  }

  const id = String(rule.id || "");
  if (!id) throw new Error("policy rule id is required at index " + index);

  const priority = Number(rule.priority ?? 0);
  if (!Number.isInteger(priority)) {
    throw new Error("policy rule priority must be an integer: " + id);
  }

  if (rule.when != null && typeof rule.when !== "object") {
    throw new Error("policy rule when must be an object: " + id);
  }

  if (!rule.set || typeof rule.set !== "object") {
    throw new Error("policy rule set must be an object: " + id);
  }

  for (const key of Object.keys(rule.set)) {
    if (!SCALAR_RULE_FIELDS.has(key) && !ARRAY_RULE_FIELDS.has(key) && key !== "weights") {
      throw new Error("policy rule field is not supported: " + key);
    }

    if (key === "sensitiveDataMode" && !SENSITIVE_MODES.includes(String(rule.set[key]))) {
      throw new Error("policy rule sensitiveDataMode is invalid: " + id);
    }

    if (ARRAY_RULE_FIELDS.has(key)) {
      const values = asList(rule.set[key]);
      if (key !== "allowedRegions" && values.some(value => !MODES.includes(value))) {
        throw new Error("policy rule " + key + " contains an invalid mode: " + id);
      }
    }

    if (key === "maxHeartbeatAgeMs" && (!Number.isFinite(Number(rule.set[key])) || Number(rule.set[key]) < 0)) {
      throw new Error("policy rule maxHeartbeatAgeMs must be >= 0: " + id);
    }

    if (key === "weights") {
      if (!rule.set.weights || typeof rule.set.weights !== "object") {
        throw new Error("policy rule weights must be an object: " + id);
      }
    }
  }

  return {
    id,
    priority,
    order: index,
    when: structuredClone(rule.when || {}),
    set: structuredClone(rule.set)
  };
}

export function listPolicyProfiles() {
  return Object.entries(PRESETS).map(([id, profile]) => ({
    id,
    ...structuredClone(profile)
  }));
}

export function getPolicyProfile(id = "balanced") {
  const profile = PRESETS[id];
  if (!profile) {
    throw new Error("unknown policy profile: " + id);
  }
  return structuredClone({ id, ...profile });
}

export function resolvePolicy(policy = {}, context = {}) {
  const profile = policy.profile ? getPolicyProfile(policy.profile) : getPolicyProfile("balanced");
  const merged = {
    ...profile,
    ...policy,
    weights: {
      ...profile.weights,
      ...(policy.weights || {})
    }
  };

  delete merged.profile;
  delete merged.id;
  delete merged.name;
  delete merged.description;

  const rawRules = policy.rules || [];
  if (!Array.isArray(rawRules)) {
    throw new Error("policy.rules must be an array");
  }

  const rules = rawRules.map(validateRule);
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.order - b.order);
  const matchedRules = [];

  for (const rule of sorted) {
    if (!matchesRule(rule, context)) continue;

    matchedRules.push(rule.id);

    for (const [key, value] of Object.entries(rule.set)) {
      if (key === "weights") {
        merged.weights = {
          ...merged.weights,
          ...value
        };
      } else if (ARRAY_RULE_FIELDS.has(key)) {
        merged[key] = asList(value);
      } else {
        merged[key] = value;
      }
    }
  }

  if (merged.allowedModes) {
    const invalid = asList(merged.allowedModes).find(mode => !MODES.includes(mode));
    if (invalid) throw new Error("policy.allowedModes contains invalid mode: " + invalid);
    merged.allowedModes = asList(merged.allowedModes);
  }

  if (merged.blockedModes) {
    const invalid = asList(merged.blockedModes).find(mode => !MODES.includes(mode));
    if (invalid) throw new Error("policy.blockedModes contains invalid mode: " + invalid);
    merged.blockedModes = asList(merged.blockedModes);
  }

  merged.rules = rules;
  merged.matchedRules = matchedRules;
  return merged;
}
