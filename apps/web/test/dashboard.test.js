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
