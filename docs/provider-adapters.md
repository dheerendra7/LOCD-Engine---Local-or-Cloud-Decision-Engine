# Provider Adapters

LOCD provider adapters translate a vendor-specific control/execution protocol into the normalized target and execution interfaces.

The current provider package includes an OpenAI-compatible adapter.

It can:

- expose normalized target state
- probe GET /v1/models
- measure probe latency
- classify network, timeout and HTTP failures
- execute live POST /v1/chat/completions calls
- inject a configured model when the execution payload omits one

## Security boundary

Provider adapter configuration is server-side. Public API callers cannot submit arbitrary provider URLs or credentials through the target registration API.

Remote HTTP is rejected by default. Localhost/loopback HTTP is allowed for local development. Remote HTTP can be explicitly enabled by adapter configuration for controlled environments.

Provider API keys are held in adapter memory and are never included in normalized snapshots or telemetry.

Use the generic target registry and probe endpoint to publish fresh provider state into LOCD.

    provider adapter
          |
          +--> probe()
          |      |
          |      v
          |  target snapshot
          |      |
          |      v
          +--> target registry
                     |
                     v
                decision engine
