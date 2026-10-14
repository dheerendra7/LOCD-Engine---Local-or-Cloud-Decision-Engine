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

document.querySelector("#decide").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  output.textContent = "Evaluating registered targets…";

  try {
    const workloadType = document.querySelector("#workloadType").value.trim();
    const latencyRaw = document.querySelector("#latency").value.trim();
    const costRaw = document.querySelector("#cost").value.trim();
    if (!workloadType) throw new Error("Workload type is required.");
    if (latencyRaw === "" || !Number.isFinite(Number(latencyRaw)) || Number(latencyRaw) < 0) {
      throw new Error("Latency budget must be a finite number of zero or greater.");
    }
    if (costRaw === "" || !Number.isFinite(Number(costRaw)) || Number(costRaw) < 0) {
      throw new Error("Maximum cost must be a finite number of zero or greater.");
    }

    const body = {
      workload: {
        type: workloadType,
        sensitivity: document.querySelector("#sensitivity").value,
        requiredCapabilities: ["text-generation"]
      },
      constraints: {
        latencyBudgetMs: Number(latencyRaw),
        maxCostUsd: Number(costRaw),
        strictLatency: true,
        strictCost: true
      },
      policy: {
        profile: document.querySelector("#policyProfile").value
      }
    };

    const privacyOverride = document.querySelector("#privacyMode").value;
    if (privacyOverride) body.policy.sensitiveDataMode = privacyOverride;

    const result = await portalFetch("/v1/decide", portalJsonOptions(body));
    render(result);
    await Promise.all([refreshMetrics(), refreshActivity()]);
  } catch (error) {
    output.textContent = niceError(error);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#registerTarget").addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.querySelector("#targetStatus");
  const readNumber = (id, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) => {
    const raw = document.querySelector("#" + id).value.trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || value < min || value > max) {
      const bounds = Number.isFinite(max)
        ? "between " + min + " and " + max
        : "greater than or equal to " + min;
      throw new Error(label + " must be a finite number " + bounds + ".");
    }
    return value;
  };

  let payload;
  try {
    payload = {
      id: document.querySelector("#targetId").value.trim(),
      mode: document.querySelector("#targetMode").value,
      health: readNumber("targetHealth", "Health score", { min: 0, max: 1 }),
      capacity: readNumber("targetCapacity", "Capacity score", { min: 0, max: 1 }),
      privacy: readNumber("targetPrivacy", "Privacy score", { min: 0, max: 1 }),
      estimatedLatencyMs: readNumber("targetLatency", "Estimated latency"),
      estimatedCostUsd: readNumber("targetCost", "Estimated cost"),
      regions: document.querySelector("#targetRegions").value.split(",").map(item => item.trim()).filter(Boolean),
      capabilities: document.querySelector("#targetCapabilities").value.split(",").map(item => item.trim()).filter(Boolean)
    };
    if (!payload.id) throw new Error("Target ID is required.");
  } catch (error) {
    if (status) status.textContent = niceError(error);
    toast(niceError(error), true);
    return;
  }

  button.disabled = true;
  if (status) status.textContent = "Registering target…";
  try {
    const result = await portalFetch("/v1/targets", portalJsonOptions(payload));
    if (status) status.textContent = "Registered " + (result.id || payload.id);
    document.querySelector("#targetId").value = "";
    toast("Target registered.");
    await refreshAll();
  } catch (error) {
    if (status) status.textContent = niceError(error);
    toast(niceError(error), true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#apiKey").addEventListener("change", refreshAll);
document.querySelector("#refreshAll").addEventListener("click", refreshAll);



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
      basePolicy.sensitiveDataMode = privacyOverride;
      candidatePolicy.sensitiveDataMode = privacyOverride;
    }

    const body = {
      workload: {
        type: document.querySelector("#workloadType").value.trim(),
        sensitivity: document.querySelector("#sensitivity").value,
        requiredCapabilities: ["text-generation"]
      },
      constraints: {
        latencyBudgetMs: readNonNegativeInput("latency", "Latency budget"),
        maxCostUsd: readNonNegativeInput("cost", "Maximum cost"),
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



// Enhanced light-console behaviour. All displayed operational data is read from the LOCD API.
let lastHybridPlan = null;
let hybridInputRevision = 0;
let hybridStepSequence = 0;
let activeHistoryPolicy = null;

function portalIdempotencyKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "locd-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

async function portalFetch(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    ...apiHeaders()
  };
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const descriptions = {
      401: "Authentication required. Add a scoped LOCD API key in System & access.",
      403: "This API key does not have permission for this operation.",
      404: "The requested resource was not found.",
      409: "The request conflicts with an operation already in progress.",
      429: "Rate limit reached. Retry after the server's suggested wait.",
      503: "The service or one of its required dependencies is unavailable."
    };
    throw new Error(payload.error || descriptions[response.status] || ("Request failed (" + response.status + ")"));
  }
  return payload;
}

function portalJsonOptions(body, extraHeaders = {}) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": portalIdempotencyKey(),
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function parseNonNegativeNumber(rawValue, label) {
  const raw = String(rawValue ?? "").trim();
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value) || value < 0) {
    throw new Error(label + " must be a finite number of zero or greater.");
  }
  return value;
}

function readNonNegativeInput(id, label) {
  return parseNonNegativeNumber(document.querySelector("#" + id)?.value, label);
}

function niceError(error) {
  const message = error instanceof Error ? error.message : String(error || "Unexpected error");
  const friendly = {
    unauthorized: "Authentication required. Add a scoped LOCD API key in System & access.",
    insufficient_scope: "The current key does not have the required scope.",
    no_registered_targets: "No targets are registered for this tenant yet.",
    target_not_found: "That target no longer exists in the registry.",
    target_does_not_support_probe: "This target does not provide a probe operation.",
    policy_not_found: "The requested policy was not found.",
    policy_version_not_found: "That policy version is no longer available.",
    unsupported_media_type: "The API rejected this request's content type."
  };
  return friendly[message] || message.replaceAll("_", " ");
}

function toast(message, isError = false) {
  const region = document.querySelector("#toastRegion");
  if (!region) return;
  const item = document.createElement("div");
  item.className = "toast" + (isError ? " error" : "");
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 4600);
}

