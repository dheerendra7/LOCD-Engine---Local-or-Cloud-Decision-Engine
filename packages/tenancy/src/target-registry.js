import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createStaticTargetAdapter } from "../../../packages/adapters/src/index.js";
import { createTargetRegistry } from "../../../packages/registry/src/index.js";
import { normalizeTenantId } from "./context.js";

function tenantFilePayload(registries) {
  return {
    version: 1,
    tenants: Object.fromEntries(registries)
  };
}

export function createTenantTargetRegistry({
  defaultTenantId = "default"
} = {}) {
  const defaultTenant = normalizeTenantId(defaultTenantId);
  const registries = new Map();

  function getRegistry(tenantId = defaultTenant) {
    const normalized = normalizeTenantId(tenantId);
    let registry = registries.get(normalized);
    if (!registry) {
      registry = createTargetRegistry();
      registries.set(normalized, registry);
    }
    return registry;
  }

  function forTenant(tenantId = defaultTenant) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const registry = getRegistry(normalizedTenantId);

    return {
      tenantId: normalizedTenantId,
      register(value) {
        return registry.register(value);
      },
      has(id) {
        return registry.has(id);
      },
      remove(id) {
        return registry.remove(id);
      },
      get(id) {
        return registry.get(id);
      },
      probe(id) {
        return registry.probe(id);
      },
      heartbeat(id, patch) {
        return registry.heartbeat(id, patch);
      },
      list() {
        return registry.list();
      },
      listProbeable() {
        return registry.listProbeable();
      },
      listExecutionAdapters() {
        return registry.listExecutionAdapters();
      },
      count() {
        return registry.count();
      },
      clear() {
        return registry.clear();
      }
    };
  }

  return {
    forTenant,

    // Backward-compatible single-tenant surface. These methods address the
    // configured default tenant while new callers should use forTenant().
    register(value) {
      return forTenant(defaultTenant).register(value);
    },
    has(id) {
      return forTenant(defaultTenant).has(id);
    },
    remove(id) {
      return forTenant(defaultTenant).remove(id);
    },
    get(id) {
      return forTenant(defaultTenant).get(id);
    },
    probe(id) {
      return forTenant(defaultTenant).probe(id);
    },
    heartbeat(id, patch) {
      return forTenant(defaultTenant).heartbeat(id, patch);
    },
    list() {
      return forTenant(defaultTenant).list();
    },
    listProbeable() {
      return forTenant(defaultTenant).listProbeable();
    },
    listExecutionAdapters() {
      return forTenant(defaultTenant).listExecutionAdapters();
    },
    count() {
      return forTenant(defaultTenant).count();
    },
    clear() {
      for (const registry of registries.values()) registry.clear();
    },

    listTenantIds() {
      return [...registries.keys()].sort();
    },
    hasTenant(tenantId) {
      return registries.has(normalizeTenantId(tenantId));
    },
    async loadFromFile(filePath) {
      if (!filePath) throw new Error("filePath is required");
      const resolved = path.resolve(filePath);

      let parsed;
      try {
        parsed = JSON.parse(await readFile(resolved, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
      }

      const tenantEntries = Array.isArray(parsed)
        ? { [defaultTenant]: parsed }
        : parsed?.version === 1 && parsed?.tenants && typeof parsed.tenants === "object"
          ? parsed.tenants
          : null;

      if (!tenantEntries) throw new Error("tenant target file must contain version 1 tenants or a target array");

      registries.clear();

      for (const [tenantIdRaw, targets] of Object.entries(tenantEntries)) {
        const tenantId = normalizeTenantId(tenantIdRaw);
        if (!Array.isArray(targets)) {
          throw new Error("tenant target file entry must be an array: " + tenantId);
        }
        const registry = getRegistry(tenantId);
        const seen = new Set();
        for (const target of targets) {
          const adapter = createStaticTargetAdapter(target);
          if (seen.has(adapter.id)) {
            throw new Error("tenant target file contains duplicate target id: " + adapter.id);
          }
          seen.add(adapter.id);
          registry.register(adapter);
        }
      }

      return registries.size;
    },
    async saveToFile(filePath) {
      if (!filePath) throw new Error("filePath is required");
      const resolved = path.resolve(filePath);
      await mkdir(path.dirname(resolved), { recursive: true });

      const tenants = {};
      for (const tenantId of this.listTenantIds()) {
        tenants[tenantId] = await getRegistry(tenantId).list();
      }

      const temp = resolved + ".tmp-" + process.pid + "-" + Date.now();
      await writeFile(temp, JSON.stringify(tenantFilePayload(Object.entries(tenants)), null, 2) + "\n", "utf8");
      await rename(temp, resolved);
      return resolved;
    },
    async listAll() {
      const output = [];
      for (const tenantId of this.listTenantIds()) {
        const snapshots = await getRegistry(tenantId).list();
        output.push(...snapshots.map(snapshot => ({ tenantId, ...snapshot })));
      }
      return output;
    },
    clear() {
      registries.clear();
    }
  };
}
