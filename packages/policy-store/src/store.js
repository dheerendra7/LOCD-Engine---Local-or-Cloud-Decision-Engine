import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getPolicyProfile,
  listPolicyProfiles,
  resolvePolicy
} from "../../../packages/policy/src/index.js";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";

const FILE_VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ALLOWED_FIELDS = new Set([
  "id",
  "name",
  "description",
  "baseProfile",
  "sensitiveDataMode",
  "allowedModes",
  "blockedModes",
  "allowedRegions",
  "maxHeartbeatAgeMs",
  "weights",
  "rules"
]);
const WEIGHT_KEYS = new Set(["privacy", "latency", "cost", "capacity", "reliability"]);
const BUILTIN_POLICY_IDS = new Set(listPolicyProfiles().map(profile => profile.id));

export function createPersistenceQueue(persist) {
  if (typeof persist !== "function") {
    throw new Error("persist must be a function");
  }

  let tail = Promise.resolve();

  return value => {
    const operation = tail.then(() => persist(value));
    tail = operation.catch(() => {});
    return operation;
  };
}

function validatePolicyDocument(input) {
  if (!input || typeof input !== "object") {
    throw new Error("policy document must be an object");
  }

  const id = String(input.id || "").trim().toLowerCase();
  if (!id || !ID_PATTERN.test(id)) {
    throw new Error("policy id must match " + ID_PATTERN);
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error("policy field is not supported: " + key);
    }
  }

  if (id.includes("::")) {
    throw new Error("policy id must not contain ::");
  }

  const baseProfile = String(input.baseProfile || "balanced");
  getPolicyProfile(baseProfile);

  if (input.name != null && typeof input.name !== "string") {
    throw new Error("policy name must be a string");
  }
  if (input.description != null && typeof input.description !== "string") {
    throw new Error("policy description must be a string");
  }

  if (input.weights != null) {
    if (!input.weights || typeof input.weights !== "object" || Array.isArray(input.weights)) {
      throw new Error("policy weights must be an object");
    }
    for (const [key, value] of Object.entries(input.weights)) {
      if (!WEIGHT_KEYS.has(key)) throw new Error("unknown policy weight: " + key);
      if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
        throw new Error("policy weight must be between 0 and 1: " + key);
      }
    }
  }

  const candidate = {
    ...structuredClone(input),
    id,
    profile: baseProfile
  };

  resolvePolicy(candidate, {
    workload: {
      type: "policy-validation",
      sensitivity: "low",
      requiredCapabilities: []
    }
  });

  return {
    id,
    name: input.name ? String(input.name) : id,
    description: input.description ? String(input.description) : "",
    baseProfile,
    ...(input.sensitiveDataMode == null ? {} : { sensitiveDataMode: input.sensitiveDataMode }),
    ...(input.allowedModes == null ? {} : { allowedModes: structuredClone(input.allowedModes) }),
    ...(input.blockedModes == null ? {} : { blockedModes: structuredClone(input.blockedModes) }),
    ...(input.allowedRegions == null ? {} : { allowedRegions: structuredClone(input.allowedRegions) }),
    ...(input.maxHeartbeatAgeMs == null ? {} : { maxHeartbeatAgeMs: input.maxHeartbeatAgeMs }),
    ...(input.weights == null ? {} : { weights: structuredClone(input.weights) }),
    ...(input.rules == null ? {} : { rules: structuredClone(input.rules) })
  };
}

function clonePolicy(record) {
  return structuredClone(record);
}

function normalizeState(parsed) {
  if (!parsed) return { version: FILE_VERSION, tenants: {} };
  if (
    parsed.version === FILE_VERSION &&
    parsed.tenants &&
    typeof parsed.tenants === "object" &&
    !Array.isArray(parsed.tenants)
  ) {
    return parsed;
  }
  throw new Error("policy file must contain version 1 tenants");
}

function buildEffectivePolicy(record) {
  return resolvePolicy({
    profile: record.baseProfile,
    ...record.policy
  }, {
    workload: {
      type: "policy-preview",
      sensitivity: "low",
      requiredCapabilities: []
    }
  });
}