function setStatus(message, state) {
  const status = document.querySelector("#systemStatus");
  if (status) status.textContent = message;
  const pill = document.querySelector("#connectionPill");
  const label = document.querySelector("#connectionText");
  if (label) label.textContent = state === "connected" ? "API connected" : state === "checking" ? "Checking API" : "API issue";
  if (pill) {
    pill.dataset.state = state || (String(message).startsWith("Connected") ? "connected" : "error");
    pill.title = message;
  }
}

function formatNumber(value, fallback = "—") {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return fallback;
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCost(value, digits = 6) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return "$" + Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function formatPercent(value, digits = 1) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return (Number(value) * 100).toFixed(digits) + "%";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function stateBadge(label, state = "") {
  return '<span class="state-badge ' + escapeHtml(state) + '">' + escapeHtml(label) + "</span>";
}

function emptyState(title, description) {
  return '<div class="empty-state"><strong>' + escapeHtml(title) + "</strong>" +
    escapeHtml(description || "") + "</div>";
}

function setText(id, value) {
  const element = document.querySelector("#" + id);
  if (element) element.textContent = value == null ? "—" : String(value);
}

function invalidateHybridPlan() {
  hybridInputRevision += 1;
  const hadValidatedPlan = lastHybridPlan !== null;
  lastHybridPlan = null;
  const executeButton = document.querySelector("#executeDryRun");
  if (executeButton) executeButton.disabled = true;
  if (hadValidatedPlan) {
    setText("hybridStatus", "Plan inputs or targets changed. Revalidate before dry-run.");
    setText("executionOutput", "The previously validated plan is stale. Validate the current inputs before dry-run.");
  }
}

function setOptions(select, options, previousValue) {
  if (!select) return;
  select.innerHTML = options.map(item =>
    '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + "</option>"
  ).join("");
  if (options.some(item => item.value === previousValue)) select.value = previousValue;
}

function routeLabel(value) {
  const route = String(value || "unknown");
  return route.replaceAll("-", " ").replaceAll("_", " ");
}

function render(result) {
  const target = result.targetId || "No eligible target";
  const reasons = (result.reasons || []).map(reason =>
    '<span class="pill">' + escapeHtml(reason) + "</span>"
  ).join("") || '<span class="status">The engine returned no positive reason details.</span>';
  const alternatives = (result.alternatives || []).map(item =>
    '<span class="pill">' + escapeHtml(item.targetId) + " · " +
    escapeHtml(routeLabel(item.route)) + " · score " + escapeHtml(formatNumber(item.score)) + "</span>"
  ).join("") || '<span class="status">No eligible alternatives returned.</span>';
  const rejected = (result.rejected || []).map(item =>
    "<tr><td><strong>" + escapeHtml(item.targetId || "Unknown target") + "</strong></td><td>" +
    escapeHtml((item.reasons || []).join(", ") || "Not provided") + "</td></tr>"
  ).join("");
  output.innerHTML =
    '<div class="toolbar"><span class="state-badge ' + (result.targetId ? "good" : "warn") + '">' +
    (result.targetId ? "Recommendation available" : "No eligible destination") + "</span><span class=\"status\">" +
    escapeHtml(result.decisionVersion || "Decision") + "</span></div>" +
    '<div class="route">' + escapeHtml(routeLabel(result.route)) + "</div>" +
    '<div class="score">Selected target: <strong>' + escapeHtml(target) + "</strong> · Confidence " +
    escapeHtml(formatPercent(result.confidence)) + "</div>" +
    '<div class="diff-grid">' +
      '<div class="metric"><span class="status">Estimated latency</span><strong>' +
      escapeHtml(result.estimated ? formatNumber(result.estimated.latencyMs) + " ms" : "—") + "</strong></div>" +
      '<div class="metric"><span class="status">Estimated cost</span><strong>' +
      escapeHtml(result.estimated ? formatCost(result.estimated.costUsd) : "—") + "</strong></div>" +
      '<div class="metric"><span class="status">Decision ID</span><strong>' +
      escapeHtml(result.decisionId || "Not returned") + "</strong></div>" +
      '<div class="metric"><span class="status">Calibration</span><strong>' +
      escapeHtml(result.calibration?.enabled ? "Enabled" : "Not enabled") + "</strong></div>" +
    "</div>" +
    '<div class="output-block"><h3>Why this route</h3><div class="output-pills">' + reasons + "</div></div>" +
    '<div class="output-block"><h3>Eligible alternatives</h3><div class="output-pills">' + alternatives + "</div></div>" +
    '<div class="output-block"><h3>Rejected candidates</h3>' +
      (rejected
        ? '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Target</th><th>Constraint / reason</th></tr></thead><tbody>' + rejected + "</tbody></table></div>"
        : '<div class="status">No rejected candidates were returned.</div>') +
    "</div>" +
    '<details><summary>View raw decision JSON</summary><pre>' +
    escapeHtml(JSON.stringify(result, null, 2)) + "</pre></details>";
}

function targetState(target) {
  if (target.available === true) return { label: "Available", style: "good" };
  if (target.available === false) return { label: "Unavailable", style: "bad" };
  return { label: "Registered", style: "" };
}

function targetIcon(mode) {
  const icons = {
    local: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    private: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M6 18h12a4 4 0 0 0 .7-7.9A6.5 6.5 0 0 0 6.2 8.6 4.8 4.8 0 0 0 6 18Z"/></svg>',
    hybrid: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 7h5a4.5 4.5 0 0 1 4.5 4.5V14.5"/></svg>'
  };
  return icons[mode] || icons.local;
}

function renderTargets(targets) {
  const root = document.querySelector("#targets");
  if (!root) return;
  setText("targetCount", targets.length);
  if (!targets.length) {
    root.innerHTML = emptyState("No targets registered", "Add a local, private, cloud or hybrid destination when its metadata is ready.");
    syncHybridTargets();
    return;
  }
  root.innerHTML = targets.map(target => {
    const state = targetState(target);
    const regions = Array.isArray(target.regions) ? target.regions.join(", ") : "";
    const capabilities = Array.isArray(target.capabilities) ? target.capabilities.join(", ") : "";
    const health = target.health == null ? "—" : formatNumber(target.health, "—");
    const capacity = target.capacity == null ? "—" : formatPercent(target.capacity);
    const privacy = target.privacy == null ? "—" : formatPercent(target.privacy);
    return '<article class="target">' +
      '<div class="target-head"><div class="target-title"><span class="target-symbol">' + targetIcon(target.mode) +
        '</span><div><div class="target-name">' + escapeHtml(target.id) + '</div><div class="target-subtitle">' +
        escapeHtml(routeLabel(target.mode)) + " destination</div></div></div>" +
        stateBadge(state.label, state.style) + "</div>" +
      '<div class="target-meta">' +
        '<div class="target-metric"><span>Health</span><strong>' + escapeHtml(health) + "</strong></div>" +
        '<div class="target-metric"><span>Capacity score</span><strong>' + escapeHtml(capacity) + "</strong></div>" +
        '<div class="target-metric"><span>Privacy score</span><strong>' + escapeHtml(privacy) + "</strong></div>" +
        '<div class="target-metric"><span>Est. latency</span><strong>' + escapeHtml(target.estimatedLatencyMs == null ? "Unknown" : formatNumber(target.estimatedLatencyMs) + " ms") + "</strong></div>" +
        '<div class="target-metric"><span>Est. cost</span><strong>' + escapeHtml(formatCost(target.estimatedCostUsd)) + "</strong></div>" +
        '<div class="target-metric"><span>Heartbeat</span><strong>' + escapeHtml(formatDate(target.lastHeartbeatAt || target.heartbeatAt)) + "</strong></div>" +
      "</div>" +
      '<div class="target-info">Regions: ' + escapeHtml(regions || "Not specified") +
        "<br>Capabilities: " + escapeHtml(capabilities || "Not specified") + "</div>" +
      '<div class="target-actions"><button class="btn btn-secondary btn-small" type="button" data-action="probe" data-id="' + escapeHtml(target.id) + '">Probe target</button>' +
      '<button class="btn btn-danger btn-small" type="button" data-action="delete" data-id="' + escapeHtml(target.id) + '">Remove</button></div>' +
    "</article>";
  }).join("");

  root.querySelectorAll("button[data-action]").forEach(button => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      const action = button.dataset.action;
      button.disabled = true;
      try {
        if (action === "delete") {
          if (!confirm("Remove target '" + id + "' from this tenant's registry?")) return;
          await portalFetch("/v1/targets/" + encodeURIComponent(id), { method: "DELETE" });
          toast("Target removed from the registry.");
        } else {
          await portalFetch("/v1/targets/" + encodeURIComponent(id) + "/probe",
            portalJsonOptions({}));
          toast("Probe request completed.");
        }
        await refreshAll();
      } catch (error) {
        toast(niceError(error), true);
        setText("targetStatus", niceError(error));
      } finally {
        button.disabled = false;
      }
    });
  });
  syncHybridTargets();
}

