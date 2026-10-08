function apiHeaders() {
  const apiKey = document.querySelector("#apiKey")?.value.trim();
  return apiKey ? { authorization: "Bearer " + apiKey } : {};
}

const output = document.querySelector("#output");
let registeredTargets = [];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatNumber(value, fallback = "—") {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : fallback;
}

function setStatus(message) {
  document.querySelector("#systemStatus").textContent = message;
}

function render(result) {
  const rejected = result.rejected?.map(item =>
    "<li><strong>" + escapeHtml(item.targetId || "unknown") + ":</strong> " +
    escapeHtml((item.reasons || []).join(", ")) + "</li>"
  ).join("") || "";

  const alternatives = result.alternatives?.map(item =>
    '<span class="pill">' +
      escapeHtml(item.targetId) + " · " +
      escapeHtml(item.route) + " · " +
      escapeHtml(item.score) +
    "</span>"
  ).join("") || "None";

  const reasons = result.reasons?.map(reason =>
    '<span class="pill">' + escapeHtml(reason) + "</span>"
  ).join("") || "No positive reasons returned.";

  output.innerHTML = `
    <div class="route">${escapeHtml(result.route)}</div>
    <div class="score">Target: <strong>${escapeHtml(result.targetId || "none")}</strong> · Confidence: ${escapeHtml(result.confidence)}</div>
    <p>${result.estimated
      ? "Estimated latency: " + escapeHtml(result.estimated.latencyMs) +
        " ms · Estimated cost: $" + escapeHtml(result.estimated.costUsd)
      : "No eligible execution target."}</p>
    <h3>Why</h3>
    <div>${reasons}</div>
    <h3>Alternatives</h3>
    <div>${alternatives}</div>
    <h3>Rejected candidates</h3>
    <ul>${rejected || "<li>None</li>"}</ul>
    <details>
      <summary>Raw decision JSON</summary>
      <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    </details>
  `;
}

