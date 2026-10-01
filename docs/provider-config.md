# Provider configuration

Set `LOCD_PROVIDERS_FILE` to a JSON file that defines server-side provider adapters.

Example:

    LOCD_PROVIDERS_FILE=./config/providers.json
    PRIVATE_VLLM_API_KEY=...

The JSON file contains provider metadata and references secrets by environment-variable name through `apiKeyEnv`. Never put provider API keys directly in this file.

Example structure:

    {
      "providers": [
        {
          "id": "private-vllm",
          "targetId": "private-vllm",
          "mode": "private",
          "baseUrl": "https://inference.example.com",
          "apiKeyEnv": "PRIVATE_VLLM_API_KEY",
          "model": "my-model"
        }
      ]
    }

At startup the API loads the provider adapters, validates them, and registers them with the target registry. Duplicate adapter IDs fail startup rather than silently replacing an existing target.

Provider adapters start unavailable until their first successful probe unless an explicit initial availability value is supplied. This avoids routing traffic to an unverified remote target.

Provider config is operator-controlled. The public target registration API still accepts normalized snapshots and does not accept provider credentials or arbitrary provider connection settings.
