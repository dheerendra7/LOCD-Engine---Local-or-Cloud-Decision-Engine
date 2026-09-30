import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createStaticTargetAdapter, collectTargetSnapshots } from "../../../packages/adapters/src/index.js";

export function createTargetRegistry(initialTargets = []) {
  const adapters = new Map();

  const register = value => {
    const adapter = value && typeof value.getSnapshot === "function"
      ? value
      : createStaticTargetAdapter(value);

    const id = String(adapter.id);
    if (adapters.has(id)) throw new Error("target already registered: " + id);
    adapters.set(id, adapter);
    return adapter;
  };

  for (const target of initialTargets) register(target);

  return {
    register,
    has(id) {
      return adapters.has(String(id));
    },
    remove(id) {
      return adapters.delete(String(id));
    },
    async get(id) {
      const adapter = adapters.get(String(id));
      return adapter ? adapter.getSnapshot() : null;
    },

    async probe(id) {
      const adapter = adapters.get(String(id));
      if (!adapter) throw new Error("target_not_found");
      if (typeof adapter.probe !== "function") {
        throw new Error("target_does_not_support_probe");
      }

      const snapshot = await adapter.probe();
      if (!snapshot || typeof snapshot !== "object") {
        throw new Error("probe_returned_invalid_snapshot");
      }
      return snapshot;
    },

    async heartbeat(id, patch = {}) {
      const adapter = adapters.get(String(id));
      if (!adapter) throw new Error("target_not_found");
      if (typeof adapter.setSnapshot !== "function") {
        throw new Error("target_does_not_support_heartbeat");
      }

      const snapshot = await adapter.getSnapshot();
      const allowed = [
        "available",
        "health",
        "capacity",
        "privacy",
        "estimatedLatencyMs",
        "estimatedCostUsd",
        "availableMemoryGb",
        "maxContextTokens",
        "regions",
        "capabilities"
      ];

      const next = { id: snapshot.id };
      for (const field of allowed) {
        if (field in patch) next[field] = patch[field];
      }
      next.lastHeartbeatAt = new Date().toISOString();

      const updated = await adapter.setSnapshot(next);
      return updated;
    },
    async list() {
      return collectTargetSnapshots([...adapters.values()]);
    },
    count() {
      return adapters.size;
    },
    clear() {
      adapters.clear();
    },

    async saveToFile(filePath) {
      if (!filePath) throw new Error("filePath is required");
      const snapshots = await this.list();
      const resolved = path.resolve(filePath);
      await mkdir(path.dirname(resolved), { recursive: true });

      const tempPath = resolved + ".tmp-" + process.pid + "-" + Date.now();
      await writeFile(tempPath, JSON.stringify(snapshots, null, 2) + "\n", "utf8");
      await rename(tempPath, resolved);
      return resolved;
    },

    async loadFromFile(filePath) {
      if (!filePath) throw new Error("filePath is required");
      const resolved = path.resolve(filePath);

      try {
        const content = await readFile(resolved, "utf8");
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) throw new Error("target file must contain an array");

        const fresh = new Map();
        for (const target of parsed) {
          const adapter = createStaticTargetAdapter(target);
          const id = String(adapter.id);
          if (fresh.has(id)) throw new Error("target file contains duplicate target id: " + id);
          fresh.set(id, adapter);
        }

        adapters.clear();
        for (const [id, adapter] of fresh) adapters.set(id, adapter);

        return adapters.size;
      } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
      }
    }
  };
}
