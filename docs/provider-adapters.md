# Provider Adapters

LOCD provider adapters translate a vendor-specific control/execution protocol into the normalized target and execution interfaces.

The provider package includes OpenAI-compatible, native Ollama and native Anthropic adapters.

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


## Native Anthropic adapter

The native Anthropic adapter uses the Anthropic Models API for probing and the Messages API for live execution. It sends the API key through the `x-api-key` header and pins the Anthropic API version through `anthropic-version`. The adapter injects the configured model and `max_tokens` when the execution payload omits them, while keeping provider credentials outside normalized snapshots.

Anthropic's current API reference documents `GET /v1/models` for model discovery and `POST /v1/messages` for message generation. The Messages API requires a model, max token budget, and messages payload. citeturn721927search3turn721927search1turn721927search7

Example:

    {
      "type": "anthropic",
      "id": "anthropic-cloud",
      "targetId": "anthropic-cloud",
      "mode": "cloud",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "tenantId": "acme",
      "workspaceId": "wrkspc_...",
      "model": "your-anthropic-model-id"
    }

The adapter is intentionally provider-specific at the execution boundary while exposing the same normalized target snapshot and execution contract used by the other providers. When a configured model is returned by the Models API, its max input context is copied into LOCD's maxContextTokens signal. Workspace selection is sent only through the server-side provider configuration.

## Native Ollama adapter

Provider configs may optionally include tenantId. The server binds the provider to that tenant's registry without placing tenant identity in public target snapshots.

The native adapter targets Ollama's `/api/tags` probe and `/api/chat` execution endpoints. It supports both the local Ollama server and direct cloud API configuration. Local requests do not require an API key; direct cloud API requests use a Bearer key. citeturn513313search1turn513313search2

Example:

    {
      "type": "ollama",
      "id": "local-ollama",
      "targetId": "local-ollama",
      "mode": "local",
      "baseUrl": "http://localhost:11434/api",
      "model": "llama3.2"
    }
