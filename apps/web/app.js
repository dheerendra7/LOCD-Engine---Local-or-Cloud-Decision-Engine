const output = document.querySelector("#output");

const targets = [
  {
    id: "local-gpu",
    mode: "local",
    health: 0.98,
    capacity: 0.20,
    privacy: 1,
    estimatedLatencyMs: 420,
    estimatedCostUsd: 0,
    available: true,
    capabilities: ["text-generation"],
    regions: ["local"]
  },
  {
    id: "private-ap-south",
    mode: "private",
    health: 0.99,
    capacity: 0.45,
    privacy: 0.95,
    estimatedLatencyMs: 560,
    estimatedCostUsd: 0.008,
    available: true,
    capabilities: ["text-generation"],
    regions: ["ap-south-1"]
  },
  {
    id: "public-cloud",
    mode: "cloud",
    health: 0.999,
    capacity: 0.15,
    privacy: 0.20,
    estimatedLatencyMs: 240,
    estimatedCostUsd: 0.012,
    available: true,
    capabilities: ["text-generation"],
    regions: ["us-east-1"]
  }
];

function render(result) {
  const rejected = result.rejected?.map(item =>
    "<li><strong>" + item.targetId + ":</strong> " + item.reasons.join(", ") + "</li>"
  ).join("") || "";

  const alternatives = result.alternatives?.map(item =>
    '<span class="pill">' + item.targetId + " · " + item.route + " · " + item.score + "</span>"
  ).join("") || "None";

  output.innerHTML = `
    <div class="route">${result.route}</div>
    <div class="score">Target: <strong>${result.targetId || "none"}</strong> · Confidence: ${result.confidence}</div>
    <p>${result.estimated ? "Estimated latency: " + result.estimated.latencyMs + " ms · Estimated cost: $" + result.estimated.costUsd : "No eligible execution target."}</p>
    <h3>Why</h3>
    <div>${result.reasons?.map(reason => '<span class="pill">' + reason + "</span>").join("") || "No positive reasons returned."}</div>
    <h3>Alternatives</h3>
    <div>${alternatives}</div>
    <h3>Rejected candidates</h3>
    <ul>${rejected || "<li>None</li>"}</ul>
    <details>
      <summary>Raw decision JSON</summary>
      <pre>${JSON.stringify(result, null, 2)}</pre>
    </details>
  `;
}

document.querySelector("#decide").addEventListener("click", async () => {
  output.textContent = "Evaluating...";
  try {
    const response = await fetch("/v1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
          sensitiveDataMode: document.querySelector("#privacyMode").value
        },
        targets
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    render(result);
  } catch (error) {
    output.textContent = error.message;
  }
});


async function refreshMetrics() {
  const metrics = document.querySelector("#metrics");
  try {
    const response = await fetch("/v1/metrics", { cache: "no-store" });
    const data = await response.json();
    const routes = Object.entries(data.routes || {})
      .map(([route, count]) => route + ": " + count)
      .join(" · ");
    metrics.textContent =
      "Decisions: " + data.totalDecisions +
      " · Avg latency: " + (data.averageEstimatedLatencyMs ?? "—") + " ms" +
      " · Estimated cost: $" + data.estimatedCostUsd +
      " · Confidence: " + data.averageConfidence +
      " · " + (routes || "no routes yet");
  } catch {
    metrics.textContent = "Telemetry unavailable.";
  }
}

refreshMetrics();
