import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupSQLiteDatabase } from "../../sqlite/src/index.js";

function usage() {
  return [
    "LOCD CLI",
    "",
    "Commands:",
    "  health",
    "  metrics",
    "  policies",
    "  decisions [limit]",
    "  targets",
    "  probe <target-id>",
    "  decide <request.json>",
    "  execute <plan.json> [--live] [--include-outputs]",
    "  backup <source.db> <destination.db> [--force]",
    "",
    "Options:",
    "  --base-url <url>    LOCD API base URL (default: http://localhost:8787)",
    "  --api-key <key>     Optional API key; LOCD_API_KEY env is preferred",
    "  --idempotency-key <key>  Retry key for POST commands"
  ].join("\n");
}

export function parseArgs(argv) {
  const args = [...argv];
  let baseUrl = "http://localhost:8787";
  let apiKey = null;
  let idempotencyKey = null;
  let live = false;
  let includeOutputs = false;
  let force = false;
  const positional = [];

  while (args.length) {
    const token = args.shift();
    if (token === "--base-url") {
      baseUrl = args.shift();
      if (!baseUrl) throw new Error("--base-url requires a value");
    } else if (token === "--api-key") {
      apiKey = args.shift();
      if (!apiKey) throw new Error("--api-key requires a value");
    } else if (token === "--idempotency-key") {
      idempotencyKey = args.shift();
      if (!idempotencyKey) throw new Error("--idempotency-key requires a value");
    } else if (token === "--live") {
      live = true;
    } else if (token === "--include-outputs") {
      includeOutputs = true;
    } else if (token === "--force") {
      force = true;
    } else {
      positional.push(token);
    }
  }

  return { baseUrl, apiKey, idempotencyKey, live, includeOutputs, force, positional };
}

async function apiRequest(fetchImpl, baseUrl, pathname, options = {}) {
  const response = await fetchImpl(baseUrl.replace(/\/$/, "") + pathname, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "LOCD API request failed (" + response.status + ")");
  }
  return body;
}

export async function runCli(argv, { fetchImpl = globalThis.fetch, write = console.log } = {}) {
  const {
    baseUrl,
    apiKey: parsedApiKey,
    idempotencyKey,
    live,
    includeOutputs,
    force,
    positional
  } = parseArgs(argv);
  const apiKey = parsedApiKey || process.env.LOCD_API_KEY || null;
  const command = positional[0];

  const authHeaders = apiKey ? { "x-locd-api-key": apiKey } : {};
  const postHeaders = {
    ...authHeaders,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };

  if (!command || command === "help" || command === "--help") {
    write(usage());
    return 0;
  }

  if (command === "health") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/health"), null, 2));
    return 0;
  }

  if (command === "metrics") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/v1/metrics", {
      headers: authHeaders
    }), null, 2));
    return 0;
  }

  if (command === "targets") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/v1/targets", {
      headers: authHeaders
    }), null, 2));
    return 0;
  }

  if (command === "probe") {
    const targetId = positional[1];
    if (!targetId) throw new Error("probe requires a target id");
    write(JSON.stringify(
      await apiRequest(fetchImpl, baseUrl, "/v1/targets/" + encodeURIComponent(targetId) + "/probe", {
        method: "POST",
        headers: postHeaders,
        body: "{}"
      }),
      null,
      2
    ));
    return 0;
  }

  if (command === "policies") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/v1/policies", {
      headers: authHeaders
    }), null, 2));
    return 0;
  }

  if (command === "decisions") {
    const limit = positional[1] || "50";
    write(JSON.stringify(
      await apiRequest(fetchImpl, baseUrl, "/v1/decisions?limit=" + encodeURIComponent(limit), {
        headers: authHeaders
      }),
      null,
      2
    ));
    return 0;
  }

  if (command === "decide") {
    const file = positional[1];
    if (!file) throw new Error("decide requires a JSON file path");
    const content = await readFile(path.resolve(file), "utf8");
    const request = JSON.parse(content);
    write(JSON.stringify(
      await apiRequest(fetchImpl, baseUrl, "/v1/decide", {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify(request)
      }),
      null,
      2
    ));
    return 0;
  }

  if (command === "backup") {
    const sourcePath = positional[1];
    const destinationPath = positional[2];
    if (!sourcePath || !destinationPath) {
      throw new Error("backup requires source and destination database paths");
    }

    const result = await backupSQLiteDatabase({
      sourcePath,
      destinationPath,
      overwrite: force
    });
    write(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "execute") {
    const file = positional[1];
    if (!file) throw new Error("execute requires a JSON plan file path");
    const content = await readFile(path.resolve(file), "utf8");
    const plan = JSON.parse(content);
    plan.mode = live ? "live" : "dry-run";
    if (includeOutputs) plan.includeOutputs = true;

    write(JSON.stringify(
      await apiRequest(fetchImpl, baseUrl, "/v1/execute", {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify(plan)
      }),
      null,
      2
    ));
    return 0;
  }

  throw new Error("unknown command: " + command);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
