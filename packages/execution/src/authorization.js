import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const MAX_PLAN_TTL_MS = 15 * 60 * 1000;

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(item => canonical(item)).join(",") + "]";
  return "{" + Object.keys(value).sort()
    .filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ":" + canonical(value[key]))
    .join(",") + "}";
}

function signedPlanProjection(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const copy = structuredClone(plan);
  if (!Array.isArray(copy.steps)) return null;
  copy.steps = copy.steps.map(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    const { payload, ...signedFields } = step;
    return signedFields;
  });
  return copy;
}

function requestProjection(request) {
  if (!request || typeof request !== "object" || !Array.isArray(request.steps)) {
    throw new Error("execution plan request must contain steps");
  }
  return {
    workload: structuredClone(request.workload ?? {}),
    constraints: structuredClone(request.constraints ?? {}),
    policy: structuredClone(request.policy ?? {}),
    steps: request.steps.map(step => {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new Error("execution plan request steps must be objects");
      }
      const { payload, ...validatedFields } = step;
      return structuredClone(validatedFields);
    })
  };
}

function readNow(clock) {
  const value = Number(clock());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("execution plan clock must return a non-negative safe integer");
  }
  return value;
}

export function createExecutionPlanAuthorizer({
  secret,
  ttlMs = 600_000,
  clock = Date.now
} = {}) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("execution plan secret must contain at least 32 bytes");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_PLAN_TTL_MS) {
    throw new Error("execution plan ttlMs must be between 1 and 900000");
  }
  if (typeof clock !== "function") throw new Error("execution plan clock must be a function");

  function sign(encodedPayload) {
    return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  }

  function issue({ tenantId, plan, request } = {}) {
    const tenant = String(tenantId || "").trim();
    const projection = signedPlanProjection(plan);
    if (!tenant || !projection || projection.valid !== true) {
      throw new Error("a valid plan and tenant are required");
    }

    const issuedAt = readNow(clock);
    if (issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) {
      throw new Error("execution plan expiry exceeds the supported range");
    }
    const envelope = {
      version: 1,
      tokenId: randomUUID(),
      tenantId: tenant,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      plan: projection,
      request: requestProjection(request)
    };
    const encodedPayload = Buffer.from(canonical(envelope)).toString("base64url");
    return {
      token: encodedPayload + "." + sign(encodedPayload),
      expiresAt: envelope.expiresAt
    };
  }

  function verify({ token, tenantId, plan } = {}) {
    if (typeof token !== "string" || token.length > 64_000) {
      return { authorized: false, error: "execution_plan_authorization_invalid" };
    }
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { authorized: false, error: "execution_plan_authorization_invalid" };
    }

    const expected = Buffer.from(sign(parts[0]), "base64url");
    let supplied;
    let envelope;
    try {
      supplied = Buffer.from(parts[1], "base64url");
      const payload = Buffer.from(parts[0], "base64url").toString("utf8");
      envelope = JSON.parse(payload);
    } catch {
      return { authorized: false, error: "execution_plan_authorization_invalid" };
    }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return { authorized: false, error: "execution_plan_authorization_invalid" };
    }

    const now = readNow(clock);
    if (!envelope || envelope.version !== 1 ||
        typeof envelope.tokenId !== "string" || !envelope.tokenId ||
        !Number.isSafeInteger(envelope.issuedAt) ||
        !Number.isSafeInteger(envelope.expiresAt) ||
        envelope.expiresAt <= envelope.issuedAt ||
        envelope.expiresAt - envelope.issuedAt > ttlMs ||
        envelope.issuedAt > now + 30_000 ||
        !envelope.request || !Array.isArray(envelope.request.steps)) {
      return { authorized: false, error: "execution_plan_authorization_invalid" };
    }
    if (envelope.expiresAt <= now) {
      return { authorized: false, error: "execution_plan_authorization_expired" };
    }
    if (envelope.tenantId !== String(tenantId || "").trim()) {
      return { authorized: false, error: "execution_plan_tenant_mismatch" };
    }

    const suppliedPlan = signedPlanProjection(plan);
    if (!suppliedPlan || canonical(suppliedPlan) !== canonical(envelope.plan)) {
      return { authorized: false, error: "execution_plan_mismatch" };
    }

    return {
      authorized: true,
      request: structuredClone(envelope.request),
      expiresAt: envelope.expiresAt,
      tokenId: envelope.tokenId
    };
  }

  return Object.freeze({
    issue,
    verify,
    ttlMs
  });
}
