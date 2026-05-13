## Security Architecture

InfraWeaver treats the console as a privileged internal application and layers controls accordingly.

### Authentication

- Authentik acts as the OIDC identity provider
- NextAuth manages the application session
- middleware redirects unauthenticated users away from protected routes
- selected health routes remain public for safe liveness probing

### Authorization (RBAC)

- built-in roles are defined in `src/lib/rbac.ts`
- scoped assignments are stored in `users.yaml`
- API routes check permissions before reading or mutating sensitive resources
- Game Hub routes use additional scope-aware helpers for per-server access

### Network security

- internal services are expected to live behind NetBird where possible
- external access should pass through Traefik and Authentik-aware ingress controls
- session and CSRF protections are enforced in middleware and route helpers

### Secrets

- secrets never belong in git
- environment values come from External Secrets and OpenBao
- GitHub, Cloudflare, and auth credentials are injected at runtime

### Defensive defaults

Good platform hygiene includes:

- rate limiting on sensitive routes
- same-origin checks for mutations
- audit logging for auth and admin actions
- minimizing the service account’s write permissions

## Secure feature checklist

Before merging a new feature, confirm:

- the route requires a session where appropriate
- mutations check CSRF or same-origin protections
- RBAC is explicit
- secrets are read from environment variables only
- new docs do not leak internal credentials or tokens
