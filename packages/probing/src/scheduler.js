export function createProbeScheduler({
  registry,
  intervalMs = 30_000,
  maxConcurrent = 4,
  onResult = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.probe !== "function") {
    throw new Error("probe registry is required");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    throw new Error("intervalMs must be >= 100");
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  if (typeof onResult !== "function") throw new Error("onResult must be a function");

  let timer = null;
  let running = false;
  const inFlight = new Set();

  async function probeTarget(target) {
    const id = String(target.id);
    if (inFlight.has(id)) {
      return {
        targetId: id,
        status: "skipped",
        reason: "probe_already_running"
      };
    }

    inFlight.add(id);
    try {
      const snapshot = await registry.probe(id);
      const result = {
        targetId: id,
        status: "success",
        snapshot
      };
      await onResult(result);
      return result;
    } catch (error) {
      const result = {
        targetId: id,
        status: "failed",
        errorClass: error instanceof Error ? error.message : "probe_failed"
      };
      await onResult(result);
      return result;
    } finally {
      inFlight.delete(id);
    }
  }

  async function runOnce() {
    const targets = typeof registry.listProbeable === "function"
      ? await registry.listProbeable()
      : await registry.list();
    const results = [];
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        results.push(await probeTarget(target));
      }
    }

    const workerCount = Math.min(maxConcurrent, targets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  return {
    async runOnce() {
      return runOnce();
    },

    start() {
      if (running) return false;
      running = true;
      timer = setIntervalImpl(() => {
        runOnce().catch(error => onResult({
          targetId: null,
          status: "failed",
          errorClass: error instanceof Error ? error.message : "scheduler_failed"
        }));
      }, intervalMs);
      timer?.unref?.();
      return true;
    },

    stop() {
      if (!running) return false;
      running = false;
      clearIntervalImpl(timer);
      timer = null;
      return true;
    },

    isRunning() {
      return running;
    },

    inFlightCount() {
      return inFlight.size;
    }
  };
}
