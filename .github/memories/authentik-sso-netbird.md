# Authentik SSO for NetBird — Setup Notes

## Architecture
- **Authentik** at `https://auth.rlservers.com` (Helm chart, `authentik` namespace)
- **PostgreSQL** + **Redis** deployed as sub-charts (bitnami)
- Secrets in OpenBao `secret/platform/authentik` → ExternalSecret `authentik-secrets`
- Traefik IngressRoute: `auth.rlservers.com` → `authentik-server.authentik:80` (public, no VPN restriction)
- ExternalName service `authentik-server` in `traefik` ns for cross-ns routing

## NetBird OIDC Integration
- **OAuth2 provider**: `client_id=netbird`, `client_type=public` (PKCE, no secret)
- **Application slug**: `netbird`
- **OIDC discovery**: `https://auth.rlservers.com/application/o/netbird/.well-known/openid-configuration`
- **Redirect URIs**: `https://netbird.rlservers.com/auth`, `https://netbird.rlservers.com/silent-auth`, `http://localhost:53000`
- `http://localhost:53000` is required for the **NetBird desktop client** PKCE callback — missing this causes "Redirect URI Error" on client login
- **NetBird dashboard**: `AUTH_AUTHORITY=https://auth.rlservers.com/application/o/netbird/`, `AUTH_CLIENT_ID=netbird`
- **NetBird management.json**: `HttpConfig.OIDCConfigEndpoint` set, `PKCEAuthorizationFlow` configured

## Admin Access
- URL: `https://auth.rlservers.com/if/admin/`
- Email: `admin@rlservers.com`
- Password: see OpenBao `secret/platform/authentik.bootstrap-password`

## Blueprint Notes
- Blueprint ConfigMap `authentik-blueprint-netbird` in `authentik` ns is applied by the worker
- On first boot, the blueprint may run before default flows are ready → idempotent, re-runs
- **In 2026.2, `redirect_uris` must be a list of `{matching_mode, url}` objects** (not a string)
- If blueprint fails silently: use the API setup script (provider + application created via REST API)

## Lessons Learned
- `PKCEAuthorizationFlow.ProviderConfig.Audience` is type `string` not `[]string` in NetBird
- `redirect_uris` format changed from string to object list in Authentik 2024.6+
- Authentik uses request host headers to set issuer URL → correct when accessed via Traefik
- Blueprint instances may not appear in `/api/v3/blueprints/instances/` if they complete too fast
- **Startup race condition**: NetBird management fetches OIDC config on startup; if Authentik isn't ready yet it gets 502 and crash-loops. Fix: init container that polls OIDC endpoint before management starts
- **Desktop client redirect**: NetBird desktop client uses `http://localhost:53000` for PKCE — must be in Authentik provider redirect_uris AND management.json `PKCEAuthorizationFlow.RedirectURLs`
