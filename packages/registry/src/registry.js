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
    async list() {
      return collectTargetSnapshots([...adapters.values()]);
    },
    count() {
      return adapters.size;
    },
    clear() {
      adapters.clear();
    }
  };
}
