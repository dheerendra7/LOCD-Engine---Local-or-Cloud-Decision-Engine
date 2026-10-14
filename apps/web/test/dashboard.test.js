import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const webRoot = new URL("../", import.meta.url);

test("decision console exposes policy simulator controls", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  for (const id of [
    "simulationCurrentPolicy",
    "simulationCandidatePolicy",
    "simulatePolicy",
    "simulationStatus",
    "simulationOutput",
    "metrics"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /Simulate a policy change safely/);
});

test("decision console calls the read-only simulator endpoint", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /fetch\("\/v1\/policies\/simulate"/);
  assert.match(script, /idempotency-key/);
  assert.match(script, /mutatedState === false/);
  assert.match(script, /executedProvider === false/);
  assert.match(script, /basePolicy\.sensitiveDataMode = privacyOverride/);
  assert.match(script, /candidatePolicy\.sensitiveDataMode = privacyOverride/);
});


test("LOCD control plane uses a light-only responsive design system", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const css = await readFile(new URL("styles.css", webRoot), "utf8");
  assert.match(html, /href="\/styles\.css"/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /@media\s*\(max-width:\s*920px\)/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
});

test("control-plane navigation exposes real operational workflows", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  for (const id of [
    "overview", "decision-lab", "target-registry", "policy-workbench",
    "hybrid-planner", "telemetry", "system-settings", "targetCount",
    "avgLatency", "readinessState", "policyForm", "policyHistory",
    "hybridStepRows", "executeDryRun", "activityTableBody", "outcomeForm",
    "calibrationRows", "capabilities", "systemStatus"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), "missing console control: " + id);
  }
});

test("light control plane allows same-origin stylesheet loading under CSP", async () => {
  const server = await readFile(new URL("../api/src/server.js", webRoot), "utf8");
  assert.match(server, /style-src 'self' 'unsafe-inline'/);
  assert.match(server, /connect-src 'self'/);
});

test("hybrid planner exposes dry-run only and avoids live execution controls", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(html, /Dry-run only/);
  assert.match(script, /mode:\s*"dry-run"/);
  assert.doesNotMatch(script, /mode:\s*"live"/);
  assert.match(script, /\/v1\/hybrid-plan/);
  assert.match(script, /\/v1\/execute/);
});

test("console operational data is fetched from LOCD API endpoints", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  for (const endpoint of [
    "/v1/status", "/v1/metrics", "/v1/targets", "/v1/policies",
    "/v1/decisions?limit=25", "/v1/calibration", "/v1/outcomes",
    "/v1/policies/simulate"
  ]) {
    assert.ok(script.includes(endpoint), "missing API integration: " + endpoint);
  }
  assert.doesNotMatch(script, /localStorage\.(?:setItem|removeItem)\(/);
});


test("custom policy defaults inherit the selected base profile weights", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(html, /id="newPolicyWeights"[^>]*>\{\}<\/textarea>/);
  assert.match(html, /Base profile/);
  assert.match(script, /weights,\s*rules/);
});

test("target registry labels capacity as a score, not observed utilization", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(html, /Capacity score/);
  assert.match(script, /Capacity score/);
  assert.doesNotMatch(script, /Capacity used \/ score/);
});


test("decision and target actions guard duplicate submissions and validate numeric input", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /querySelector\("#decide"\)[\s\S]*?button\.disabled = true/);
  assert.match(script, /querySelector\("#registerTarget"\)[\s\S]*?button\.disabled = true/);
  assert.match(script, /portalFetch\("\/v1\/decide", portalJsonOptions\(body\)\)/);
  assert.match(script, /portalFetch\("\/v1\/targets", portalJsonOptions\(payload\)\)/);
  assert.match(script, /readNumber\("targetCapacity", "Capacity score", \{ min: 0, max: 1 \}\)/);
});


test("dry-run UI documents the API execute-scope requirement", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  assert.match(html, /key must include the <code>execute<\/code> scope/);
  assert.match(html, /sends <code>mode: "dry-run"<\/code> only/);
});

test("hybrid plans are invalidated when inputs or registered targets change", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /function invalidateHybridPlan\(\)/);
  assert.match(script, /lastHybridPlan = null/);
  assert.match(script, /executeButton\.disabled = true/);
  assert.match(script, /targetRegistryChanged\) invalidateHybridPlan\(\)/);
  assert.match(script, /document\.querySelector\("#hybridStepRows"\)\?\.addEventListener\("input", invalidateHybridPlan\)/);
  assert.match(script, /document\.querySelector\("#hybridStepRows"\)\?\.addEventListener\("change", invalidateHybridPlan\)/);
  assert.match(script, /requestRevision !== hybridInputRevision/);
  assert.match(script, /Validation result discarded/);
  assert.match(script, /No dry-run is available until the current plan is validated/);
}); 

