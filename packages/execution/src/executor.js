function ensureAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("execution adapter must be an object");
  }
  if (!adapter.id) throw new Error("execution adapter id is required");
  if (!adapter.targetId) throw new Error("execution adapter targetId is required");
  if (typeof adapter.execute !== "function") {
    throw new Error("execution adapter must implement execute()");
  }
  return adapter;
}

function nowIso(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("execution clock returned an invalid date");
  return date.toISOString();
}

function normalizeReceipt({ step, adapter, status, startedAt, completedAt, errorClass = null }) {
  return {
    stepId: step.id,
    targetId: step.targetId,
    adapterId: adapter?.id ?? null,
    status,
    startedAt,
    completedAt,
    errorClass
  };
}

async function withTimeout(task, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task();

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("execution_timeout")), timeoutMs);
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createExecutionRegistry(adapters = []) {
  const entries = new Map();

  const register = value => {
    const adapter = ensureAdapter(value);
    if (entries.has(String(adapter.targetId))) {
      throw new Error("execution adapter already registered for target: " + adapter.targetId);
    }
    entries.set(String(adapter.targetId), adapter);
    return adapter;
  };

  for (const adapter of adapters) register(adapter);

  return {
    register,

    get(targetId) {
      return entries.get(String(targetId)) ?? null;
    },

    has(targetId) {
      return entries.has(String(targetId));
    },

    list() {
      return [...entries.values()].map(adapter => ({
        id: adapter.id,
        targetId: adapter.targetId,
        capabilities: Array.isArray(adapter.capabilities) ? [...adapter.capabilities] : []
      }));
    },

    clear() {
      entries.clear();
    }
  };
}

export function createDryRunExecutionAdapter({ id, targetId } = {}) {
  return {
    id: String(id || ("dry-run:" + targetId)),
    targetId: String(targetId || ""),
    async execute() {
      return {
        status: "simulated"
      };
    }
  };
}

export async function executePlan(
  plan,
  {
    registry,
    mode = "dry-run",
    timeoutMs = 30000,
    failFast = true,
    clock
  } = {}
) {
  if (!plan || typeof plan !== "object") throw new Error("execution plan is required");
  if (plan.valid !== true) throw new Error("execution plan must be valid before execution");
  if (!Array.isArray(plan.steps) || plan.steps.length < 1) {
    throw new Error("execution plan must contain steps");
  }
  if (!registry || typeof registry.get !== "function") {
    throw new Error("execution registry is required");
  }
  if (!["dry-run", "live"].includes(mode)) {
    throw new Error("execution mode must be dry-run or live");
  }

  const receipts = [];
  let status = "completed";
  let failedStepId = null;

  for (const step of plan.steps) {
    const adapter = registry.get(step.targetId);
    const startedAt = nowIso(clock);

    if (!adapter) {
      const receipt = normalizeReceipt({
        step,
        adapter: null,
        status: "failed",
        startedAt,
        completedAt: nowIso(clock),
        errorClass: "execution_adapter_missing"
      });
      receipts.push(receipt);
      status = "failed";
      failedStepId = step.id;
      if (failFast) break;
      continue;
    }

    if (mode === "live" && adapter.dryRunOnly === true) {
      receipts.push(normalizeReceipt({
        step,
        adapter,
        status: "failed",
        startedAt,
        completedAt: nowIso(clock),
        errorClass: "execution_adapter_dry_run_only"
      }));
      status = "failed";
      failedStepId = step.id;
      if (failFast) break;
      continue;
    }

    try {
      await withTimeout(
        () => adapter.execute({
          step: { ...step },
          mode
        }),
        timeoutMs
      );

      receipts.push(normalizeReceipt({
        step,
        adapter,
        status: "completed",
        startedAt,
        completedAt: nowIso(clock)
      }));
    } catch (error) {
      const errorClass = error instanceof Error ? error.message : "execution_failed";
      receipts.push(normalizeReceipt({
        step,
        adapter,
        status: "failed",
        startedAt,
        completedAt: nowIso(clock),
        errorClass
      }));
      status = "failed";
      failedStepId = step.id;
      if (failFast) break;
    }
  }

  return {
    executionVersion: "1.0",
    mode,
    status,
    failedStepId,
    receipts,
    completedSteps: receipts.filter(item => item.status === "completed").length,
    totalSteps: plan.steps.length
  };
}
