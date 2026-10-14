import { createServer } from "../../apps/api/src/server.js";
import { createScopedAuthorizer } from "../../packages/auth/src/index.js";
import { createExecutionRegistry } from "../../packages/execution/src/index.js";
import { createPolicyStore } from "../../packages/policy-store/src/index.js";
import { createOpenAICompatibleAdapter } from "../../packages/providers/src/index.js";
import { createTargetRegistry } from "../../packages/registry/src/index.js";

const syntheticPayload = {
  model: "research-only-synthetic-model",
  messages: [{ role: "user", content: "SYNTHETIC_RESIDENCY_PROBE_NOT_REAL_DATA" }]
};

const providerObservations = [];
const provider = createOpenAICompatibleAdapter({
  id: "research-fake-provider",
  targetId: "us-cloud",
  baseUrl: "https://fake-provider.invalid",
  mode: "cloud",
  regions: ["us-east-1"],
  timeoutMs: 1000,
  fetchImpl: async (url, options = {}) => {
    providerObservations.push({
      url: String(url),
      method: options.method || "GET",
      syntheticPayloadObserved: typeof options.body === "string" &&
        options.body.includes("SYNTHETIC_RESIDENCY_PROBE_NOT_REAL_DATA")
    });
    return new Response(JSON.stringify({
      id: "synthetic-probe-response",
      choices: [{ message: { role: "assistant", content: "synthetic-ok" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});

const policyStore = createPolicyStore();
policyStore.upsert("acme", {
  id: "acme-local-eu-only",
  baseProfile: "balanced",
  allowedModes: ["local"],
  allowedRegions: ["eu-west-1"]
});

const authorizer = createScopedAuthorizer({
  keys: [{
    id: "research-executor",
    secret: "research-only-secret",
    tenantId: "acme",
    scopes: ["execute"]
  }]
});

const server = createServer({
  authorizer,
  policyStore,
  targetRegistry: createTargetRegistry([{
    id: "us-cloud",
    mode: "cloud",
    available: true,
    health: 1,
    capacity: 0.5,
    privacy: 0.2,
    regions: ["us-east-1"]
  }]),
  executionRegistry: createExecutionRegistry([provider]),
  executionEnabled: true,
  rateLimitMaxRequests: 10
});

let serverUrl;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  serverUrl = "http://127.0.0.1:" + server.address().port;

  // Deliberately caller-constructed: do not route through /v1/hybrid-plan.
  // This isolates whether /v1/execute independently enforces the tenant policy.
  const suppliedPlan = {
    planVersion: "1.0",
    route: "hybrid",
    valid: true,
    steps: [{
      id: "synthetic-inference",
      targetId: "us-cloud",
      purpose: "inference",
      payload: syntheticPayload
    }]
  };

  const response = await fetch(serverUrl + "/v1/execute", {
    method: "POST",
    headers: {
      authorization: "Bearer research-only-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({ mode: "live", plan: suppliedPlan })
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = { unparsedResponse: true };
  }

  const observedForward = providerObservations.some(item =>
    item.method === "POST" &&
    item.url.endsWith("/v1/chat/completions") &&
    item.syntheticPayloadObserved
  );

  console.log(JSON.stringify({
    experiment: "execution-time-tenant-policy-boundary",
    mode: "loopback-api + injected-fake-provider",
    tenantPolicy: {
      allowedModes: ["local"],
      allowedRegions: ["eu-west-1"]
    },
    suppliedTarget: {
      id: "us-cloud",
      mode: "cloud",
      regions: ["us-east-1"]
    },
    httpStatus: response.status,
    apiExecutionStatus: responseBody?.status ?? null,
    fakeProviderRequestCount: providerObservations.length,
    syntheticPayloadObservedAtFakeProvider: observedForward,
    finding: observedForward ? "REPRODUCED" : "NOT_REPRODUCED",
    interpretation: observedForward
      ? "The caller-supplied plan reached the fake provider despite conflicting tenant policy. This demonstrates an execution-boundary policy gap in this harness only; it does not prove physical geographic residency or a production incident."
      : "The synthetic payload was not observed at the fake provider. Inspect httpStatus and apiExecutionStatus; this result alone does not prove comprehensive policy enforcement.",
    responseBody
  }, null, 2));
} finally {
  if (server.listening) {
    await new Promise(resolve => server.close(resolve));
  }
}
