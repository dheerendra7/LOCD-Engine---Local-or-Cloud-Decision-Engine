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

async function withTimeout(task, timeoutMs, parentSignal = null) {
  if (parentSignal != null && (
    typeof parentSignal.aborted !== "boolean" ||
    typeof parentSignal.addEventListener !== "function"
  )) {
    throw new Error("signal must be an AbortSignal");
  }
  if (parentSignal?.aborted) throw new Error("execution_aborted");

  const controller = new AbortController();
  let timer = null;
  let parentAbortListener = null;

  const races = [
    Promise.resolve()
      .then(() => task(controller.signal))
      .then(
        value => ({ type: "completed", value }),
        error => ({ type: "error", error })
      )
  ];

  if (parentSignal) {
    races.push(new Promise(resolve => {
      parentAbortListener = () => {
        controller.abort(parentSignal.reason);
        resolve({ type: "aborted" });
      };
      parentSignal.addEventListener("abort", parentAbortListener, { once: true });
      if (parentSignal.aborted) parentAbortListener();
    }));
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    races.push(new Promise(resolve => {
      timer = setTimeout(() => {
        // Resolve timeout before abort callbacks can reject the adapter promise.
        resolve({ type: "timeout" });
        controller.abort(new Error("execution_timeout"));
      }, timeoutMs);
    }));
  }

  try {
    const outcome = await Promise.race(races);
    if (outcome.type === "timeout") throw new Error("execution_timeout");
    if (outcome.type === "aborted") throw new Error("execution_aborted");
    if (outcome.type === "error") throw outcome.error;
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal && parentAbortListener) {
      parentSignal.removeEventListener("abort", parentAbortListener);
    }
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

export function createTenantExecutionRegistry({ defaultTenantId = "default" } = {}) {
  const tenantPattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
  const normalizeTenant = value => {
    const tenantId = String(value ?? defaultTenantId).trim().toLowerCase();
    if (!tenantPattern.test(tenantId)) {
      throw new Error("tenantId must match " + tenantPattern);
    }
    return tenantId;
  };

  const registries = new Map();
  const getRegistry = tenantId => {
    const normalized = normalizeTenant(tenantId);
    let registry = registries.get(normalized);
    if (!registry) {
      registry = createExecutionRegistry();
      registries.set(normalized, registry);
    }
    return registry;
  };

  function forTenant(tenantId = defaultTenantId) {
    const normalizedTenantId = normalizeTenant(tenantId);
    const registry = getRegistry(normalizedTenantId);
    return Object.freeze({
      tenantId: normalizedTenantId,
      register(value) { return registry.register(value); },
      get(targetId) { return registry.get(targetId); },
      has(targetId) { return registry.has(targetId); },
      list() { return registry.list(); },
      clear() { return registry.clear(); }
    });
  }

  const defaultRegistry = forTenant(defaultTenantId);
  return Object.freeze({
    forTenant,
    register(value) { return defaultRegistry.register(value); },
    get(targetId) { return defaultRegistry.get(targetId); },
    has(targetId) { return defaultRegistry.has(targetId); },
    list() { return defaultRegistry.list(); },
    clear() {
      for (const registry of registries.values()) registry.clear();
    },
    listTenantIds() {
      return [...registries.keys()].sort();
    }
  });
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
    includeOutputs = false,
    clock,
    beforeStep = null,
    onStepResult = null,
    signal = null
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

  if (beforeStep !== null && typeof beforeStep !== "function") {
    throw new Error("beforeStep must be a function");
  }
  if (onStepResult !== null && typeof onStepResult !== "function") {
    throw new Error("onStepResult must be a function");
  }
  if (signal != null && (
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  )) {
    throw new Error("signal must be an AbortSignal");
  }

  const notifyStepResult = async payload => {
    if (typeof onStepResult !== "function") return;
    try {
      await onStepResult(payload);
    } catch {
      // Breaker/observability callbacks must not rewrite provider receipts.
    }
  };

  const receipts = [];
  const results = [];
  let status = "completed";
  let failedStepId = null;

  for (const step of plan.steps) {
    const adapter = registry.get(step.targetId);
    const startedAt = nowIso(clock);

    if (signal?.aborted) {
      const errorClass = "execution_aborted";
      await notifyStepResult({
        step: { ...step },
        adapter,
        status: "failed",
        errorClass,
        cancelled: true,
        executionContext: null
      });
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
      break;
    }

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

    let executionContext = null;
    if (typeof beforeStep === "function") {
      try {
        const admission = await beforeStep({
          step: { ...step },
          adapter,
          mode,
          signal
        });
        if (admission?.allowed === false) {
          receipts.push(normalizeReceipt({
            step,
            adapter,
            status: "failed",
            startedAt,
            completedAt: nowIso(clock),
            errorClass: admission.errorClass || "execution_admission_rejected"
          }));
          status = "failed";
          failedStepId = step.id;
          if (failFast) break;
          continue;
        }
        executionContext = admission?.context ?? admission ?? null;
        if (signal?.aborted) {
          const errorClass = "execution_aborted";
          await notifyStepResult({
            step: { ...step },
            adapter,
            status: "failed",
            errorClass,
            cancelled: true,
            executionContext
          });
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
          break;
        }
      } catch {
        receipts.push(normalizeReceipt({
          step,
          adapter,
          status: "failed",
          startedAt,
          completedAt: nowIso(clock),
          errorClass: "execution_admission_failed"
        }));
        status = "failed";
        failedStepId = step.id;
        if (failFast) break;
        continue;
      }
    }

    try {
      const output = await withTimeout(
        adapterSignal => adapter.execute({
          step: { ...step },
          payload: step.payload,
          mode,
          signal: adapterSignal
        }),
        timeoutMs,
        signal
      );

      await notifyStepResult({
        step: { ...step },
        adapter,
        status: "completed",
        executionContext
      });

      if (includeOutputs) {
        results.push({
          stepId: step.id,
          targetId: step.targetId,
          result: output
        });
      }

      receipts.push(normalizeReceipt({
        step,
        adapter,
        status: "completed",
        startedAt,
        completedAt: nowIso(clock)
      }));
    } catch (error) {
      const errorClass = error instanceof Error ? error.message : "execution_failed";
      const cancelled = errorClass === "execution_aborted";
      await notifyStepResult({
        step: { ...step },
        adapter,
        status: "failed",
        errorClass,
        cancelled,
        executionContext
      });
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
    results,
    completedSteps: receipts.filter(item => item.status === "completed").length,
    totalSteps: plan.steps.length
  };
}
