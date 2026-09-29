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
- persistent target registry
- rate limiting
- structured logs and traces
- provider credential isolation
- backups and migration strategy
- uptime/error monitoring
- SLOs for the LOCD control plane

The free deployment is a useful demo and evaluation environment, not a production SLA.
