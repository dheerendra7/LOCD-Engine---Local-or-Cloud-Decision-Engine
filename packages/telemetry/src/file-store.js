import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDecisionStore } from "./store.js";

function loadEvents(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("telemetry file must contain an array");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function atomicWrite(filePath, value) {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = resolved + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temp, resolved);
}

export function createFileDecisionStore({ filePath, maxEntries = 500 } = {}) {
  if (!filePath) throw new Error("filePath is required");

  const resolved = path.resolve(filePath);
  const store = createDecisionStore({
    maxEntries,
    initialEvents: loadEvents(resolved)
  });

  const persist = () => {
    const chronological = store.list({ limit: maxEntries }).reverse();
    atomicWrite(resolved, chronological);
  };

  return {
    record(event) {
      const result = store.record(event);
      persist();
      return result;
    },

    recordOutcome(id, patch, options) {
      const result = store.recordOutcome(id, patch, options);
      persist();
      return result;
    },

    list(options) {
      return store.list(options);
    },

    summary(options) {
      return store.summary(options);
    },

    clear(options) {
      store.clear(options);
      persist();
    }
  };
}
