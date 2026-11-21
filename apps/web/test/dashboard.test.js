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
  assert.match(script, /portalFetch\("\/v1\/policies\/simulate",\s*portalJsonOptions\(body\)\)/);
  assert.match(script, /idempotency-key/);
  assert.match(script, /mutatedState === false/);
  assert.match(script, /executedProvider === false/);
  assert.match(script, /basePolicy\.sensitiveDataMode = privacyOverride/);
  assert.match(script, /candidatePolicy\.sensitiveDataMode = privacyOverride/);
});


test("LOCD public website is a product-led developer platform, not an editorial landing page", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const css = await readFile(new URL("styles.css", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(html, /id="public-site"/);
  assert.match(html, /id="lmHeroTitle"/);
  assert.match(html, /lm-product-visual/);
  assert.match(html, /EXAMPLE EVALUATION/);
  assert.match(html, /id="product"/);
  assert.match(html, /id="solutions"/);
  assert.match(html, /id="resources"/);
  assert.match(html, /POST/);
  assert.match(html, /\/v1\/decide/);
  assert.match(html, /local-only/);
  assert.match(html, /lm-destination-grid/);
  assert.match(css, /\.lm-product-visual/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--lm-bg:\s*#f2f1eb/);
  assert.match(css, /body::before\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /background-size:\s*44px 44px/);
  assert.match(css, /\.lm-code\s*\{[^}]*background:\s*#272923/);
  assert.match(css, /\.lm-platform-grid/);
  assert.match(css, /\.lm-developer-grid/);
  assert.match(css, /\.sidebar\s*\{[^}]*background:\s*rgba\(245,243,235,\.88\)/);
  assert.match(css, /--page:\s*#f2f1eb/);
  assert.match(html, /theme-color" content="#f2f1eb"/);
  assert.match(css, /@media\s*\(max-width:\s*680px\)/);
  assert.match(script, /initializePublicSiteNavigation/);
  assert.match(script, /app-mode/);
  assert.doesNotMatch(html, /Trusted by Developers|Loved by teams|10,000\+/);
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
    "/v1/decisions?limit=", "/v1/calibration", "/v1/outcomes",
    "/v1/policies/simulate"
  ]) {
    assert.ok(script.includes(endpoint), "missing API integration: " + endpoint);
  }
  assert.doesNotMatch(script, /localStorage\.(?:setItem|removeItem)\(/);
  assert.match(script, /decisionActivityLimit = 100/);
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
  assert.match(script, /new Set\(steps\.map\(step => String\(step\.targetId\)\)\)\.size < 2/);
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
  assert.doesNotMatch(handler, /newPolicyId/);
  assert.match(handler, /The current baseline and new-policy form are unchanged/);
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
  const accessNoticeStates = [];
  const mockedFetch = async () => nextResponse;
  const portalFetch = new Function("fetch", "apiHeaders", "setApiAccessNotice", match[0] + "; return portalFetch;")(
    mockedFetch,
    () => ({}),
    state => accessNoticeStates.push(state)
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
  assert.deepEqual(accessNoticeStates, ["missing"]);

  nextResponse = rejectedResponse(403, "insufficient_scope");
  await assert.rejects(
    () => portalFetch("/v1/execute"),
    /This API key does not have permission/
  );
  assert.deepEqual(accessNoticeStates, ["missing", "scope"]);

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

  nextResponse = {
    ok: true,
    status: 200,
    json: async () => ({ service: "locd-api" })
  };
  await portalFetch("/v1/status");
  assert.deepEqual(accessNoticeStates, ["missing", "scope", "clear"]);
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
  assert.match(script, /if \(decisionId\) decisionId\.value = ""/);
  assert.match(script, /for \(const id of \["actualLatencyMs", "actualCostUsd", "targetId", "targetRegions"\]\)/);
  assert.match(script, /hybridRows\.innerHTML = "";[\s\S]*?addHybridStep\(\{ id: "prepare"/);
  assert.match(script, /addHybridStep\(\{ id: "inference"/);
  assert.match(script, /hybridOutput\.innerHTML = emptyState\("No hybrid plan"/);
  assert.match(script, /activeApiKey = nextApiKey/);
  assert.match(script, /apiAccessRevision \+= 1/);
  assert.doesNotMatch(script, /querySelector\("#apiKey"\)\.addEventListener\("change", refreshAll\)/);
});

test("in-flight API refreshes and mutations ignore responses from a previous access context", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const guardedRefreshes = [
    "refreshTargets", "refreshPolicies", "refreshMetrics", "refreshStatus",
    "refreshActivity", "refreshCalibration", "refreshHealth", "refreshReadiness",
    "refreshReliability"
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

test("target and policy operations ignore stale responses after the API access changes", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");

  const targetStart = script.indexOf('root.querySelectorAll("button[data-action]")');
  const targetEnd = script.indexOf("\n  syncHybridTargets();", targetStart);
  assert.ok(targetStart >= 0 && targetEnd > targetStart, "target operations should be wired in the registry renderer");
  const targetActions = script.slice(targetStart, targetEnd);
  assert.match(targetActions, /const accessRevision = apiAccessRevision/);
  assert.match(targetActions, /await portalFetch\("\/v1\/targets\/" \+ encodeURIComponent\(id\), \{ method: "DELETE" \}\);[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);
  assert.match(targetActions, /\/probe[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);
  assert.match(targetActions, /catch \(error\) \{[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);

  assert.match(script, /async function showPolicyHistory\(policyId\) \{[\s\S]*?const accessRevision = apiAccessRevision;[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);
  assert.match(script, /document\.querySelector\("#policyCards"\)\?\.addEventListener\("click", async event => \{[\s\S]*?const accessRevision = apiAccessRevision;[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);
  assert.match(script, /document\.querySelector\("#policyHistory"\)\?\.addEventListener\("click", async event => \{[\s\S]*?const accessRevision = apiAccessRevision;[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);
  assert.match(script, /document\.querySelector\("#policyForm"\)\?\.addEventListener\("submit", async event => \{[\s\S]*?const accessRevision = apiAccessRevision;[\s\S]*?if \(accessRevision !== apiAccessRevision\) return/);
});

test("policy history requests ignore older responses after selection changes", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /let policyHistoryRequestRevision = 0/);

  const start = script.indexOf("async function showPolicyHistory(policyId)");
  const end = script.indexOf('\ndocument.querySelector("#policyCards")?.addEventListener', start);
  assert.ok(start >= 0 && end > start, "policy history request handler should exist");
  const history = script.slice(start, end);
  assert.match(history, /const historyRevision = \+\+policyHistoryRequestRevision/);
  assert.match(history, /if \(accessRevision !== apiAccessRevision \|\| historyRevision !== policyHistoryRequestRevision\) return/g);
  assert.match(history, /catch \(error\) \{[\s\S]*?historyRevision !== policyHistoryRequestRevision/);

  const resetStart = script.indexOf("function resetTenantScopedView()");
  const resetEnd = script.indexOf("\n}", resetStart);
  assert.match(script.slice(resetStart, resetEnd), /policyHistoryRequestRevision \+= 1/);
  const closeStart = script.indexOf('document.querySelector("#closePolicyHistory")?.addEventListener("click", () => {');
  const closeEnd = script.indexOf("\n});", closeStart);
  assert.match(script.slice(closeStart, closeEnd), /policyHistoryRequestRevision \+= 1/);
});

test("policy history only renders the latest request when responses finish out of order", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("async function showPolicyHistory(policyId) {");
  const end = script.indexOf('\ndocument.querySelector("#policyCards")?.addEventListener', start);
  assert.ok(start >= 0 && end > start, "policy history request handler should exist");
  const handler = script.slice(start, end);

  const pending = new Map();
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const root = { innerHTML: "" };
  const panel = { classList: { remove() {} } };
  const elements = new Map([
    ["#policyHistory", root],
    ["#policyHistoryPanel", panel]
  ]);
  const text = {};
  const documentMock = { querySelector: selector => elements.get(selector) || null };
  const portalFetch = path => {
    const id = decodeURIComponent(path.split("/")[3]);
    const request = deferred();
    pending.set(id, request);
    return request.promise;
  };
  const setText = (id, value) => { text[id] = value; };
  const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  const runtimeFactory = new Function(
    "document", "portalFetch", "setText", "escapeHtml", "formatDate", "emptyState", "niceError",
    "let activeHistoryPolicy = null;" +
    "let apiAccessRevision = 0;" +
    "let policyHistoryRequestRevision = 0;" +
    handler +
    "; return { showPolicyHistory, invalidateHistory() { policyHistoryRequestRevision += 1; } };"
  );
  const runtime = runtimeFactory(
    documentMock,
    portalFetch,
    setText,
    escapeHtml,
    () => "test-date",
    (title, description) => title + ": " + description,
    error => String(error?.message || error)
  );

  const older = runtime.showPolicyHistory("policy-a");
  const latest = runtime.showPolicyHistory("policy-b");
  pending.get("policy-b").resolve({
    versions: [{ version: 2, updatedAt: "2026-10-15", updatedBy: "test", policy: { description: "latest-policy-b" } }]
  });
  await latest;
  const latestMarkup = root.innerHTML;
  assert.match(latestMarkup, /latest-policy-b/);

  pending.get("policy-a").resolve({
    versions: [{ version: 1, updatedAt: "2026-10-14", updatedBy: "test", policy: { description: "stale-policy-a" } }]
  });
  await older;
  assert.equal(root.innerHTML, latestMarkup);
  assert.doesNotMatch(root.innerHTML, /stale-policy-a/);
  assert.equal(text.policyHistoryTitle, "Version history · policy-b");

  const obsoleteError = runtime.showPolicyHistory("policy-c");
  const current = runtime.showPolicyHistory("policy-d");
  pending.get("policy-d").resolve({
    versions: [{ version: 4, updatedAt: "2026-10-15", updatedBy: "test", policy: { description: "current-policy-d" } }]
  });
  await current;
  const currentMarkup = root.innerHTML;
  pending.get("policy-c").reject(new Error("stale history request failed"));
  await obsoleteError;
  assert.equal(root.innerHTML, currentMarkup);
  assert.match(root.innerHTML, /current-policy-d/);
  assert.doesNotMatch(root.innerHTML, /stale history request failed/);
});

test("policy catalog only applies the newest refresh response", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("async function refreshPolicies() {");
  const end = script.indexOf("\nasync function refreshMetrics()", start);
  assert.ok(start >= 0 && end > start, "policy refresh handler should exist");
  const handler = script.slice(start, end);

  const requests = [];
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const status = { textContent: "" };
  const baseProfile = { value: "balanced" };
  const elements = new Map([
    ["#policyManagerStatus", status],
    ["#newPolicyBase", baseProfile],
    ["#policyProfile", { innerHTML: "" }],
    ["#simulationCurrentPolicy", { innerHTML: "" }],
    ["#simulationCandidatePolicy", { innerHTML: "" }],
    ["#hybridPolicyProfile", { innerHTML: "" }]
  ]);
  const documentMock = { querySelector: selector => elements.get(selector) || null };
  const portalFetch = () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  };
  const renderedCatalogs = [];
  const setOptions = (select, options) => {
    select.options = options;
  };
  const runtimeFactory = new Function(
    "document", "portalFetch", "setPolicySelectors", "renderPolicyCards", "setOptions", "niceError",
    "let apiAccessRevision = 0;" +
    "let policyCatalogRequestRevision = 0;" +
    "let lastPolicyCatalogFingerprint = null;" +
    "let invalidationCount = 0;" +
    "function invalidateHybridPlan() { invalidationCount += 1; }" +
    handler +
    "; return { refreshPolicies, changeAccess() { apiAccessRevision += 1; }, state() { return { invalidationCount, lastPolicyCatalogFingerprint }; } };"
  );
  const runtime = runtimeFactory(
    documentMock,
    portalFetch,
    policies => {},
    policies => renderedCatalogs.push(policies.map(policy => policy.id)),
    setOptions,
    error => String(error?.message || error)
  );

  const older = runtime.refreshPolicies();
  const latest = runtime.refreshPolicies();
  requests[1].resolve({ policies: [{ id: "policy-new", name: "Latest", source: "built-in" }] });
  await latest;
  assert.deepEqual(renderedCatalogs.at(-1), ["policy-new"]);
  const latestStatus = status.textContent;
  const latestFingerprint = runtime.state().lastPolicyCatalogFingerprint;

  requests[0].resolve({ policies: [{ id: "policy-old", name: "Stale", source: "built-in" }] });
  await older;
  assert.deepEqual(renderedCatalogs.at(-1), ["policy-new"]);
  assert.equal(status.textContent, latestStatus);
  assert.equal(runtime.state().lastPolicyCatalogFingerprint, latestFingerprint);

  const obsoleteError = runtime.refreshPolicies();
  const current = runtime.refreshPolicies();
  requests[3].resolve({ policies: [{ id: "policy-current", name: "Current", source: "built-in" }] });
  await current;
  const currentStatus = status.textContent;
  requests[2].reject(new Error("obsolete catalog request failed"));
  await obsoleteError;
  assert.deepEqual(renderedCatalogs.at(-1), ["policy-current"]);
  assert.equal(status.textContent, currentStatus);

  const previousAccess = runtime.refreshPolicies();
  runtime.changeAccess();
  requests[4].resolve({ policies: [{ id: "tenant-a-policy", name: "Old tenant", source: "custom" }] });
  await previousAccess;
  assert.deepEqual(renderedCatalogs.at(-1), ["policy-current"]);
  assert.equal(status.textContent, currentStatus);


  const obsoleteAccessError = runtime.refreshPolicies();
  runtime.changeAccess();
  requests[5].reject(new Error("previous tenant catalog failed"));
  await obsoleteAccessError;
  assert.deepEqual(renderedCatalogs.at(-1), ["policy-current"]);
  assert.equal(status.textContent, currentStatus);
});

test("system capability labels distinguish sharing and durability from enabled state", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("function renderCapabilities(caps) {");
  const end = script.indexOf("function formatCircuitTimestamp", start);
  assert.ok(start >= 0 && end > start, "capability renderer should exist");
  const rendererSource = script.slice(start, end);
  const root = { innerHTML: "" };
  const render = new Function("document", "escapeHtml", rendererSource + "; return renderCapabilities;")(
    { querySelector: selector => selector === "#capabilities" ? root : null },
    value => String(value)
  );
  render({
    executionEnabled: false,
    sharedCoordination: false,
    durableCoordination: false,
    persistentTelemetry: true,
    persistentTargets: false,
    sharedCircuitBreaker: true,
    rateLimitMode: "shared",
    idempotencyMode: "process-local"
  });
  assert.ok(root.innerHTML.includes("Shared coordination</span><strong>Not shared</strong>"));
  assert.ok(root.innerHTML.includes("Durable coordination</span><strong>Non-durable</strong>"));
  assert.ok(root.innerHTML.includes("Durable telemetry</span><strong>Durable</strong>"));
  assert.ok(root.innerHTML.includes("Persistent targets</span><strong>Ephemeral</strong>"));
  assert.ok(root.innerHTML.includes("Shared circuit state</span><strong>Shared</strong>"));
  assert.ok(root.innerHTML.includes("Live execution gate</span><strong>Disabled</strong>"));
  assert.ok(root.innerHTML.includes("Rate limiting</span><strong>shared</strong>"));
  assert.ok(root.innerHTML.includes("Idempotency</span><strong>process-local</strong>"));
});
test("readiness diagnostics do not overwrite the API connection status", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(html, /id="systemStatus"/);
  assert.match(html, /id="readinessState"/);
  assert.match(html, /id="readinessChecks"/);

  const start = script.indexOf("async function refreshReadiness()");
  const end = script.indexOf("\nfunction renderCapabilities", start);
  assert.ok(start >= 0 && end > start, "readiness refresh implementation should exist");
  const readiness = script.slice(start, end);
  assert.match(readiness, /setText\("readinessChecks"/);
  assert.doesNotMatch(readiness, /setText\("systemStatus"/);
  assert.match(script, /function setStatus\(message, state\)[\s\S]*?querySelector\("#systemStatus"\)/);
});

test("metrics distinguish known and unknown estimated-cost coverage", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("async function refreshMetrics() {");
  const end = script.indexOf("\nasync function refreshActivity()", start);
  assert.ok(start >= 0 && end > start, "metrics refresh handler should exist");
  const handler = script.slice(start, end);
  const metricsNode = { textContent: "" };
  const textValues = {};
  const runtimeFactory = new Function(
    "document", "portalFetch", "setText", "formatNumber", "formatPercent",
    "formatCost", "routeLabel", "niceError",
    "let apiAccessRevision = 0;" + handler + "; return refreshMetrics;"
  );
  const refreshMetrics = runtimeFactory(
    { querySelector: selector => selector === "#metrics" ? metricsNode : null },
    async route => {
      assert.equal(route, "/v1/metrics");
      return {
        totalDecisions: 3,
        successRate: 1 / 3,
        averageEstimatedLatencyMs: 42,
        estimatedCostUsd: 0.03,
        estimatedCostKnownCount: 2,
        estimatedCostUnknownCount: 1,
        averageConfidence: 0.8,
        outcomes: { success: 1, failure: 2 },
        routes: { local: 2, cloud: 1 }
      };
    },
    (id, value) => { textValues[id] = value; },
    (value, fallback) => value == null ? (fallback ?? "—") : String(value),
    value => value == null ? "—" : String(value),
    value => value == null ? "—" : String(value),
    value => value,
    error => String(error?.message || error)
  );
  await refreshMetrics();
  assert.match(metricsNode.textContent, /Known cost estimates: 2/);
  assert.match(metricsNode.textContent, /Unknown cost estimates: 1/);
  assert.match(metricsNode.textContent, /Recorded cost subtotal: 0.03/);
});


test("workspace navigation shows one page at a time and maps nested links to their workspace", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const css = await readFile(new URL("styles.css", webRoot), "utf8");
  const navLinks = [...html.matchAll(/<a\b[^>]*data-nav="([^"]+)"[^>]*>/g)];
  const pageIds = [...html.matchAll(/<section id="([^"]+)" class="page-section[^"]*">/g)].map(match => match[1]);
  assert.ok(pageIds.length >= 7, "all product workspaces should remain present");
  assert.equal(navLinks.filter(match => /aria-current="page"/.test(match[0])).length, 1);
  assert.match(html, /data-nav="decision-lab"[^>]*aria-current="page"/);
  assert.match(script, /function setActiveNavigation\(sectionId\)/);
  assert.match(script, /function syncWorkspaceFromHash\(\)/);
  assert.match(script, /window\.addEventListener\("hashchange", syncWorkspaceFromHash\)/);
  assert.match(css, /\.page-section\[hidden\]\s*\{\s*display:\s*none\s*!important;/);

  const helperStart = script.indexOf("function setActiveNavigation(sectionId) {");
  const helperEnd = script.indexOf("\n}", helperStart) + 2;
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = script.slice(helperStart, helperEnd);
  const navStates = new Map();
  const pageStates = new Map(pageIds.map(id => [id, {
    id,
    hidden: id !== "decision-lab",
    classList: { contains(name) { return name === "page-section"; } }
  }]));
  const breadcrumbs = {};
  const links = navLinks.map(match => ({
    dataset: { nav: match[1] },
    textContent: match[1],
    attributes: new Map(),
    classList: { toggle(name, enabled) { if (name === "active") navStates.set(match[1], enabled); } },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); }
  }));
  const documentMock = {
    getElementById(id) {
      if (pageStates.has(id)) return pageStates.get(id);
      if (id === "policy-simulator") {
        return {
          classList: { contains() { return false; } },
          closest(selector) { return selector === ".page-section" ? pageStates.get("policy-workbench") : null; }
        };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".content > .page-section") return [...pageStates.values()];
      if (selector === "[data-nav]") return links;
      return [];
    }
  };
  const runtime = new Function("document", "setText", helper + "; return setActiveNavigation;")(
    documentMock,
    (id, value) => { breadcrumbs[id] = value; }
  );

  runtime("policy-simulator");
  assert.deepEqual([...pageStates.values()].filter(page => !page.hidden).map(page => page.id), ["policy-workbench"]);
  assert.equal(navStates.get("policy-workbench"), true);
  assert.equal(links.find(link => link.dataset.nav === "policy-workbench").attributes.get("aria-current"), "page");
  assert.equal(breadcrumbs.breadcrumbCurrent, "policy-workbench");

  runtime("hybrid-planner");
  assert.deepEqual([...pageStates.values()].filter(page => !page.hidden).map(page => page.id), ["hybrid-planner"]);
  assert.equal(navStates.get("hybrid-planner"), true);
  assert.equal(links.find(link => link.dataset.nav === "hybrid-planner").attributes.get("aria-current"), "page");
  assert.equal(links.filter(link => link.attributes.has("aria-current")).length, 1);
  assert.equal(breadcrumbs.breadcrumbCurrent, "hybrid-planner");

  runtime("system-settings");
  assert.deepEqual([...pageStates.values()].filter(page => !page.hidden).map(page => page.id), ["system-settings"]);
  assert.equal(links.find(link => link.dataset.nav === "hybrid-planner").attributes.has("aria-current"), false);
  assert.equal(links.find(link => link.dataset.nav === "system-settings").attributes.get("aria-current"), "page");
  assert.equal(breadcrumbs.breadcrumbCurrent, "system-settings");
});


test("dashboard text and status colors meet WCAG AA contrast targets", async () => {
  const css = await readFile(new URL("styles.css", webRoot), "utf8");
  const rootBlocks = [...css.matchAll(/:root\s*\{([\s\S]*?)\}/g)];
  assert.ok(rootBlocks.length > 0, "design tokens should be defined in :root blocks");
  const tokens = Object.fromEntries(
    rootBlocks.flatMap(root => [...root[1].matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)])
      .map(match => [match[1], match[2]])
  );
  const luminance = hex => {
    const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map(channel => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground, background) => {
    const first = luminance(foreground);
    const second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const pairs = [
    ["--muted", "--page"],
    ["--muted", "--surface"],
    ["--muted-light", "--page"],
    ["--muted-light", "--surface"],
    ["--teal", "--teal-soft"],
    ["--green", "--green-soft"],
    ["--amber", "--amber-soft"],
    ["--red", "--red-soft"],
    ["--blue", "--blue-soft"]
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(tokens[foreground] && tokens[background], "missing contrast token: " + foreground + " / " + background);
    const ratio = contrast(tokens[foreground], tokens[background]);
    assert.ok(
      ratio >= 4.5,
      foreground + " on " + background + " has " + ratio.toFixed(2) + ":1 contrast"
    );
  }
  assert.match(css, /:focus-visible[\s\S]*?outline:\s*3px solid var\(--blue\)/);
});


test("all dashboard form controls have programmatic labels", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/gi)];
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)];
  assert.ok(controls.length > 0, "dashboard form controls should exist");

  for (const control of controls) {
    const id = control[2];
    const nested = labels.some(label => label[2].includes(control[0]));
    assert.ok(nested, "form control #" + id + " must be nested in or explicitly associated with a label");
  }
});


test("provider reliability panel renders breaker state safely and summarizes recovery policy", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  for (const id of [
    "circuitBreakerState", "openCircuitCount", "halfOpenCircuitCount",
    "closedCircuitCount", "circuitBreakerPolicy", "circuitBreakersBody"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), "missing circuit-breaker panel field: " + id);
  }
  assert.match(html, /aria-label="Provider circuit-breaker status"/);
  assert.match(script, /renderCircuitBreakers\(data\.circuitBreakers, counts\)/);
  assert.match(script, /renderCircuitBreakers\(null, \{\}\)/);

  const start = script.indexOf("function formatCircuitTimestamp(value)");
  const end = script.indexOf("\nasync function refreshStatus()", start);
  assert.ok(start >= 0 && end > start, "circuit-breaker rendering helpers should exist");
  const rendererSource = script.slice(start, end);
  const badge = { textContent: "", className: "" };
  const body = { innerHTML: "" };
  const textValues = {};
  const runtime = new Function(
    "document", "setText", "escapeHtml",
    rendererSource + "; return renderCircuitBreakers;"
  );
  const render = runtime(
    {
      querySelector(selector) {
        if (selector === "#circuitBreakerState") return badge;
        if (selector === "#circuitBreakersBody") return body;
        return null;
      }
    },
    (id, value) => { textValues[id] = String(value); },
    value => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;")
  );

  render({
    policy: { failureThreshold: 3, failureWindowMs: 30_000, cooldownMs: 15_000, probeLeaseMs: 60_000 },
    targets: [
      { targetId: "provider-a", state: "open", failureCount: 3, openedAt: 1794850000000, retryAt: 1794850015000, probeInFlight: false },
      { targetId: '<img src=x onerror="alert(1)">', state: "closed", failureCount: 0, openedAt: null, retryAt: null, probeInFlight: false }
    ]
  }, { openCircuitTargets: 1, halfOpenCircuitTargets: 0, closedCircuitTargets: 1 });

  assert.equal(badge.textContent, "Open circuit");
  assert.equal(badge.className, "state-badge bad");
  assert.equal(textValues.openCircuitCount, "1");
  assert.equal(textValues.closedCircuitCount, "1");
  assert.match(textValues.circuitBreakerPolicy, /3 failures/);
  assert.match(textValues.circuitBreakerPolicy, /Cooldown 15 s/);
  assert.match(body.innerHTML, /provider-a/);
  assert.match(body.innerHTML, /Retry after/);
  assert.match(body.innerHTML, /3 \/ 3/);
  assert.match(body.innerHTML, /&lt;img/);
  assert.doesNotMatch(body.innerHTML, /<img/);

  render(null, {});
  assert.equal(badge.textContent, "Unavailable");
  assert.match(body.innerHTML, /Circuit-breaker status is unavailable/);
});


test("provider reliability trends render safe aggregates, buckets, providers and event history", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  for (const id of [
    "reliabilityWindow", "reliabilityStatus", "reliabilitySummary",
    "reliabilityTimeline", "reliabilityProviderBody", "reliabilityEventsBody",
    "sloStateBadge", "sloPolicyText", "sloAvailability", "sloBudgetConsumed",
    "sloBudgetRemaining", "sloBurnRate", "sloSamples", "sloDataQuality", "sloAlertsBody"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), "missing reliability field: " + id);
  }
  assert.match(script, /portalFetch\("\/v1\/reliability\?windowMs=/);
  const start = script.indexOf("function renderReliability(data) {");
  const end = script.indexOf("\nasync function refreshReliability()", start);
  assert.ok(start >= 0 && end > start, "reliability renderer should exist");
  const rendererSource = script.slice(start, end);
  const nodes = {
    "#reliabilitySummary": { innerHTML: "" },
    "#reliabilityTimeline": { innerHTML: "" },
    "#reliabilityProviderBody": { innerHTML: "" },
    "#reliabilityEventsBody": { innerHTML: "" },
    "#sloStateBadge": { textContent: "", className: "" },
    "#sloAlertsBody": { innerHTML: "" }
  };
  const textValues = {};
  const runtime = new Function(
    "document", "setText", "escapeHtml", "formatPercent",
    "formatCircuitTimestamp", "formatCircuitDuration",
    rendererSource + "; return renderReliability;"
  );
  const render = runtime(
    { querySelector: selector => nodes[selector] || null },
    (id, value) => { textValues[id] = String(value); },
    value => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;"),
    value => Math.round(value * 100) + "%",
    value => value == null ? "—" : new Date(value).toISOString(),
    value => value == null ? null : Math.round(value) + " ms"
  );

  render({
    available: true,
    summary: {
      attempts: 4, successes: 3, failures: 1, failureRate: 0.25,
      recoveryAttempts: 1, circuitOpenings: 1, recoveries: 1
    },
    timeline: [{ bucketStart: 1_795_000_000_000, successes: 3, failures: 1, recoveryAttempts: 1 }],
    providers: [{
      targetId: '<img src=x onerror="alert(1)">',
      attempts: 4, successes: 3, failures: 1, failureRate: 0.25,
      recoveries: 1, averageRecoveryDurationMs: 500
    }],
    recentEvents: [{
      timestamp: 1_795_000_000_000,
      targetId: '<img src=x onerror="alert(1)">',
      type: "provider_failure",
      source: "manual_probe",
      transition: "opened"
    }],
    slo: {
      policy: {
        availabilityTarget: 0.99,
        minimumSamples: 20,
        warningBurnRate: 2,
        criticalBurnRate: 5
      },
      overall: {
        status: "warning", attempts: 100, successes: 98, failures: 2,
        availability: 0.98, errorBudgetBurnRate: 2,
        errorBudgetConsumedPercent: 200, errorBudgetRemainingPercent: 0,
        sampleThreshold: 20
      },
      dataQuality: { complete: true, truncated: false, historyWriteFailures: 0 },
      providers: [{
        targetId: '<img src=x onerror="alert(1)">',
        status: "critical", attempts: 100, errorBudgetBurnRate: 8
      }],
      alerts: [
        { severity: "warning", scope: "overall", message: "Overall burn exceeded", errorBudgetBurnRate: 2, attempts: 100 },
        { severity: "critical", scope: "provider", targetId: '<img src=x onerror="alert(1)">', message: "Provider <img> burn exceeded", errorBudgetBurnRate: 8, attempts: 100 }
      ],
      alertCount: 2
    }
  });

  assert.match(nodes["#reliabilitySummary"].innerHTML, /Provider attempts/);
  assert.match(nodes["#reliabilitySummary"].innerHTML, /25%/);
  assert.match(nodes["#reliabilityTimeline"].innerHTML, /reliability-bar-failure/);
  assert.match(nodes["#reliabilityProviderBody"].innerHTML, /500 ms/);
  assert.match(nodes["#reliabilityProviderBody"].innerHTML, /&lt;img/);
  assert.doesNotMatch(nodes["#reliabilityProviderBody"].innerHTML, /<img/);
  assert.match(nodes["#reliabilityEventsBody"].innerHTML, /Provider failure/);
  assert.match(nodes["#reliabilityEventsBody"].innerHTML, /Manual probe/);
  assert.match(nodes["#reliabilityEventsBody"].innerHTML, /opened/);
  assert.match(nodes["#reliabilityEventsBody"].innerHTML, /&lt;img/);
  assert.equal(nodes["#sloStateBadge"].textContent, "Warning");
  assert.equal(nodes["#sloStateBadge"].className, "state-badge warn");
  assert.equal(textValues.sloAvailability, "98%");
  assert.equal(textValues.sloBudgetConsumed, "200%");
  assert.equal(textValues.sloBudgetRemaining, "0%");
  assert.equal(textValues.sloBurnRate, "2×");
  assert.equal(textValues.sloSamples, "100 / 20");
  assert.match(nodes["#reliabilityProviderBody"].innerHTML, /Critical/);
  assert.match(nodes["#reliabilityProviderBody"].innerHTML, /8×/);
  assert.match(nodes["#sloAlertsBody"].innerHTML, /Overall burn exceeded/);
  assert.match(nodes["#sloAlertsBody"].innerHTML, /Critical/);
  assert.match(nodes["#sloAlertsBody"].innerHTML, /&lt;img/);
  assert.doesNotMatch(nodes["#sloAlertsBody"].innerHTML, /<img/);

  render(null);
  assert.match(nodes["#reliabilityEventsBody"].innerHTML, /unavailable/);
  assert.equal(nodes["#sloStateBadge"].textContent, "Unavailable");
  assert.match(nodes["#sloAlertsBody"].innerHTML, /unavailable/);
});


test("first-run access and Free preview notices are actionable and data-safe", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const css = await readFile(new URL("styles.css", webRoot), "utf8");

  assert.match(html, /id="apiAccessNotice"[^>]*role="status"/);
  assert.match(html, /id="apiAccessNoticeAction"/);
  assert.match(html, /href="#system-settings"/);
  assert.match(html, /id="freePreviewNotice"[^>]*role="note"/);
  assert.match(html, /id="apiKey"/);
  assert.match(script, /response\.status === 401\) setApiAccessNotice\("missing"\)/);
  assert.match(script, /response\.status === 403\) setApiAccessNotice\("scope"\)/);
  assert.match(script, /response\.ok && path === "\/v1\/status"\) setApiAccessNotice\("clear"\)/);
  assert.match(script, /data\?\.deploymentProfile === "free-preview"/);
  assert.match(script, /caps\.persistentTelemetry/);
  assert.match(script, /Process-local state may reset/);
  assert.doesNotMatch(script, /localStorage\.(?:setItem|getItem)\(/);
  assert.match(css, /\.notice-card\.notice-preview/);
});

test("dashboard access onboarding never embeds or persists the deployment API key", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /Copy LOCD_API_KEY from Render/);
  assert.match(script, /let activeApiKey = ""/);
  assert.match(script, /activeApiKey = nextApiKey/);
  assert.doesNotMatch(html + script, /LOCD_API_KEY\s*[:=]\s*["'][^"']+/);
});


test("Decision Studio is the primary entry point and reliability is grouped under observability", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const decisionStart = html.indexOf('<section id="decision-lab"');
  const overviewStart = html.indexOf('<section id="overview"');
  const telemetryStart = html.indexOf('<section id="telemetry"');
  const systemStart = html.indexOf('<section id="system-settings"');
  assert.ok(decisionStart >= 0 && decisionStart < overviewStart, "Decision Studio should be the first workspace");
  assert.match(html, /data-nav="decision-lab"[^>]*aria-current="page"/);
  assert.match(html, /<h1>Decision Studio<\/h1>/);
  assert.match(html, /id="decide"/);
  assert.match(html, /id="output"/);
  assert.match(html, /id="targetCount"/);
  assert.ok(telemetryStart >= 0 && systemStart > telemetryStart);
  const overview = html.slice(overviewStart, html.indexOf('<section id="target-registry"', overviewStart));
  const observability = html.slice(telemetryStart, systemStart);
  assert.doesNotMatch(overview, /Circuit-breaker posture|Reliability trends &(?:amp;)? event history/);
  assert.match(observability, /Circuit-breaker posture/);
  assert.match(observability, /Reliability trends &(?:amp;)? event history/);
});


test("API Lab exposes only safe allowlisted operations and a read-only policy simulation", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");

  for (const id of [
    "api-lab", "apiLabEndpoint", "apiLabMethod", "apiLabPath",
    "apiLabScope", "apiLabBody", "apiLabRun", "apiLabResponse",
    "apiLabRequestPreview", "apiLabHttpStatus", "apiLabDuration",
    "apiLabRequestId", "apiLabAccessHint"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), "missing API Lab control: " + id);
  }

  assert.match(html, /API Lab/);
  assert.match(script, /const API_LAB_ENDPOINTS = Object\.freeze\(/);
  for (const endpoint of [
    'path: "/health"',
    'path: "/ready"',
    'path: "/v1/status"',
    'path: "/v1/targets"',
    'path: "/v1/policies"',
    'path: "/v1/policies/simulate"'
  ]) {
    assert.ok(script.includes(endpoint), "missing allowlisted endpoint: " + endpoint);
  }
  assert.match(script, /\.\.\.apiHeaders\(\)/);
  assert.match(script, /"x-request-id": requestId/);
  assert.ok(script.includes('authorization: "[redacted — key remains in page memory]"'));
  assert.match(script, /mutatedState/);
  assert.match(script, /executedProvider/);
  assert.doesNotMatch(script, /fetch\(document\.querySelector\("#apiLabPath"\)/);
});


test("decision activity explorer provides tenant-history filters and metadata-only export", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  for (const id of [
    "activitySearch", "activityOutcomeFilter", "activityRouteFilter",
    "activityWindowFilter", "activityClearFilters", "activityExportCsv",
    "activitySummary", "activityMatchedCount", "activitySuccessCount",
    "activityFailureCount", "activityPendingCount"
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), "missing decision explorer control: " + id);
  }
  assert.match(script, /decisionActivityLimit = 100/);
  assert.match(script, /\/v1\/decisions\?limit=" \+ decisionActivityLimit/);
  assert.match(script, /function filteredDecisionRows\(\)/);
  assert.match(script, /function csvDecisionCell\(value\)/);
  assert.match(script, /\^\[\\s\]\*\[=\+\\-@\]/);
  assert.match(html, /Export filtered CSV/);
  assert.doesNotMatch(script, /localStorage\.(?:setItem|removeItem)\(/);
});


test("all LOCD workspaces use one consistent page hierarchy and grouped navigation", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const groups = ["Plan &amp; decide", "Control &amp; govern", "Observe", "Developer tools", "Administration"];
  for (const group of groups) assert.ok(html.includes(group), "missing navigation group: " + group);
  for (const id of [
    "decision-lab", "overview", "target-registry", "policy-workbench",
    "hybrid-planner", "telemetry", "system-settings", "api-lab"
  ]) {
    const start = html.indexOf('<section id="' + id + '"');
    const next = html.indexOf('<section id="', start + 1);
    assert.ok(start >= 0, "missing workspace: " + id);
    const page = html.slice(start, next < 0 ? html.length : next);
    assert.match(page, /class="page-heading/, id + " must use the shared page heading");
    assert.match(page, /<h1>/, id + " must expose a single top-level page title");
  }
});


test("API Lab response inspector exposes response, headers, code and safe request tabs", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const css = await readFile(new URL("styles.css", webRoot), "utf8");
  for (const tab of ["Response", "Headers", "Code", "Request"]) {
    assert.match(html, new RegExp('id="apiLab' + tab + 'Tab"'));
    assert.match(html, new RegExp('aria-labelledby="apiLab' + tab + 'Tab"'));
  }
  for (const id of ["apiLabResponsePane", "apiLabHeadersPane", "apiLabCodePane", "apiLabRequestPane", "apiLabHeaders", "apiLabCode", "apiLabCopyCode"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(script, /function apiLabSetInspectorTab\(name\)/);
  assert.match(script, /function apiLabRenderCode\(\)/);
  assert.match(script, /response\.headers\.forEach/);
  assert.match(script, /<YOUR_LOCD_API_KEY>/);
  assert.match(css, /\.api-lab-inspector/);
  assert.match(css, /\.api-lab-tab\.active/);
});

test("API Lab inspector formats response headers and supports accessible keyboard tab movement", async () => {
  const html = await readFile(new URL("index.html", webRoot), "utf8");
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  for (const tab of ["Response", "Headers", "Code", "Request"]) {
    assert.match(html, new RegExp('id="apiLab' + tab + 'Tab"'));
  }
  assert.match(script, /\.join\("\\n"\)/);
  assert.doesNotMatch(script, /\.join\("\\\\n"\)/);
  assert.match(script, /event\.key === "ArrowRight"/);
  assert.match(script, /event\.key === "ArrowLeft"/);
  assert.match(script, /event\.key === "Home"/);
  assert.match(script, /event\.key === "End"/);
  assert.match(script, /button\.tabIndex = active \? 0 : -1/);
});


test("LOCD public site and console share one legible typography system", async () => {
  const css = await readFile(new URL("styles.css", webRoot), "utf8");
  assert.match(css, /--font-sans:\s*"Segoe UI Variable", Inter/);
  assert.match(css, /html, body, button, input, select, textarea\s*\{[^}]*font-family:\s*var\(--font-sans\)/s);
  assert.match(css, /\.locd-marketing, \.app-shell\s*\{\s*font-family:\s*var\(--font-sans\)/);
  assert.match(css, /\.lm-hero h1\s*\{[^}]*font-weight:\s*700/s);
  assert.match(css, /\.app-shell h1\s*\{[^}]*font-weight:\s*700/s);
  assert.match(css, /\.lm-product-visual :where\([^}]*font-size:\s*9px/s);
  assert.match(css, /\.app-shell \.data-table\s*\{\s*font-size:\s*12px/);
});