function syncHybridTargets() {
  const rows = document.querySelector("#hybridStepRows");
  if (!rows) return;
  rows.querySelectorAll("[data-step-target]").forEach(select => {
    const previous = select.value;
    const options = registeredTargets.map(target => ({
      value: String(target.id),
      label: String(target.id) + " · " + routeLabel(target.mode)
    }));
    setOptions(select, options, previous);
  });
}

function addHybridStep(values = {}) {
  const root = document.querySelector("#hybridStepRows");
  if (!root) return;
  invalidateHybridPlan();
  if (!root.querySelector("[data-step-id]")) root.innerHTML = "";
  hybridStepSequence += 1;
  const row = document.createElement("div");
  row.className = "hybrid-step";
  row.innerHTML =
    '<label><span>Stage ID</span><input data-step-id required value="' + escapeHtml(values.id || ("stage-" + hybridStepSequence)) + '" placeholder="preprocess"></label>' +
    '<label><span>Purpose</span><input data-step-purpose value="' + escapeHtml(values.purpose || "") + '" placeholder="Redact data"></label>' +
    '<label><span>Target</span><select data-step-target required></select></label>' +
    '<label><span>Sensitivity</span><select data-step-sensitivity><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>' +
    '<button class="btn btn-secondary remove-step" type="button" aria-label="Remove stage">×</button>';
  row.querySelector("[data-step-sensitivity]").value = values.dataSensitivity || document.querySelector("#hybridSensitivity")?.value || "medium";
  row.querySelector(".remove-step").addEventListener("click", () => {
    invalidateHybridPlan();
    row.remove();
    if (!root.querySelector("[data-step-id]")) root.innerHTML = emptyState("No stages configured", "Add at least two stages to create a hybrid plan.");
    const execute = document.querySelector("#executeDryRun");
    if (execute) execute.disabled = !lastHybridPlan;
  });
  root.append(row);
  syncHybridTargets();
}

function renderPolicyCards(policies) {
  const root = document.querySelector("#policyCards");
  if (!root) return;
  if (!policies.length) {
    root.innerHTML = emptyState("Policy catalog unavailable", "Check API access, then refresh to load policy profiles.");
    return;
  }
  const keys = ["privacy", "latency", "cost", "capacity", "reliability"];
  root.innerHTML = policies.map(policy => {
    const builtIn = policy.source === "built-in";
    const weights = policy.weights || {};
    const weightRows = keys.map(key => {
      const value = Number(weights[key]);
      return '<div class="weight-line"><span>' + escapeHtml(key) + '</span><div class="weight-track"><div class="weight-fill" style="width:' +
        (Number.isFinite(value) ? Math.max(0, Math.min(100, value * 100)) : 0) + '%"></div></div><strong>' +
        escapeHtml(Number.isFinite(value) ? value.toFixed(2) : "—") + "</strong></div>";
    }).join("");
    return '<article class="policy-card">' +
      '<div class="policy-card-header"><div><h3>' + escapeHtml(policy.name || policy.id) + '</h3><div class="status" style="margin-top:3px">' +
        escapeHtml(policy.id) + '</div></div>' + stateBadge(builtIn ? "Built-in" : "Custom", builtIn ? "blue" : "good") + "</div>" +
      '<p>' + escapeHtml(policy.description || "No description provided.") + "</p>" +
      '<div class="policy-meta">' + stateBadge("Base: " + (policy.baseProfile || policy.id)) +
      stateBadge(builtIn ? "Read-only" : "v" + (policy.version ?? 1)) + "</div>" +
      '<div class="mini-weights">' + weightRows + "</div>" +
      '<div class="policy-actions"><button class="btn btn-secondary btn-small" data-policy-action="use" data-id="' + escapeHtml(policy.id) + '" type="button">Use in lab</button>' +
      (!builtIn ? '<button class="btn btn-secondary btn-small" data-policy-action="history" data-id="' + escapeHtml(policy.id) + '" type="button">History</button>' +
        '<button class="btn btn-danger btn-small" data-policy-action="delete" data-id="' + escapeHtml(policy.id) + '" type="button">Delete</button>' : "") +
      "</div></article>";
  }).join("");
}