test("policy and hybrid budget parsing rejects blank, negative and non-finite values", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /latencyBudgetMs: readNonNegativeInput\("latency", "Latency budget"\)/);
  assert.match(script, /maxCostUsd: readNonNegativeInput\("cost", "Maximum cost"\)/);
  assert.match(script, /maxLatencyMs: readNonNegativeInput\("hybridLatency", "Hybrid latency budget"\)/);
  assert.match(script, /maxCostUsd: readNonNegativeInput\("hybridCost", "Hybrid cost budget"\)/);

  const start = script.indexOf("function parseNonNegativeNumber(");
  const end = script.indexOf("\nfunction readNonNegativeInput(", start);
  assert.ok(start >= 0 && end > start, "numeric parser should be defined before its DOM adapter");
  const parseNonNegativeNumber = new Function(script.slice(start, end) + "; return parseNonNegativeNumber;")();

  assert.equal(parseNonNegativeNumber("0", "Budget"), 0);
  assert.equal(parseNonNegativeNumber("12.5", "Budget"), 12.5);
  for (const value of ["", "  ", "-1", "Infinity", "NaN"]) {
    assert.throws(() => parseNonNegativeNumber(value, "Budget"), /finite number of zero or greater/);
  }
});

test("hybrid planner rejects incomplete stages and single-target plans before calling the API", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /Every stage needs a non-empty stage ID/);
  assert.match(script, /Stage IDs must be unique/);
  assert.match(script, /Choose a registered target for every stage/);
  assert.match(script, /Choose at least two distinct registered targets across the stages/);
  assert.match(script, /new Set\(body\.steps\.map\(step => String\(step\.targetId\)\)\)\.size < 2/);
});

test("changing the policy catalog invalidates a previously validated hybrid plan", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /let lastPolicyCatalogFingerprint = null/);
  assert.match(script, /fingerprint !== lastPolicyCatalogFingerprint/);
  assert.match(script, /Plan requires revalidation/);
  assert.match(script, /Planner inputs, registered targets, or policy definitions changed/);
});

test("system access help documents each API operation scope", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  for (const scope of ["read", "decide", "targets", "telemetry", "execute", "admin"]) {
    assert.match(html, new RegExp("<code>" + scope + "</code>"), "missing API scope guidance: " + scope);
  }
  assert.match(html, /Keys need <code>read<\/code> plus the matching action scope, or <code>admin<\/code>/);
});

test("refreshing a changed or unavailable policy catalog expires the previous hybrid plan", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /let lastPolicyCatalogFingerprint = null/);
  assert.match(script, /JSON\.stringify\(policies\)/);
  assert.match(script, /fingerprint !== lastPolicyCatalogFingerprint/);
  assert.match(script, /lastPolicyCatalogFingerprint = null;[\s\S]*?invalidateHybridPlan\(\)/);
  assert.match(script, /Plan inputs, targets, or policy catalog changed/);
  assert.match(script, /planOutput\.innerHTML = emptyState\([\s\S]*?Plan requires revalidation/);
});

test("hybrid step validation enforces unique IDs, registered targets, and genuine hybrid routing", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const match = script.match(/function validateHybridSteps\(steps, registeredTargets\) \{[\s\S]*?\n\}/);
  assert.ok(match, "a pure hybrid-step validator should exist");
  const validateHybridSteps = new Function(match[0] + "; return validateHybridSteps;")();
  const targets = [{ id: "local", mode: "local" }, { id: "cloud", mode: "cloud" }];
  const valid = [{ id: "prepare", targetId: "local" }, { id: "infer", targetId: "cloud" }];

  assert.equal(validateHybridSteps(valid, targets), null);
  assert.match(validateHybridSteps([{ id: "only" }], targets), /at least two stages/);
  assert.match(validateHybridSteps([{ id: " " , targetId: "local" }, { id: "infer", targetId: "cloud" }], targets), /non-empty stage ID/);
  assert.match(validateHybridSteps([{ id: "same", targetId: "local" }, { id: "same", targetId: "cloud" }], targets), /unique/);
  assert.match(validateHybridSteps([{ id: "a", targetId: "missing" }, { id: "b", targetId: "cloud" }], targets), /registered target/);
  assert.match(validateHybridSteps([{ id: "a", targetId: "local" }, { id: "b", targetId: "local" }], targets), /two distinct registered targets/);
});

