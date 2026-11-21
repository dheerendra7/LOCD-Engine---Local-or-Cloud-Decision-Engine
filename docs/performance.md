# Decision Engine Performance Checks

LOCD includes a reproducible local benchmark for the synchronous decision-scoring path.

## Run it

```bash
npm run bench:decision
```

The default run measures 100, 1,000 and 5,000 candidate targets. Custom target counts are supported:

```bash
node scripts/bench-decision.mjs 250 2500 10000
```

The benchmark warms up the runtime, records 30 measured runs per workload size, and reports median (p50), p95, average duration and decisions per second.

## How to interpret the numbers

- Compare runs on the same machine, Node version and power mode.
- Use p50 for typical behaviour and p95 to spot tail-latency changes.
- Benchmark the same target mix and workload constraints when comparing commits.
- These local numbers are not a production SLO. Validate API latency under representative network, storage and concurrency load before setting service-level targets.

The candidate scoring path uses bounded single-pass min/max scans rather than spreading arbitrarily large candidate arrays into function arguments. This avoids argument-count failures on large direct-library inputs and removes intermediate latency/cost arrays.