function setPolicySelectors(policies) {
  const selectors = [
    ["policyProfile", "balanced"],
    ["simulationCurrentPolicy", "balanced"],
    ["simulationCandidatePolicy", "balanced"],
    ["hybridPolicyProfile", "balanced"]
  ];
  const options = policies.map(policy => ({ value: String(policy.id), label: String(policy.name || policy.id) }));
  selectors.forEach(([id, fallback]) => {
    const element = document.querySelector("#" + id);
    const previous = element?.value || fallback;
    setOptions(element, options, previous);
  });
}

async function refreshTargets() {
  const status = document.querySelector("#targetStatus");
  if (status) status.textContent = "Loading registry…";
  try {
    const data = await portalFetch("/v1/targets");
    const nextTargets = Array.isArray(data.targets) ? data.targets : [];
    const targetRegistryChanged = JSON.stringify(registeredTargets) !== JSON.stringify(nextTargets);
    registeredTargets = nextTargets;
    if (targetRegistryChanged) invalidateHybridPlan();
    renderTargets(registeredTargets);
    if (status) status.textContent = registeredTargets.length + " target" + (registeredTargets.length === 1 ? "" : "s") + " loaded";
  } catch (error) {
    if (registeredTargets.length) invalidateHybridPlan();
    registeredTargets = [];
    renderTargets([]);
    if (status) status.textContent = niceError(error);
  }
}

async function refreshPolicies() {
  const status = document.querySelector("#policyManagerStatus");
  try {
    const data = await portalFetch("/v1/policies");
    const policies = Array.isArray(data.policies) ? data.policies : [];
    setPolicySelectors(policies);
    renderPolicyCards(policies);
    if (status) status.textContent = policies.length + " profiles available";
    const formBase = document.querySelector("#newPolicyBase");
    if (formBase) setOptions(formBase, policies.filter(item => item.source === "built-in").map(item => ({
      value: item.id, label: item.name || item.id
    })), formBase.value || "balanced");
  } catch (error) {
    if (status) status.textContent = niceError(error);
    renderPolicyCards([]);
    const readable = niceError(error);
    ["policyProfile", "simulationCurrentPolicy", "simulationCandidatePolicy", "hybridPolicyProfile"].forEach(id => {
      const element = document.querySelector("#" + id);
      if (element) element.innerHTML = '<option value="balanced">Balanced</option>';
    });
  }
}

async function refreshMetrics() {
  const metrics = document.querySelector("#metrics");
  try {
    const data = await portalFetch("/v1/metrics");
    setText("decisionCount", formatNumber(data.totalDecisions, "0"));
    setText("successRate", formatPercent(data.successRate));
    setText("avgLatency", data.averageEstimatedLatencyMs == null ? "—" : formatNumber(data.averageEstimatedLatencyMs) + " ms");
    const routes = Object.entries(data.routes || {}).map(([route, count]) => routeLabel(route) + ": " + count).join(" · ");
    if (metrics) metrics.textContent =
      "Recorded cost subtotal: " + formatCost(data.estimatedCostUsd) +
      " · Mean confidence: " + formatNumber(data.averageConfidence) +
      " · Actual outcomes: " + formatNumber((data.outcomes?.success || 0) + (data.outcomes?.failure || 0), "0") +
      " · Routes: " + (routes || "none recorded");
  } catch (error) {
    setText("decisionCount", "—");
    setText("successRate", "—");
    setText("avgLatency", "—");
    if (metrics) metrics.textContent = niceError(error);
  }
}