test("dashboard scope guidance matches the API's actual authorizer contract", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const server = await readFile(new URL("../api/src/server.js", webRoot), "utf8");
  const match = server.match(/function requiredScope\(method, pathname\) \{[\s\S]*?\n\}/);
  assert.ok(match, "API requiredScope must remain available for contract tests");
  const requiredScope = new Function(match[0] + "; return requiredScope;")();

  assert.equal(requiredScope("GET", "/v1/status"), "read");
  assert.equal(requiredScope("POST", "/v1/decide"), "decide");
  assert.equal(requiredScope("POST", "/v1/hybrid-plan"), "decide");
  assert.equal(requiredScope("POST", "/v1/policies/simulate"), "decide");
  assert.equal(requiredScope("POST", "/v1/targets"), "targets");
  assert.equal(requiredScope("DELETE", "/v1/targets/local"), "targets");
  assert.equal(requiredScope("POST", "/v1/outcomes"), "telemetry");
  assert.equal(requiredScope("POST", "/v1/execute"), "execute");
  assert.equal(requiredScope("POST", "/v1/policies"), "admin");
  assert.equal(requiredScope("POST", "/v1/policies/demo/rollback"), "admin");
  for (const scope of ["read", "decide", "targets", "telemetry", "execute", "admin"]) {
    assert.match(html, new RegExp("<code>" + scope + "</code>"));
  }
});

test("the dashboard has one implementation per named function and one API transport path", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const names = [...script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]);
  const duplicates = Object.entries(names.reduce((counts, name) => {
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {})).filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, []);
  assert.match(script, /async function portalFetch\(/);
  assert.match(script, /const result = await portalFetch\("\/v1\/policies\/simulate", portalJsonOptions\(body\)\)/);
  assert.doesNotMatch(script, /fetch\(["'`]\/v1\//);
});

test("dashboard HTML escaping protects rendered API text from markup injection", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const match = script.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "the UI should centralize escaping before inserting API data into HTML");
  const escapeHtml = new Function(match[0] + "; return escapeHtml;")();
  assert.equal(
    escapeHtml("<img src=x onerror=\"alert(1)\">&'"),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#039;"
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

test("using a policy preserves the current what-if baseline and selects a distinct candidate", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf('if (action === "use") {');
  const end = script.indexOf('\n  if (action === "history")', start);
  assert.ok(start >= 0 && end > start, "the policy-card use action should be present");
  const handler = script.slice(start, end);
  assert.match(handler, /\["policyProfile", "simulationCandidatePolicy", "hybridPolicyProfile"\]/);
  assert.doesNotMatch(handler, /simulationCurrentPolicy/);
  assert.match(handler, /The current baseline is unchanged/);
});

test("policy simulation renders missing deltas as unknown, not zero", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const match = script.match(/function formatDelta\(value, unit = "", digits = 3\) \{[\s\S]*?\n\}/);
  assert.ok(match, "simulation delta formatter should exist");
  const formatDelta = new Function(match[0] + "; return formatDelta;")();
  assert.equal(formatDelta(null), "—");
  assert.equal(formatDelta(undefined), "—");
  assert.equal(formatDelta(""), "—");
  assert.equal(formatDelta("   "), "—");
  assert.equal(formatDelta(Infinity), "—");
  assert.equal(formatDelta(0), "0.000");
  assert.equal(formatDelta(1.25, " ms", 2), "+1.25 ms");
  assert.equal(formatDelta(-1.25, " USD", 3), "-1.250 USD");
});

test("API transport converts authentication, scope, registry, and rate-limit errors into actionable messages", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const match = script.match(/async function portalFetch\(path, options = \{\}\) \{[\s\S]*?\n\}/);
  assert.ok(match, "the dashboard should centralize API response handling");

  let nextResponse;
  const mockedFetch = async () => nextResponse;
  const portalFetch = new Function("fetch", "apiHeaders", match[0] + "; return portalFetch;")(
    mockedFetch,
    () => ({})
  );

  const rejectedResponse = (status, error) => ({
    ok: false,
    status,
    json: async () => ({ error })
  });

  nextResponse = rejectedResponse(401, "unauthorized");
  await assert.rejects(
    () => portalFetch("/v1/status"),
    /Authentication required\. Add a scoped LOCD API key/
  );

  nextResponse = rejectedResponse(403, "insufficient_scope");
  await assert.rejects(
    () => portalFetch("/v1/execute"),
    /This API key does not have permission/
  );

  nextResponse = rejectedResponse(404, "target_not_found");
  await assert.rejects(
    () => portalFetch("/v1/targets/missing"),
    /That target no longer exists/
  );

  nextResponse = rejectedResponse(503, "no_registered_targets");
  await assert.rejects(
    () => portalFetch("/v1/decide"),
    /No targets are registered for this tenant/
  );

  nextResponse = rejectedResponse(429, "rate_limit_exceeded");
  await assert.rejects(
    () => portalFetch("/v1/decide"),
    /Rate limit reached/
  );

  nextResponse = rejectedResponse(400, "workload.type is required");
  await assert.rejects(
    () => portalFetch("/v1/decide"),
    /workload\.type is required/
  );
});

