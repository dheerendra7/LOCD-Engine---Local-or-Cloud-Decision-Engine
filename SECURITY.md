# Security

LOCD is early-stage software. Do not send sensitive production data to an unreviewed deployment.

Security roadmap:
- authentication and authorization
- secret handling and rotation
- tenant isolation
- audit logging
- rate limiting
- request size limits
- provider credential isolation
- privacy and residency enforcement

## API authentication

Set LOCD_API_KEY in the deployment environment to enable the built-in API-key guard. Keep the secret outside source control and use a secret manager in hosted environments.

The health endpoint remains unauthenticated so load balancers and platform health checks can probe readiness. Application and control-plane endpoints under /v1/ are protected when the key is configured.

This is a baseline mechanism, not a complete enterprise identity system. Later releases should add tenant-aware identity, scoped permissions and credential rotation.
