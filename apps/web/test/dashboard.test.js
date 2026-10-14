test("policy history requests ignore older responses after selection changes", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  assert.match(script, /let policyHistoryRequestRevision = 0/);

  const start = script.indexOf("async function showPolicyHistory(policyId)");
  const end = script.indexOf('\\ndocument.querySelector("#policyCards")?.addEventListener', start);
  assert.ok(start >= 0 && end > start, "policy history request handler should exist");
  const history = script.slice(start, end);
  assert.match(history, /const historyRevision = \\+\\+policyHistoryRequestRevision/);
  assert.match(history, /if \\(accessRevision !== apiAccessRevision \\|\\| historyRevision !== policyHistoryRequestRevision\\) return/g);
  assert.match(history, /catch \\(error\\) \\{[\\s\\S]*?historyRevision !== policyHistoryRequestRevision/);

  const resetStart = script.indexOf("function resetTenantScopedView()");
  const resetEnd = script.indexOf("\\n}", resetStart);
  assert.match(script.slice(resetStart, resetEnd), /policyHistoryRequestRevision \\+= 1/);
  const closeStart = script.indexOf('document.querySelector("#closePolicyHistory")?.addEventListener("click", () => {');
  const closeEnd = script.indexOf("\\n});", closeStart);
  assert.match(script.slice(closeStart, closeEnd), /policyHistoryRequestRevision \\+= 1/);
});

