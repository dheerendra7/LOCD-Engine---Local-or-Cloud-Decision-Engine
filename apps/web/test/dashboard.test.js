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
  const server = await readFile(new URL("../../api/src/server.js", webRoot), "utf8");
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
