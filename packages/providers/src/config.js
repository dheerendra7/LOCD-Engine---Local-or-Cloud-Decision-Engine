import { createOpenAICompatibleAdapter } from "../../../packages/providers/src/index.js";

function requiredString(value, field) {
  if (!value || typeof value !== "string") throw new Error(field + " is required");
  return value;
}

function loadApiKey(ref, env = process.env) {
  if (!ref) return null;
  const name = requiredString(ref, "apiKeyEnv");
  if (!(name in env)) {
    throw new Error("provider API key environment variable is not set: " + name);
  }
  return env[name];
}

function validateProviderConfig(provider) {
  if (!provider || typeof provider !== "object") throw new Error("provider config must be an object");
  requiredString(provider.id, "id");
  requiredString(provider.targetId, "targetId");
  requiredString(provider.baseUrl, "baseUrl");
  if (provider.apiKeyEnv && typeof provider.apiKeyEnv !== "string") {
    throw new Error("apiKeyEnv must be a string");
  }
  if (provider.mode && !["local", "private", "cloud", "hybrid"].includes(provider.mode)) {
    throw new Error("provider mode is invalid");
  }
}

export function createProviderFromConfig(config, env = process.env, fetchImpl = globalThis.fetch) {
  validateProviderConfig(config);
  const apiKey = loadApiKey(config.apiKeyEnv, env);

  return createOpenAICompatibleAdapter({
    ...config,
    apiKey,
    fetchImpl
  });
}

export function createProvidersFromConfig(config, env = process.env, fetchImpl = globalThis.fetch) {
  if (!config || typeof config !== "object" || !Array.isArray(config.providers)) {
    throw new Error("provider config must contain a providers array");
  }

  const ids = new Set();
  return config.providers.map(provider => {
    const adapter = createProviderFromConfig(provider, env, fetchImpl);
    if (ids.has(adapter.id)) throw new Error("duplicate provider id: " + adapter.id);
    ids.add(adapter.id);
    return adapter;
  });
}