test("API keys are applied explicitly and access changes reset tenant-scoped UI state", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const headersMatch = script.match(/function apiHeaders\(\) \{[\s\S]*?\n\}/);
  assert.ok(headersMatch, "API headers helper should exist");
  const createHeaders = new Function("initialKey", "let activeApiKey = initialKey;" +
    headersMatch[0] +
    "; return { get: apiHeaders, set(key) { activeApiKey = key; } };");
  const headers = createHeaders("");
  assert.deepEqual(headers.get(), {});
  headers.set("tenant-a-key");
  assert.deepEqual(headers.get(), { authorization: "Bearer tenant-a-key" });
  headers.set("");
  assert.deepEqual(headers.get(), {});

  assert.match(script, /let apiAccessRevision = 0/);
  assert.match(script, /function resetTenantScopedView\(\)/);
  assert.match(script, /lastPolicyCatalogFingerprint = null/);
  assert.match(script, /invalidateHybridPlan\(\)/);
  assert.match(script, /activityBody\.innerHTML = .*Loading decision history/);
  assert.match(script, /setText\("decisionCount", "—"\)/);
  assert.match(script, /setText\("outcomeDecisionId"/);
  assert.match(script, /activeApiKey = nextApiKey/);
  assert.match(script, /apiAccessRevision \+= 1/);
  assert.doesNotMatch(script, /querySelector\("#apiKey"\)\.addEventListener\("change", refreshAll\)/);
});

test("in-flight API refreshes and mutations ignore responses from a previous access context", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const guardedRefreshes = [
    "refreshTargets", "refreshPolicies", "refreshMetrics", "refreshStatus",
    "refreshActivity", "refreshCalibration", "refreshHealth", "refreshReadiness"
  ];
  for (const name of guardedRefreshes) {
    const start = script.indexOf("async function " + name + "()");
    assert.ok(start >= 0, "missing refresh function: " + name);
    const nextAsync = script.indexOf("\nasync function ", start + 10);
    const nextFunction = script.indexOf("\nfunction ", start + 10);
    const nextDocument = script.indexOf("\ndocument.", start + 10);
    const endings = [nextAsync, nextFunction, nextDocument].filter(index => index >= 0);
    const end = endings.length ? Math.min(...endings) : script.length;
    const block = script.slice(start, end);
    assert.match(block, /const accessRevision = apiAccessRevision/);
    assert.match(block, /accessRevision !== apiAccessRevision/);
  }

  assert.match(script, /await Promise\.allSettled\(tasks\);[\s\S]*?accessRevision === apiAccessRevision && button/);
  assert.match(script, /async function portalFetch[\s\S]*?throw new Error\(message\)/);
  for (const marker of [
    'document.querySelector("#decide").addEventListener',
    'document.querySelector("#registerTarget").addEventListener',
    'document.querySelector("#simulatePolicy").addEventListener',
    'document.querySelector("#outcomeForm")?.addEventListener',
    'document.querySelector("#planHybrid")?.addEventListener',
    'document.querySelector("#executeDryRun")?.addEventListener'
  ]) {
    const start = script.indexOf(marker);
    assert.ok(start >= 0, "missing mutation handler: " + marker);
    const end = script.indexOf("\n});", start);
    const block = script.slice(start, end >= 0 ? end : start + 5000);
    assert.match(block, /const accessRevision = apiAccessRevision/);
    assert.match(block, /accessRevision !== apiAccessRevision/);
  }
});
