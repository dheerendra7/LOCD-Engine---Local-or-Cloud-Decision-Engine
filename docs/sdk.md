# JavaScript SDK

The repository includes a small dependency-free client for the LOCD HTTP API.

Usage:

    import { createLocdClient } from "../packages/sdk/src/index.js";

    const locd = createLocdClient({
      baseUrl: "http://localhost:8787"
    });

    const result = await locd.decide(request);

The client exposes:

- health()
- decide(request)
- policies()
- decisions(limit)
- metrics()

The SDK deliberately contains no routing logic. It is a transport/client layer; the server-side LOCD engine remains the source of truth for policy and placement decisions.

For browser applications, use the same client against the same-origin API. For server applications, configure the explicit API base URL and any required authentication headers.