async function refreshActivity() {
  const body = document.querySelector("#activityTableBody");
  if (!body) return;
  const status = document.querySelector("#activityStatus");
  try {
    const data = await portalFetch("/v1/decisions?limit=25");
    const rows = Array.isArray(data.decisions) ? data.decisions : [];
    if (status) status.textContent = rows.length + " recent decision record" + (rows.length === 1 ? "" : "s");
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="table-empty">No decision activity has been recorded yet. Run a workload through the Decision lab.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(item => {
      const outcome = item.outcome || "pending";
      const style = outcome === "success" ? "good" : outcome === "failure" ? "bad" : "";
      return "<tr><td>" + escapeHtml(formatDate(item.timestamp)) + "</td><td><strong>" +
        escapeHtml(item.workloadType || "Unknown") + "</strong><div class=\"status\">" + escapeHtml(item.id) + "</div></td><td>" +
        escapeHtml(routeLabel(item.route)) + "</td><td>" + escapeHtml(item.targetId || "None") + "</td><td>" +
        escapeHtml(item.estimatedLatencyMs == null ? "—" : formatNumber(item.estimatedLatencyMs) + " ms") +
        "<div class=\"status\">" + escapeHtml(formatCost(item.estimatedCostUsd)) + "</div></td><td>" +
        stateBadge(routeLabel(outcome), style) + "</td><td><button type=\"button\" class=\"btn btn-secondary btn-small\" data-select-decision=\"" +
        escapeHtml(item.id) + "\">Report outcome</button></td></tr>";
    }).join("");
    body.querySelectorAll("[data-select-decision]").forEach(button => {
      button.addEventListener("click", () => {
        const input = document.querySelector("#outcomeDecisionId");
        if (input) {
          input.value = button.dataset.selectDecision;
          input.focus();
        }
        document.querySelector("#outcomeForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  } catch (error) {
    if (status) status.textContent = niceError(error);
    body.innerHTML = '<tr><td colspan="7" class="table-empty">' + escapeHtml(niceError(error)) + "</td></tr>";
  }
}

async function refreshCalibration() {
  const cards = document.querySelector("#calibrationCards");
  const table = document.querySelector("#calibrationRows");
  if (!cards || !table) return;
  try {
    const data = await portalFetch("/v1/calibration");
    const entries = Array.isArray(data.entries) ? data.entries : [];
    setText("calibrationStatus", data.enabled ? "Calibration enabled" : "Calibration disabled");
    const minSamples = data.config?.minSamples;
    cards.innerHTML = [
      { title: "Calibration state", value: data.enabled ? "Enabled" : "Disabled", detail: "From runtime status" },
      { title: "Minimum samples", value: minSamples ?? "—", detail: "Before estimates are adjusted" },
      { title: "Observed combinations", value: entries.length, detail: "Target · workload · load band" }
    ].map(item => '<div class="calibration-card"><strong>' + escapeHtml(item.title) + '</strong><span style="font-size:20px;color:var(--ink);font-weight:760">' +
      escapeHtml(item.value) + '</span><span>' + escapeHtml(item.detail) + "</span></div>").join("");
    if (!entries.length) {
      table.innerHTML = '<tr><td colspan="6" class="table-empty">No calibration observations yet. Submit actual outcomes after decisions.</td></tr>';
      return;
    }
    table.innerHTML = entries.map(item => "<tr><td><strong>" + escapeHtml(item.targetId) + "</strong></td><td>" +
      escapeHtml(item.workloadType) + "</td><td>" + escapeHtml(item.utilizationBand) + "</td><td>" +
      escapeHtml(item.samples) + "</td><td>" + escapeHtml(formatNumber(item.latencyFactor)) + "</td><td>" +
      escapeHtml(formatNumber(item.costFactor)) + "</td></tr>").join("");
  } catch (error) {
    setText("calibrationStatus", niceError(error));
    cards.innerHTML = emptyState("Calibration unavailable", niceError(error));
    table.innerHTML = '<tr><td colspan="6" class="table-empty">' + escapeHtml(niceError(error)) + "</td></tr>";
  }
}

async function refreshHealth() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "API health check failed");
    setText("healthState", data.status === "ok" ? "API responding" : data.status);
    setText("runtimeVersion", data.version || "Not reported");
    setText("environmentLabel", data.status === "ok" ? "API responding" : "Check required");
    const dot = document.querySelector("#environmentDot");
    if (dot) dot.style.background = data.status === "ok" ? "#20a56d" : "#d34a56";
    const state = document.querySelector("#healthState");
    if (state) state.className = "state-badge " + (data.status === "ok" ? "good" : "bad");
  } catch (error) {
    setText("healthState", "Unavailable");
    setText("runtimeVersion", "—");
    setText("environmentLabel", "API unavailable");
    const dot = document.querySelector("#environmentDot");
    if (dot) dot.style.background = "#d34a56";
  }
}

async function refreshReadiness() {
  try {
    const response = await fetch("/ready", { cache: "no-store" });
    const data = await response.json();
    const value = data.status || (response.ok ? "ready" : "not ready");
    setText("readinessState", value);
    const element = document.querySelector("#readinessState");
    if (element) element.style.color = response.ok ? "var(--green)" : "var(--red)";
    const checks = data.checks;
    if (checks && typeof checks === "object") {
      const entries = Array.isArray(checks) ? checks : Object.entries(checks).map(([name, item]) => ({ name, ...((item && typeof item === "object") ? item : { status: item }) }));
      if (entries.length) setText("systemStatus", "Readiness checks: " + entries.map(item => {
        if (typeof item === "string") return item;
        return [item.name || item.id, item.status || item.state || (item.ready === true ? "ready" : item.ready === false ? "not ready" : "")].filter(Boolean).join(" ");
      }).join(" · "));
    }
  } catch {
    setText("readinessState", "Unavailable");
    const element = document.querySelector("#readinessState");
    if (element) element.style.color = "var(--red)";
  }
}

function renderCapabilities(caps) {
  const root = document.querySelector("#capabilities");
  if (!root) return;
  const labels = {
    executionEnabled: "Live execution gate",
    persistentTargets: "Persistent targets",
    persistentTelemetry: "Durable telemetry",
    automaticProbing: "Automatic probing",
    calibrationEnabled: "Estimate calibration",
    sharedCoordination: "Shared coordination",
    telemetryBackend: "Telemetry backend",
    policyBackend: "Policy backend",
    coordinationBackend: "Coordination backend",
    rateLimitMode: "Rate limiting",
    idempotencyMode: "Idempotency"
  };
  root.innerHTML = Object.entries(labels).map(([key, label]) => {
    const value = caps[key];
    let shown = typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : (value == null ? "Not reported" : String(value));
    return '<div class="system-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(shown) + "</strong></div>";
  }).join("");
}

async function refreshStatus() {
  try {
    const data = await portalFetch("/v1/status");
    const caps = data.capabilities || {};
    const counts = data.counts || {};
    setStatus("Connected · " + (data.service || "locd-api") + " · " + (data.version || "version unknown"), "connected");
    setText("probeCount", (counts.probeableTargets == null ? "—" : counts.probeableTargets) + " probe-capable / " + (counts.targets == null ? "—" : counts.targets) + " registered");
    setText("telemetryBackend", caps.telemetryBackend || data.stateBackend?.kind || "Not reported");
    setText("policyBackend", caps.policyBackend || "Not reported");
    setText("executionAdapters", counts.executionAdapters == null ? "Not reported" : counts.executionAdapters);
    renderCapabilities(caps);
  } catch (error) {
    setStatus(niceError(error), "error");
    setText("probeCount", "—");
    setText("telemetryBackend", "Unavailable");
    setText("policyBackend", "Unavailable");
    setText("executionAdapters", "—");
    renderCapabilities({});
  }
}

async function refreshAll() {
  const button = document.querySelector("#refreshAll");
  if (button) button.disabled = true;
  setStatus("Refreshing current tenant data…", "checking");
  const tasks = [
    refreshTargets(), refreshPolicies(), refreshMetrics(), refreshStatus(),
    refreshActivity(), refreshCalibration(), refreshHealth(), refreshReadiness()
  ];
  await Promise.allSettled(tasks);
  if (button) button.disabled = false;
}

function renderSimulation(result) {
  const root = document.querySelector("#simulationOutput");
  if (!root) return;
  const impact = result.impact || {};
  const current = result.current || {};
  const candidate = result.candidate || {};
  const sections = [
    ["Reason changes", impact.reasons || { added: [], removed: [] }],
    ["Policy-rule changes", impact.policyRules || { added: [], removed: [] }],
    ["Rejected-candidate changes", impact.rejectedReasons || { added: [], removed: [] }]
  ];
  const pills = list => Array.isArray(list) && list.length
    ? list.map(value => '<span class="pill">' + escapeHtml(value) + "</span>").join("")
    : '<span class="status">No changes</span>';
  root.innerHTML =
    '<div class="toolbar"><div><div class="section-label">Recommendation</div><h3 style="margin:4px 0 0;font-size:16px">' +
    escapeHtml(result.recommendation === "review_change" ? "Review before rollout" : "No routing change detected") +
    '</h3></div>' + stateBadge(result.mutatedState === false && result.executedProvider === false ? "Verified read-only result" : "Review result metadata", result.mutatedState === false && result.executedProvider === false ? "good" : "warn") + "</div>" +
    '<div class="diff-grid">' +
      '<div class="metric"><span class="status">Route</span><strong>' + escapeHtml(current.route || "None") + " → " + escapeHtml(candidate.route || "None") + "</strong></div>" +
      '<div class="metric"><span class="status">Target</span><strong>' + escapeHtml(current.targetId || "None") + " → " + escapeHtml(candidate.targetId || "None") + "</strong></div>" +
      '<div class="metric"><span class="status">Score delta</span><strong>' + escapeHtml(formatDelta(impact.scoreDelta)) + "</strong></div>" +
      '<div class="metric"><span class="status">Latency delta</span><strong>' + escapeHtml(formatDelta(impact.latencyDeltaMs, " ms", 2)) + "</strong></div></div>" +
    '<div class="change-grid"><div class="change"><strong>Confidence delta</strong><div class="status">' + escapeHtml(formatDelta(impact.confidenceDelta, "", 3)) +
    '</div></div><div class="change"><strong>Estimated cost delta</strong><div class="status">' + escapeHtml(formatDelta(impact.costDeltaUsd, " USD", 6)) + "</div></div></div>" +
    sections.map(([title, group]) => '<div class="change"><strong>' + title + '</strong><div class="status">Added</div><div>' + pills(group.added) +
      '</div><div class="status">Removed</div><div>' + pills(group.removed) + "</div></div>").join("") +
    '<details><summary>View raw simulation JSON</summary><pre>' + escapeHtml(JSON.stringify(result, null, 2)) + "</pre></details>";
}

async function showPolicyHistory(policyId) {
  const root = document.querySelector("#policyHistory");
  const panel = document.querySelector("#policyHistoryPanel");
  activeHistoryPolicy = policyId;
  if (!root || !panel) return;
  panel.classList.remove("hidden");
  setText("policyHistoryTitle", "Version history · " + policyId);
  root.innerHTML = '<div class="status">Loading versions…</div>';
  try {
    const data = await portalFetch("/v1/policies/" + encodeURIComponent(policyId) + "/history");
    const versions = Array.isArray(data.versions) ? data.versions : [];
    root.innerHTML = versions.length ? versions.slice().reverse().map(item =>
      '<div class="history-row"><div><strong>Version ' + escapeHtml(item.version) + '</strong><span>' +
      escapeHtml(formatDate(item.updatedAt)) + " · by " + escapeHtml(item.updatedBy || "unknown") +
      '</span><span>' + escapeHtml(item.policy?.description || item.policy?.name || item.policy?.id || "") + "</span></div>" +
      '<button class="btn btn-secondary btn-small" type="button" data-rollback-policy="' + escapeHtml(policyId) +
      '" data-version="' + escapeHtml(item.version) + '">Restore as new version</button></div>'
    ).join("") : emptyState("No version history found", "This custom policy has no versions available to restore.");
  } catch (error) {
    root.innerHTML = emptyState("Version history unavailable", niceError(error));
  }
}

document.querySelector("#policyCards")?.addEventListener("click", async event => {
  const button = event.target.closest("button[data-policy-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.policyAction;
  if (action === "use") {
    ["policyProfile", "simulationCurrentPolicy", "simulationCandidatePolicy", "hybridPolicyProfile"].forEach(key => {
      const select = document.querySelector("#" + key);
      if (select && [...select.options].some(option => option.value === id)) select.value = id;
    });
    const policyId = document.querySelector("#newPolicyId");
    if (policyId && !["balanced", "localFirst", "privacyFirst", "latencyFirst", "costFirst", "strictLocalSensitive"].includes(id)) policyId.value = id;
    toast("Selected " + id + " in the available workbenches.");
    return;
  }
  if (action === "history") {
    await showPolicyHistory(id);
    return;
  }
  if (action === "delete") {
    if (!confirm("Delete the custom policy '" + id + "'? Its policy record will no longer be available for new decisions.")) return;
    button.disabled = true;
    try {
      await portalFetch("/v1/policies/" + encodeURIComponent(id), { method: "DELETE" });
      toast("Custom policy deleted.");
      document.querySelector("#policyHistoryPanel")?.classList.add("hidden");
      await refreshPolicies();
    } catch (error) {
      toast(niceError(error), true);
    } finally {
      button.disabled = false;
    }
  }
});

document.querySelector("#policyHistory")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-rollback-policy]");
  if (!button) return;
  const id = button.dataset.rollbackPolicy;
  const version = Number(button.dataset.version);
  if (!confirm("Restore version " + version + " of '" + id + "' as a new version?")) return;
  button.disabled = true;
  try {
    await portalFetch("/v1/policies/" + encodeURIComponent(id) + "/rollback",
      portalJsonOptions({ version }));
    toast("Policy restored as a new version.");
    await Promise.all([refreshPolicies(), showPolicyHistory(id)]);
  } catch (error) {
    toast(niceError(error), true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#policyForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.querySelector("#savePolicy");
  const status = document.querySelector("#policyFormStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = "Validating and saving…";
  try {
    let weights;
    let rules;
    try {
      weights = JSON.parse(document.querySelector("#newPolicyWeights").value || "{}");
      rules = JSON.parse(document.querySelector("#newPolicyRules").value || "[]");
    } catch {
      throw new Error("Weights must be valid JSON and rules must be a valid JSON array.");
    }
    if (!weights || typeof weights !== "object" || Array.isArray(weights)) throw new Error("Weight overrides must be a JSON object.");
    if (!Array.isArray(rules)) throw new Error("Policy rules must be a JSON array.");
    const payload = {
      id: document.querySelector("#newPolicyId").value.trim(),
      name: document.querySelector("#newPolicyName").value.trim(),
      description: document.querySelector("#newPolicyDescription").value.trim(),
      baseProfile: document.querySelector("#newPolicyBase").value,
      weights,
      rules
    };
    await portalFetch("/v1/policies", portalJsonOptions(payload));
    if (status) status.textContent = "Policy saved. Reloading catalog…";
    toast("Custom policy saved.");
    await refreshPolicies();
    if (status) status.textContent = "Saved successfully. Review its version in the policy catalog.";
  } catch (error) {
    if (status) status.textContent = niceError(error);
    toast(niceError(error), true);
  } finally {
    if (button) button.disabled = false;
  }
});

document.querySelector("#closePolicyHistory")?.addEventListener("click", () => {
  document.querySelector("#policyHistoryPanel")?.classList.add("hidden");
  activeHistoryPolicy = null;
});

document.querySelector("#outcomeForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.querySelector("#recordOutcome");
  const status = document.querySelector("#outcomeStatus");
  if (button) button.disabled = true;
  if (status) status.textContent = "Recording outcome…";
  try {
    const body = {
      decisionId: document.querySelector("#outcomeDecisionId").value.trim(),
      outcome: document.querySelector("#outcomeType").value
    };
    const latency = document.querySelector("#actualLatencyMs").value.trim();
    const cost = document.querySelector("#actualCostUsd").value.trim();
    if (latency !== "") body.actualLatencyMs = Number(latency);
    if (cost !== "") body.actualCostUsd = Number(cost);
    if (!body.decisionId) throw new Error("Select a decision before submitting an outcome.");
    if (latency !== "" && (!Number.isFinite(body.actualLatencyMs) || body.actualLatencyMs < 0)) throw new Error("Actual latency must be zero or greater.");
    if (cost !== "" && (!Number.isFinite(body.actualCostUsd) || body.actualCostUsd < 0)) throw new Error("Actual cost must be zero or greater.");
    await portalFetch("/v1/outcomes", portalJsonOptions(body));
    if (status) status.textContent = "Outcome recorded.";
    toast("Actual outcome recorded; calibration observations refreshed.");
    await Promise.all([refreshMetrics(), refreshActivity(), refreshCalibration()]);
  } catch (error) {
    if (status) status.textContent = niceError(error);
    toast(niceError(error), true);
  } finally {
    if (button) button.disabled = false;
  }
});

function renderHybridResult(result) {
  const root = document.querySelector("#hybridOutput");
  if (!root) return;
  const rejected = (result.rejected || []).map(item => "<tr><td>" +
    escapeHtml(item.stepId || "Plan") + "</td><td>" + escapeHtml((item.reasons || []).join(", ")) + "</td></tr>").join("");
  const steps = (result.steps || []).map(step =>
    "<tr><td><strong>" + escapeHtml(step.id) + "</strong><div class=\"status\">" + escapeHtml(step.purpose || "") +
    "</div></td><td>" + escapeHtml(step.targetId) + "</td><td>" + escapeHtml(routeLabel(step.mode)) + "</td><td>" +
    escapeHtml(step.estimatedLatencyMs == null ? "Unknown" : formatNumber(step.estimatedLatencyMs) + " ms") + "</td><td>" +
    escapeHtml(formatCost(step.estimatedCostUsd)) + "</td></tr>"
  ).join("");
  root.innerHTML = '<div class="hybrid-result"><div class="hybrid-result-header">' +
    '<div><div class="section-label">Planner result</div><h3 style="font-size:18px;margin:3px 0">' +
    (result.valid ? "Plan passes validation" : "Plan requires changes") + '</h3><div class="status">' +
    escapeHtml((result.reasons || []).join(", ")) + "</div></div>" +
    stateBadge(result.valid ? "Valid · planning only" : "Rejected", result.valid ? "good" : "bad") + "</div>" +
    '<div class="diff-grid"><div class="metric"><span class="status">Aggregate latency</span><strong>' +
    escapeHtml(result.estimated?.latencyMs == null ? "—" : formatNumber(result.estimated.latencyMs) + " ms") + "</strong></div>" +
    '<div class="metric"><span class="status">Aggregate estimated cost</span><strong>' + escapeHtml(formatCost(result.estimated?.costUsd)) + "</strong></div>" +
    '<div class="metric"><span class="status">Stages returned</span><strong>' + escapeHtml((result.steps || []).length) + "</strong></div>" +
    '<div class="metric"><span class="status">Validation issues</span><strong>' + escapeHtml((result.rejected || []).length) + "</strong></div></div>" +
    (steps ? '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Stage</th><th>Target</th><th>Mode</th><th>Est. latency</th><th>Est. cost</th></tr></thead><tbody>' + steps + "</tbody></table></div>" : "") +
    (rejected ? '<div class="change"><strong>Rejection reasons</strong><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Scope</th><th>Reason</th></tr></thead><tbody>' + rejected + "</tbody></table></div></div>" : "") +
    '<details><summary>View raw plan JSON</summary><pre>' + escapeHtml(JSON.stringify(result, null, 2)) + "</pre></details></div>";
}

document.querySelector("#addHybridStep")?.addEventListener("click", () => addHybridStep());

document.querySelector("#hybridStepRows")?.addEventListener("input", invalidateHybridPlan);
document.querySelector("#hybridStepRows")?.addEventListener("change", invalidateHybridPlan);
[
  "hybridWorkloadType", "hybridSensitivity", "hybridLatency", "hybridCost", "hybridPolicyProfile"
].forEach(id => {
  const input = document.querySelector("#" + id);
  input?.addEventListener("input", invalidateHybridPlan);
  input?.addEventListener("change", invalidateHybridPlan);
});

document.querySelector("#planHybrid")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.querySelector("#hybridStatus");
  const outputRoot = document.querySelector("#hybridOutput");
  button.disabled = true;
  lastHybridPlan = null;
  const executeButton = document.querySelector("#executeDryRun");
  if (executeButton) executeButton.disabled = true;
  if (status) status.textContent = "Validating plan against registered targets…";
  if (outputRoot) outputRoot.innerHTML = '<div class="status">Running hybrid validation…</div>';
  try {
    const rows = [...document.querySelectorAll("#hybridStepRows .hybrid-step")];
    if (rows.length < 2) throw new Error("A hybrid plan needs at least two stages.");
    if (!registeredTargets.length) throw new Error("Register at least two targets before planning a hybrid route.");
    const body = {
      workload: {
        type: document.querySelector("#hybridWorkloadType").value.trim(),
        sensitivity: document.querySelector("#hybridSensitivity").value
      },
      constraints: {
        maxLatencyMs: readNonNegativeInput("hybridLatency", "Hybrid latency budget"),
        maxCostUsd: readNonNegativeInput("hybridCost", "Hybrid cost budget"),
        strictLatency: true,
        strictCost: true
      },
      policy: { profile: document.querySelector("#hybridPolicyProfile").value },
      steps: rows.map(row => ({
        id: row.querySelector("[data-step-id]").value.trim(),
        purpose: row.querySelector("[data-step-purpose]").value.trim(),
        targetId: row.querySelector("[data-step-target]").value,
        dataSensitivity: row.querySelector("[data-step-sensitivity]").value
      })),
      targets: registeredTargets
    };
    if (!body.workload.type) throw new Error("Workload type is required.");
    if (!Number.isFinite(body.constraints.maxLatencyMs) || body.constraints.maxLatencyMs < 0) throw new Error("Latency budget must be zero or greater.");
    if (!Number.isFinite(body.constraints.maxCostUsd) || body.constraints.maxCostUsd < 0) throw new Error("Cost budget must be zero or greater.");
    const requestRevision = hybridInputRevision;
    const result = await portalFetch("/v1/hybrid-plan", portalJsonOptions(body));
    if (requestRevision !== hybridInputRevision) {
      lastHybridPlan = null;
      if (executeButton) executeButton.disabled = true;
      if (status) status.textContent = "Inputs or targets changed during validation. Run validation again.";
      if (outputRoot) outputRoot.innerHTML = emptyState("Validation result discarded", "The plan changed while validation was in progress. No dry-run is available until the current plan is validated.");
      return;
    }
    lastHybridPlan = result.valid ? result : null;
    renderHybridResult(result);
    if (executeButton) executeButton.disabled = !lastHybridPlan;
    if (status) status.textContent = result.valid ? "Plan validated. Dry-run is available; no providers were invoked." : "Validation rejected the current plan. Resolve the listed constraints.";
  } catch (error) {
    lastHybridPlan = null;
    const executeButton = document.querySelector("#executeDryRun");
    if (executeButton) executeButton.disabled = true;
    if (status) status.textContent = niceError(error);
    if (outputRoot) outputRoot.innerHTML = emptyState("Plan validation failed", niceError(error));
    toast(niceError(error), true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#executeDryRun")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  if (!lastHybridPlan || lastHybridPlan.valid !== true) {
    toast("Validate a plan successfully before dry-run.", true);
    return;
  }
  button.disabled = true;
  setText("executionOutput", "Submitting the validated plan in dry-run mode…");
  try {
    const result = await portalFetch("/v1/execute", portalJsonOptions({
      plan: lastHybridPlan,
      mode: "dry-run"
    }));
    const receipts = (result.receipts || []).map(item => "<tr><td>" + escapeHtml(item.stepId) + "</td><td>" +
      escapeHtml(item.targetId) + "</td><td>" + escapeHtml(item.adapterId || "No adapter") + "</td><td>" +
      stateBadge(item.status, item.status === "completed" ? "good" : "bad") + "</td><td>" +
      escapeHtml(item.errorClass || "—") + "</td></tr>").join("");
    document.querySelector("#executionOutput").innerHTML =
      '<div class="toolbar"><strong>Dry-run result</strong>' + stateBadge(result.status || "completed", result.status === "completed" ? "good" : "bad") + "</div>" +
      '<div class="status" style="margin-top:8px">' + escapeHtml(result.completedSteps) + " of " + escapeHtml(result.totalSteps) +
      " stages completed · mode " + escapeHtml(result.mode || "dry-run") + "</div>" +
      '<div class="data-table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Stage</th><th>Target</th><th>Adapter</th><th>Status</th><th>Detail</th></tr></thead><tbody>' +
      (receipts || '<tr><td colspan="5" class="table-empty">No execution receipts returned.</td></tr>') + "</tbody></table></div>" +
      '<details><summary>View dry-run response JSON</summary><pre>' + escapeHtml(JSON.stringify(result, null, 2)) + "</pre></details>";
    toast("Dry-run request completed.");
  } catch (error) {
    setText("executionOutput", niceError(error));
    toast(niceError(error), true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#applyApiKey")?.addEventListener("click", async () => {
  setText("accessStatus", document.querySelector("#apiKey").value.trim() ? "Key applied to this page's memory." : "No key entered; requests will be unauthenticated.");
  await refreshAll();
});
document.querySelector("#clearApiKey")?.addEventListener("click", async () => {
  document.querySelector("#apiKey").value = "";
  setText("accessStatus", "Key cleared from this page's memory.");
  await refreshAll();
});
document.querySelector("#apiKey")?.addEventListener("keydown", event => {
  if (event.key === "Enter") document.querySelector("#applyApiKey")?.click();
});
// Refresh listener is registered above; avoid duplicate refreshes.

document.querySelectorAll("[data-nav]").forEach(link => {
  link.addEventListener("click", () => {
    document.querySelectorAll("[data-nav]").forEach(item => item.classList.toggle("active", item === link));
    setText("breadcrumbCurrent", link.textContent.trim());
  });
});
const sectionObserver = typeof IntersectionObserver === "function"
  ? new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const id = visible.target.id;
      document.querySelectorAll("[data-nav]").forEach(link => link.classList.toggle("active", link.dataset.nav === id));
      const current = document.querySelector('[data-nav="' + id + '"]');
      if (current) setText("breadcrumbCurrent", current.textContent.trim());
    }, { rootMargin: "-15% 0px -70% 0px", threshold: [0, .1, .3, .5] })
  : null;
if (sectionObserver) document.querySelectorAll(".page-section").forEach(section => sectionObserver.observe(section));

const initialHybridRows = document.querySelector("#hybridStepRows");
if (initialHybridRows) {
  initialHybridRows.innerHTML = "";
  addHybridStep({ id: "prepare", purpose: "Pre-process", dataSensitivity: "medium" });
  addHybridStep({ id: "inference", purpose: "Model inference", dataSensitivity: "medium" });
}
refreshAll();