export function createPolicyStore({
  maxVersionsPerPolicy = 20,
  now = () => new Date().toISOString()
} = {}) {
  if (!Number.isInteger(maxVersionsPerPolicy) || maxVersionsPerPolicy < 1) {
    throw new Error("maxVersionsPerPolicy must be a positive integer");
  }

  const state = { version: FILE_VERSION, tenants: {} };

  function tenantBucket(tenantId) {
    const normalized = normalizeTenantId(tenantId);
    if (!state.tenants[normalized]) {
      state.tenants[normalized] = { policies: {} };
    }
    return state.tenants[normalized];
  }

  function list(tenantId) {
    const normalized = normalizeTenantId(tenantId);
    const bucket = state.tenants[normalized];
    if (!bucket) return [];
    return Object.values(bucket.policies)
      .map(clonePolicy)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function get(tenantId, id) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const policyId = String(id || "").trim().toLowerCase();
    const record = state.tenants[normalizedTenantId]?.policies?.[policyId];
    return record ? clonePolicy(record) : null;
  }

  function effective(tenantId, id) {
    const record = get(tenantId, id);
    return record ? buildEffectivePolicy(record) : null;
  }

  function history(tenantId, id) {
    const record = get(tenantId, id);
    return record ? clonePolicy({ id: record.id, versions: record.versions }) : null;
  }

  function upsert(tenantId, input, metadata = {}) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const policy = validatePolicyDocument(input);

    if (BUILTIN_POLICY_IDS.has(policy.id)) {
      throw new Error("built-in policy IDs are read-only");
    }

    const bucket = tenantBucket(normalizedTenantId);
    const previous = bucket.policies[policy.id];
    const nextVersion = previous ? previous.version + 1 : 1;

    const updatedAt = String(metadata.updatedAt || now());
    const updatedBy = metadata.updatedBy == null ? null : String(metadata.updatedBy);

    const record = {
      id: policy.id,
      tenantId: normalizedTenantId,
      version: nextVersion,
      updatedAt,
      updatedBy,
      policy,
      versions: [
        ...(previous?.versions || []),
        {
          version: nextVersion,
          updatedAt,
          updatedBy,
          policy: clonePolicy(policy)
        }
      ].slice(-maxVersionsPerPolicy)
    };

    bucket.policies[policy.id] = record;
    return clonePolicy(record);
  }

  function rollback(tenantId, id, version, metadata = {}) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const policyId = String(id || "").trim().toLowerCase();
    const selectedVersion = Number(version);
    if (!Number.isInteger(selectedVersion) || selectedVersion < 1) {
      throw new Error("policy version must be a positive integer");
    }

    const record = state.tenants[normalizedTenantId]?.policies?.[policyId];
    const selected = record?.versions?.find(item => item.version === selectedVersion);
    if (!selected) return null;

    const restored = upsert(normalizedTenantId, selected.policy, metadata);
    return {
      ...restored,
      rolledBackFromVersion: selectedVersion
    };
  }

  function remove(tenantId, id) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const policyId = String(id || "").trim().toLowerCase();
    const bucket = state.tenants[normalizedTenantId];
    if (!bucket?.policies?.[policyId]) return false;
    delete bucket.policies[policyId];
    return true;
  }

  function exportState() {
    return structuredClone(state);
  }

  function importState(parsed) {
    const normalized = normalizeState(parsed);
    state.version = FILE_VERSION;
    state.tenants = {};
    for (const [tenantIdRaw, tenantBucketValue] of Object.entries(normalized.tenants)) {
      const tenantId = normalizeTenantId(tenantIdRaw);
      if (!tenantBucketValue?.policies || typeof tenantBucketValue.policies !== "object") {
        throw new Error("policy tenant entry is invalid: " + tenantId);
      }
      for (const [policyId, record] of Object.entries(tenantBucketValue.policies)) {
        const policy = validatePolicyDocument(record.policy);
        const version = Number(record.version);
        if (!Number.isInteger(version) || version < 1) {
          throw new Error("policy version is invalid: " + policyId);
        }
        state.tenants[tenantId] ??= { policies: {} };
        state.tenants[tenantId].policies[policy.id] = {
          ...clonePolicy(record),
          id: policy.id,
          tenantId,
          policy,
          versions: Array.isArray(record.versions) ? clonePolicy(record.versions).slice(-maxVersionsPerPolicy) : []
        };
      }
    }
  }

  return {
    list,
    get,
    effective,
    history,
    upsert,
    rollback,
    remove,
    exportState,
    importState
  };
}

export async function createFilePolicyStore({
  filePath,
  maxVersionsPerPolicy = 20,
  now = () => new Date().toISOString()
} = {}) {
  if (!filePath) throw new Error("filePath is required");
  const resolved = path.resolve(filePath);
  const store = createPolicyStore({ maxVersionsPerPolicy, now });

  try {
    const raw = await readFile(resolved, "utf8");
    store.importState(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const persist = async snapshot => {
    await mkdir(path.dirname(resolved), { recursive: true });
    const temp = resolved + ".tmp-" + process.pid + "-" + Date.now();
    await writeFile(temp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(temp, resolved);
  };
  const enqueuePersist = createPersistenceQueue(persist);

  return {
    list: store.list,
    get: store.get,
    effective: store.effective,
    history: store.history,
    async upsert(tenantId, input, metadata) {
      const result = store.upsert(tenantId, input, metadata);
      await enqueuePersist(store.exportState());
      return result;
    },
    async rollback(tenantId, id, version, metadata) {
      const result = store.rollback(tenantId, id, version, metadata);
      if (!result) return null;
      await enqueuePersist(store.exportState());
      return result;
    },
    async remove(tenantId, id) {
      const removed = store.remove(tenantId, id);
      if (removed) await enqueuePersist(store.exportState());
      return removed;
    },
    exportState: store.exportState,
    importState: store.importState,
    filePath: resolved
  };
}
