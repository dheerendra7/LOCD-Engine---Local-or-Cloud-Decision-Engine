const MODES = ["local", "private", "cloud", "hybrid"];

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

export function resolvePolicy(policy = {}) {
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
  return merged;
}