function renderTargets(targets) {
  const root = document.querySelector("#targets");
  document.querySelector("#targetCount").textContent = String(targets.length);

  if (!targets.length) {
    root.innerHTML = '<div class="muted">No targets are registered for this control-plane tenant.</div>';
    return;
  }

  root.innerHTML = targets.map(target => {
    const health = Number(target.health ?? 0);
    const availability = target.available === false ? "offline" : "available";
    const actionButtons = `
      <div class="actions" style="margin-top:10px">
        <button class="secondary" data-action="probe" data-id="${escapeHtml(target.id)}">Probe</button>
        <button class="danger" data-action="delete" data-id="${escapeHtml(target.id)}">Remove</button>
      </div>
    `;

    return `
      <article class="target">
        <div class="target-head">
          <strong>${escapeHtml(target.id)}</strong>
          <span class="pill">${escapeHtml(availability)}</span>
        </div>
        <div class="target-meta">
          mode: ${escapeHtml(target.mode)} · health: ${escapeHtml(health.toFixed(2))}
          · capacity: ${escapeHtml(Number(target.capacity ?? 1).toFixed(2))}
          · privacy: ${escapeHtml(Number(target.privacy ?? 0).toFixed(2))}
          <br>
          latency: ${escapeHtml(formatNumber(target.estimatedLatencyMs))} ms
          · cost: $${escapeHtml(target.estimatedCostUsd ?? "—")}
          · regions: ${escapeHtml((target.regions || []).join(", ") || "—")}
          <br>
          capabilities: ${escapeHtml((target.capabilities || []).join(", ") || "—")}
        </div>
        ${actionButtons}
      </article>
    `;
  }).join("");

  root.querySelectorAll("button[data-action]").forEach(button => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      const action = button.dataset.action;
      button.disabled = true;
      try {
        if (action === "delete") {
          const response = await fetch("/v1/targets/" + encodeURIComponent(id), {
            method: "DELETE",
            headers: apiHeaders()
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "Target removal failed");
        } else {
          const response = await fetch(
            "/v1/targets/" + encodeURIComponent(id) + "/probe",
            {
              method: "POST",
              headers: { "content-type": "application/json", ...apiHeaders() },
              body: "{}"
            }
          );
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "Probe failed");
        }
        await refreshAll();
      } catch (error) {
        document.querySelector("#targetStatus").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function refreshTargets() {
  const status = document.querySelector("#targetStatus");
  status.textContent = "Loading…";

  try {
    const response = await fetch("/v1/targets", {
      cache: "no-store",
      headers: apiHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Target registry unavailable");

    registeredTargets = Array.isArray(data.targets) ? data.targets : [];
    renderTargets(registeredTargets);
    status.textContent = registeredTargets.length + " target" + (registeredTargets.length === 1 ? "" : "s") + " loaded";
  } catch (error) {
    registeredTargets = [];
    renderTargets([]);
    status.textContent = error.message;
  }
}

async function refreshPolicies() {
  const selectors = [
    document.querySelector("#policyProfile"),
    document.querySelector("#simulationCurrentPolicy"),
    document.querySelector("#simulationCandidatePolicy")
  ].filter(Boolean);
  const previous = selectors.map(select => select.value);

  try {
    const response = await fetch("/v1/policies", {
      cache: "no-store",
      headers: apiHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Policy catalog unavailable");

    const profiles = Array.isArray(data.policies) && data.policies.length
      ? data.policies
      : [{ id: "balanced", name: "Balanced" }];
    const options = profiles.map(profile =>
      '<option value="' + escapeHtml(profile.id) + '">' +
      escapeHtml(profile.name || profile.id) +
      "</option>"
    ).join("");

    selectors.forEach((select, index) => {
      select.innerHTML = options;
      if (profiles.some(profile => profile.id === previous[index])) {
        select.value = previous[index];
      }
    });
  } catch {
    selectors.forEach(select => {
      select.innerHTML = '<option value="balanced">Balanced</option>';
    });
  }
}


function formatDelta(value, unit = "", digits = 3) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const sign = number > 0 ? "+" : "";
  return sign + number.toFixed(digits) + unit;
}

function renderSimulation(result) {
  const root = document.querySelector("#simulationOutput");
  const impact = result.impact || {};
  const current = result.current || {};
  const candidate = result.candidate || {};
  const reasonDiff = impact.reasons || { added: [], removed: [] };
  const policyDiff = impact.policyRules || { added: [], removed: [] };
  const rejectedDiff = impact.rejectedReasons || { added: [], removed: [] };

  const pills = values => values?.length
    ? values.map(value => '<span class="pill">' + escapeHtml(value) + "</span>").join("")
    : '<span class="status">None</span>';

  root.innerHTML = `
    <div class="toolbar">
      <div>
        <div class="eyebrow">Recommendation</div>
        <h3 style="margin:4px 0 0">${escapeHtml(
          result.recommendation === "review_change"
            ? "Review before rollout"
            : "No routing change detected"
        )}</h3>
      </div>
      <span class="pill">${escapeHtml(
        result.mutatedState === false && result.executedProvider === false
          ? "read-only"
          : "unexpected side effect"
      )}</span>
    </div>

    <div class="diff-grid">
      <div class="metric">
        <span class="status">Route</span>
        <strong>${escapeHtml(current.route || "none")} → ${escapeHtml(candidate.route || "none")}</strong>
      </div>
      <div class="metric">
        <span class="status">Target</span>
        <strong>${escapeHtml(current.targetId || "none")} → ${escapeHtml(candidate.targetId || "none")}</strong>
      </div>
      <div class="metric">
        <span class="status">Score delta</span>
        <strong>${escapeHtml(formatDelta(impact.scoreDelta))}</strong>
      </div>
      <div class="metric">
        <span class="status">Latency delta</span>
        <strong>${escapeHtml(formatDelta(impact.latencyDeltaMs, " ms"))}</strong>
      </div>
    </div>

    <div class="change-grid">
      <div class="change">
        <strong>Confidence</strong>
        <div class="status">${escapeHtml(formatDelta(impact.confidenceDelta))}</div>
      </div>
      <div class="change">
        <strong>Estimated cost</strong>
        <div class="status">${escapeHtml(formatDelta(impact.costDeltaUsd, " USD"))}</div>
      </div>
    </div>

    <div class="change">
      <strong>Reason changes</strong>
      <div class="status" style="margin-top:6px">Added</div>
      <div>${pills(reasonDiff.added)}</div>
      <div class="status" style="margin-top:8px">Removed</div>
      <div>${pills(reasonDiff.removed)}</div>
    </div>

    <div class="change">
      <strong>Policy-rule changes</strong>
      <div class="status" style="margin-top:6px">Added</div>
      <div>${pills(policyDiff.added)}</div>
      <div class="status" style="margin-top:8px">Removed</div>
      <div>${pills(policyDiff.removed)}</div>
    </div>

    <div class="change">
      <strong>Rejected-reason changes</strong>
      <div class="status" style="margin-top:6px">Added</div>
      <div>${pills(rejectedDiff.added)}</div>
      <div class="status" style="margin-top:8px">Removed</div>
      <div>${pills(rejectedDiff.removed)}</div>
    </div>

    <details style="margin-top:14px">
      <summary>Raw simulation JSON</summary>
      <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    </details>
  `;
}

async function refreshMetrics() {
  const metrics = document.querySelector("#metrics");
  try {
    const response = await fetch("/v1/metrics", {
      cache: "no-store",
      headers: apiHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Telemetry unavailable");

    document.querySelector("#decisionCount").textContent = String(data.totalDecisions ?? 0);
    document.querySelector("#successRate").textContent =
      data.successRate == null ? "—" : (Number(data.successRate) * 100).toFixed(1) + "%";

    const routes = Object.entries(data.routes || {})
      .map(([route, count]) => route + ": " + count)
      .join(" · ");

    metrics.textContent =
      "Avg latency: " + (data.averageEstimatedLatencyMs ?? "—") + " ms" +
      " · Estimated cost: $" + data.estimatedCostUsd +
      " · Confidence: " + data.averageConfidence +
      " · " + (routes || "no routes yet");
  } catch (error) {
    document.querySelector("#decisionCount").textContent = "—";
    document.querySelector("#successRate").textContent = "—";
    metrics.textContent = error.message;
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/v1/status", {
      cache: "no-store",
      headers: apiHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Status unavailable");

    const caps = data.capabilities || {};
    setStatus(
      "Connected · telemetry: " + (caps.telemetryBackend || "process-local") +
      " · coordination: " + (caps.coordinationBackend || "process-local") +
      " · calibration: " + (caps.calibrationEnabled ? "on" : "off")
    );
  } catch (error) {
    setStatus(error.message);
  }
}

async function refreshAll() {
  await Promise.all([
    refreshTargets(),
    refreshPolicies(),
    refreshMetrics(),
    refreshStatus()
  ]);
}

document.querySelector("#decide").addEventListener("click", async () => {
  output.textContent = "Evaluating registered targets…";

  try {
    const body = {
      workload: {
        type: document.querySelector("#workloadType").value.trim(),
        sensitivity: document.querySelector("#sensitivity").value,
        requiredCapabilities: ["text-generation"]
      },
      constraints: {
        latencyBudgetMs: Number(document.querySelector("#latency").value),
        maxCostUsd: Number(document.querySelector("#cost").value),
        strictLatency: true,
        strictCost: true
      },
      policy: {
        profile: document.querySelector("#policyProfile").value
      }
    };

    const privacyOverride = document.querySelector("#privacyMode").value;
    if (privacyOverride) body.policy.sensitiveDataMode = privacyOverride;

    const response = await fetch("/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json", ...apiHeaders() },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Decision failed");

    render(result);
    await refreshMetrics();
  } catch (error) {
    output.textContent = error.message;
  }
});

document.querySelector("#registerTarget").addEventListener("click", async () => {
  const status = document.querySelector("#targetStatus");
  const payload = {
    id: document.querySelector("#targetId").value.trim(),
    mode: document.querySelector("#targetMode").value,
    health: Number(document.querySelector("#targetHealth").value),
    capacity: Number(document.querySelector("#targetCapacity").value),
    privacy: Number(document.querySelector("#targetPrivacy").value),
    estimatedLatencyMs: Number(document.querySelector("#targetLatency").value),
    estimatedCostUsd: Number(document.querySelector("#targetCost").value),
    regions: document.querySelector("#targetRegions").value
      .split(",").map(item => item.trim()).filter(Boolean),
    capabilities: document.querySelector("#targetCapabilities").value
      .split(",").map(item => item.trim()).filter(Boolean)
  };

  try {
    if (!payload.id) throw new Error("Target ID is required");
    const response = await fetch("/v1/targets", {
      method: "POST",
      headers: { "content-type": "application/json", ...apiHeaders() },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Target registration failed");

    status.textContent = "Registered " + result.id;
    document.querySelector("#targetId").value = "";
    await refreshAll();
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#apiKey").addEventListener("change", refreshAll);
document.querySelector("#refreshAll").addEventListener("click", refreshAll);

refreshAll();


document.querySelector("#simulatePolicy").addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.querySelector("#simulationStatus");
  const simulationOutput = document.querySelector("#simulationOutput");
  button.disabled = true;
  status.textContent = "Running deterministic comparison…";
  simulationOutput.textContent = "Comparing current and candidate policies…";

  try {
    const privacyOverride = document.querySelector("#privacyMode").value;
    const basePolicy = {
      profile: document.querySelector("#simulationCurrentPolicy").value
    };
    const candidatePolicy = {
      profile: document.querySelector("#simulationCandidatePolicy").value
    };

    if (privacyOverride) {
      candidatePolicy.sensitiveDataMode = privacyOverride;
    }

    const body = {
      workload: {
        type: document.querySelector("#workloadType").value.trim(),
        sensitivity: document.querySelector("#sensitivity").value,
        requiredCapabilities: ["text-generation"]
      },
      constraints: {
        latencyBudgetMs: Number(document.querySelector("#latency").value),
        maxCostUsd: Number(document.querySelector("#cost").value),
        strictLatency: true,
        strictCost: true
      },
      currentPolicy: basePolicy,
      candidatePolicy
    };

    if (!body.workload.type) throw new Error("Workload type is required");

    const idempotencyKey = globalThis.crypto?.randomUUID?.()
      || "simulation-" + Date.now() + "-" + Math.random().toString(16).slice(2);

    const response = await fetch("/v1/policies/simulate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        ...apiHeaders()
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Policy simulation failed");

    renderSimulation(result);
    status.textContent = "Comparison complete · read-only";
  } catch (error) {
    status.textContent = "Simulation failed";
    simulationOutput.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
