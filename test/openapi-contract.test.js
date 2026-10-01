import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("heartbeat OpenAPI operation has a single parameters map", async () => {
  const yaml = await readFile(path.join(root, "docs/openapi.yaml"), "utf8");
  const start = yaml.indexOf("  /v1/targets/{id}/heartbeat:");
  const end = yaml.indexOf("\n  /v1/outcomes:", start);
  assert.ok(start >= 0);
  assert.ok(end > start);

  const section = yaml.slice(start, end);
  assert.equal((section.match(/^      parameters:$/gm) || []).length, 1);
  assert.match(section, /IdempotencyKey/);
  assert.match(section, /RequestId/);
  assert.match(section, /name: id/);
});

test("OpenAPI operations do not define duplicate top-level parameter maps", async () => {
  const yaml = await readFile(path.join(root, "docs/openapi.yaml"), "utf8");
  let currentPath = null;
  let currentMethod = null;
  let parameterMaps = 0;

  for (const line of yaml.split("\n")) {
    const pathMatch = line.match(/^  (\/[^:]+):$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      parameterMaps = 0;
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|patch|delete):$/);
    if (methodMatch) {
      currentMethod = methodMatch[1];
      parameterMaps = 0;
      continue;
    }

    if (line === "      parameters:" && currentPath && currentMethod) {
      parameterMaps += 1;
      assert.equal(
        parameterMaps,
        1,
        currentPath + " " + currentMethod + " has duplicate parameters maps"
      );
    }
  }
});
