# Policy Profiles

LOCD provides opinionated starting profiles so applications can begin with a known policy and override only what they need.

## balanced

Balances privacy, latency, cost, capacity and reliability.

## localFirst

Prefers local execution for sensitive workloads while keeping other eligible targets available.

## privacyFirst

Uses a private-boundary policy for high-sensitivity workloads and gives privacy the highest soft weight.

## latencyFirst

Gives the largest soft weight to estimated latency while still honoring hard constraints.

## costFirst

Gives the largest soft weight to estimated cost while still honoring reliability and policy.

## strictLocalSensitive

Restricts high-sensitivity traffic to local targets.

## API usage

Request:

    {
      "workload": {
        "type": "llm-inference",
        "sensitivity": "high"
      },
      "policy": {
        "profile": "localFirst"
      },
      "targets": []
    }

A request can override fields from the selected profile. For example:

    {
      "policy": {
        "profile": "costFirst",
        "sensitiveDataMode": "prefer-local",
        "weights": {
          "latency": 0.30
        }
      }
    }

Hard constraints always take precedence over profile preferences.
