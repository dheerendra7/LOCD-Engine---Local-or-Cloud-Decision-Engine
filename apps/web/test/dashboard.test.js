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


test("dashboard labels cost as a known subtotal when estimates are missing", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /estimatedCostUnknownCount/);
  assert.match(script, /known subtotal;/);
});


test("dashboard does not show zero cost when every estimate is unknown", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /estimatedCostKnownCount/);
  assert.match(script, /unknown \(0 known;/);
  assert.match(script, /known subtotal;/);
});
