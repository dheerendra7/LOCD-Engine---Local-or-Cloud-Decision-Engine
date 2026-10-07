import { readFile } from "node:fs/promises";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import { createOllamaAdapter } from "./ollama.js";
import { createAnthropicAdapter } from "./anthropic.js";

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
  const value = String(env[name] ?? "");
  if (!value.trim()) {
    throw new Error("provider API key environment variable is empty: " + name);
  }
  return value;
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
  if (provider.type && !["openai-compatible", "ollama", "anthropic"].includes(provider.type)) {
    throw new Error("provider type is invalid");
  }
}

export function createProviderFromConfig(config, env = process.env, fetchImpl = globalThis.fetch) {
  validateProviderConfig(config);
  const apiKey = loadApiKey(config.apiKeyEnv, env);

  const Adapter = config.type === "ollama"
    ? createOllamaAdapter
    : config.type === "anthropic"
      ? createAnthropicAdapter
      : createOpenAICompatibleAdapter;

  return Adapter({
    ...config,
    apiKey,
    fetchImpl
  });
}

export async function loadProvidersFromFile(filePath, env = process.env, fetchImpl = globalThis.fetch) {
  if (!filePath) throw new Error("filePath is required");

  let parsed;
  try {
    const raw = await readFile(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("provider config file not found: " + filePath);
    }
    if (error instanceof SyntaxError) {
      throw new Error("provider config file is invalid JSON");
    }
    throw error;
  }

  return createProvidersFromConfig(parsed, env, fetchImpl);
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
