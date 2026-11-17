# Policy Rules

LOCD policy rules let operators express workload-specific policy without embedding business logic in the core scorer.

## Rule shape

    {
      "id": "legal-local-only",
      "priority": 100,
      "when": {
        "workloadType": "legal-llm",
        "sensitivity": "high",
        "requiredCapability": ["text-generation"]
      },
      "set": {
        "sensitiveDataMode": "local-only",
        "allowedModes": ["local"],
        "maxHeartbeatAgeMs": 30000
      }
    }

## Matching

A rule can match:

- workloadType
- sensitivity
- requiredCapability / required capabilities

All specified match conditions must pass.

## Precedence

Rules are applied from lower priority to higher priority. For the same priority, declaration order is used. A later matching rule therefore overrides an earlier matching rule for scalar settings.

The engine returns policyRulesApplied and adds policy_rule_applied:<id> to the explanation reasons.

## Supported rule settings

Rules may set:

- sensitiveDataMode
- allowedModes
- blockedModes
- allowedRegions
- maxHeartbeatAgeMs
- individual scoring weights

Unsupported settings and invalid modes fail validation instead of silently changing behavior.

The rule system is deterministic and remains separate from provider execution.
