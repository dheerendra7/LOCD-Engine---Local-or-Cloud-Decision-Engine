import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return [
    "LOCD CLI",
    "",
    "Commands:",
    "  health",
    "  metrics",
    "  policies",
    "  decisions [limit]",
    "  decide <request.json>",
    "",
    "Options:",
    "  --base-url <url>    LOCD API base URL (default: http://localhost:8787)"
  ].join("\n");
}

export function parseArgs(argv) {
  const args = [...argv];
  let baseUrl = "http://localhost:8787";
  const positional = [];

  while (args.length) {
    const token = args.shift();
    if (token === "--base-url") {
      baseUrl = args.shift();
      if (!baseUrl) throw new Error("--base-url requires a value");
    } else {
      positional.push(token);
    }
  }

  return { baseUrl, positional };
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
  const { baseUrl, positional } = parseArgs(argv);
  const command = positional[0];

  if (!command || command === "help" || command === "--help") {
    write(usage());
    return 0;
  }

  if (command === "health") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/health"), null, 2));
    return 0;
  }

  if (command === "metrics") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/v1/metrics"), null, 2));
    return 0;
  }

  if (command === "policies") {
    write(JSON.stringify(await apiRequest(fetchImpl, baseUrl, "/v1/policies"), null, 2));
    return 0;
  }

  if (command === "decisions") {
    const limit = positional[1] || "50";
    write(JSON.stringify(
      await apiRequest(fetchImpl, baseUrl, "/v1/decisions?limit=" + encodeURIComponent(limit)),
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
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
