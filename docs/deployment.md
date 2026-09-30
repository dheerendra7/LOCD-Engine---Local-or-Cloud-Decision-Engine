# Deployment

## Render

The repository includes render.yaml for a simple Node web-service deployment.

Current configuration:

- runtime: Node
- branch: main
- build: npm install
- start: npm start
- health check: /health
- compute plan: free

Render currently documents free web services as suitable for testing, hobby projects and previews, with limitations; they should not be treated as production infrastructure. Free web services also spin down after 15 minutes of inactivity.

Source: https://render.com/docs/free

## Docker

Build and run locally:

    docker compose up --build

Then open:

    http://localhost:8787/

## Production checklist

Before production use, add:

- authentication and authorization
- secret management
- durable database-backed telemetry
- centralized policy storage
- persistent target registry (LOCD_TARGETS_FILE; use durable storage for hosted production)
- rate limiting
- structured logs and traces
- provider credential isolation
- backups and migration strategy
- uptime/error monitoring
- SLOs for the LOCD control plane

The free deployment is a useful demo and evaluation environment, not a production SLA.

## Persistent target registry

Set:

    LOCD_TARGETS_FILE=/var/lib/locd/targets.json

The server restores targets from this JSON file at startup and writes the file after target registration/removal.

The file is an operator-controlled configuration/state artifact. On managed platforms with ephemeral filesystems, attach persistent storage or use a database-backed registry before depending on restart durability.

## API hardening configuration

Recommended hosted settings should include a bounded LOCD_MAX_BODY_BYTES and, where appropriate, a positive LOCD_RATE_LIMIT_RPM.

LOCD_TRUST_PROXY should remain false unless the operator controls and trusts the reverse proxy that supplies X-Forwarded-For.
