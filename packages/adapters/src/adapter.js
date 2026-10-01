const MODES = ["local", "private", "cloud", "hybrid"];

function assertMode(mode) {
  if (!MODES.includes(mode)) {
    throw new Error("adapter mode must be one of: " + MODES.join(", "));
  }
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("adapter snapshot must be an object");
  }
  if (!snapshot.id) throw new Error("adapter snapshot id is required");
  assertMode(snapshot.mode);

  return {
    id: String(snapshot.id),
    mode: snapshot.mode,
    available: snapshot.available !== false,
    health: Math.min(1, Math.max(0, finiteNumber(snapshot.health, 0))),
    capacity: Math.min(1, Math.max(0, finiteNumber(snapshot.capacity, 1))),
    privacy: Math.min(1, Math.max(0, finiteNumber(snapshot.privacy, 0))),
    estimatedLatencyMs: finiteNumber(snapshot.estimatedLatencyMs),
    estimatedCostUsd: finiteNumber(snapshot.estimatedCostUsd),
    pricing: snapshot.pricing && typeof snapshot.pricing === "object"
      ? structuredClone(snapshot.pricing)
      : null,
    availableMemoryGb: finiteNumber(snapshot.availableMemoryGb),
    maxContextTokens: finiteNumber(snapshot.maxContextTokens),
    lastHeartbeatAt: snapshot.lastHeartbeatAt ? new Date(snapshot.lastHeartbeatAt).toISOString() : null,
    regions: [...new Set(Array.isArray(snapshot.regions) ? snapshot.regions.map(String) : [])],
    capabilities: [...new Set(Array.isArray(snapshot.capabilities) ? snapshot.capabilities.map(String) : [])]
  };
}

export function createStaticTargetAdapter(snapshot) {
  let current = normalizeSnapshot(snapshot);

  return {
    id: current.id,

    async getSnapshot() {
      return structuredClone(current);
    },

    async setSnapshot(nextSnapshot) {
      if (nextSnapshot?.id && String(nextSnapshot.id) !== current.id) {
        throw new Error("adapter id cannot change");
      }
      current = normalizeSnapshot({
        ...current,
        ...nextSnapshot,
        id: current.id,
        lastHeartbeatAt: nextSnapshot?.lastHeartbeatAt ?? current.lastHeartbeatAt
      });
      return structuredClone(current);
    }
  };
}

export async function collectTargetSnapshots(adapters) {
  if (!Array.isArray(adapters)) {
    throw new Error("adapters must be an array");
  }

  const snapshots = [];
  const ids = new Set();

  for (const adapter of adapters) {
    if (!adapter || typeof adapter.getSnapshot !== "function") {
      throw new Error("each adapter must implement getSnapshot()");
    }

    const snapshot = normalizeSnapshot(await adapter.getSnapshot());
    if (ids.has(snapshot.id)) {
      throw new Error("adapter ids must be unique");
    }

    ids.add(snapshot.id);
    snapshots.push(snapshot);
  }

  return snapshots;
}
