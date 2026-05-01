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
- **Redirect URIs**: `http://localhost:53000` (desktop client), `https://netbird.rlservers.com/auth` (dashboard web login), `https://netbird.rlservers.com/silent-auth` (dashboard silent refresh)
- `http://localhost:53000` is required for the **NetBird desktop client** PKCE callback
- **management.json `RedirectURLs` must ONLY contain `["http://localhost:53000"]`** — web dashboard URLs MUST NOT be in `RedirectURLs` (causes client to pick wrong redirect → infinite auth loop)
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
- **SPA hash-based callback**: NetBird dashboard SPA uses `/#callback` as redirect_uri (NOT `/auth`). Authentik must have `https://netbird.rlservers.com/#callback` in the provider's redirect_uris.
- **OidcTrustedDomains — CRITICAL**: The NetBird dashboard generates `OidcTrustedDomains.js` from `$NETBIRD_MGMT_API_ENDPOINT` at startup. The OIDC client only sends the access token to domains in this list. `NETBIRD_MGMT_API_ENDPOINT` MUST be set to the **public URL** `https://netbird.rlservers.com` (NOT the internal K8s DNS `http://netbird-management.netbird.svc:80`), or the browser's OIDC client will silently drop the Authorization header → "Error: Unauthenticated".
- **Conflicting IngressRoutes**: If two routes match the same host, Traefik picks the first-registered. Always remove old IngressRoutes for a hostname before deploying a new one.
- **JWT aud claim**: Authentik's `aud` claim defaults to the `client_id`. With `client_id=netbird` and NetBird's `AuthAudience=netbird`, this works correctly without any extra scope expressions.

### NetBird User ID Stability Issue (2026-04-30)
- **Problem**: `hashed_user_id` sub_mode computes `sub = sha256(user.pk + install_id)`.
  The `install_id` is stored in Authentik's PostgreSQL DB. When the DB is wiped on redeploy,
  `install_id` changes → new sub for every user → new NetBird user created with `role=user`.
- **Fix**: Change sub_mode to `user_username` in the blueprint (`sub_mode: user_username`).
  This makes `sub = username` (e.g. "remon") — stable across ALL Authentik redeployments.
- **Bootstrap**: `USR_REMON = "remon"` (the username) instead of a 64-char hex hash.
- **Result**: On any redeploy, the bootstrap pre-creates user "remon" with role=admin.
  NetBird management finds the pre-created user on first OIDC login → admin access ✅.

### NetBird PKCE Client Redirect URI Bug (Root Cause — 2026-05)

- **Symptom**: NetBird desktop/mobile client double-login → infinite `/auth` loop after login
- **Root cause**: NetBird `pkce_flow.go` iterates `RedirectURLs` from management.json and picks
  the **FIRST URL whose port is NOT in use locally** (`net.DialTimeout("tcp", ":PORT", 3s)`):
  - `https://netbird.rlservers.com/auth` → port 443 → never in use locally → **SELECTED** ❌
  - `http://localhost:53000` → port 53000 → selected ONLY if :443 is in use (never happens)
  - Client sends `redirect_uri=https://netbird.rlservers.com/auth` → auth code goes to web dashboard
  - Client can't capture auth code → timeout → retry → double-login → endless `/auth` loop
- **Fix**:
  - `management.json` `PKCEAuthorizationFlow.RedirectURLs`: ONLY `["http://localhost:53000"]`
  - Remove all web dashboard URLs (`/auth`, `/silent-auth`, `/#callback`) from `RedirectURLs`
  - Web dashboard has its own PKCE flow via `AUTH_REDIRECT_URI=/auth` env var (separate)
- **Source**: `client/internal/auth/pkce_flow.go` → `isRedirectURLPortUsed()` function
- **Architecture fix**: Created `api.netbird.rlservers.com` (API/gRPC) separate from
  `netbird.rlservers.com` (dashboard only). Signal URI and Relay address updated to `api.*`.

- **CRITICAL change in Authentik 2026.x**: `User.is_superuser` field **no longer exists**.
  Attempting to set it via `ak shell` gives: `FieldError: Cannot resolve keyword 'is_superuser' into field`.
- **How admin access works in 2026.x**: Add the user to the **`authentik Admins`** group.
  This group has `is_superuser: True`. Members get full admin access to the admin UI.
- **Blueprint limitation**: The `is_superuser: true` attr in blueprints is silently ignored AND
  the field doesn't exist on the model. Do NOT include it in blueprint attrs.
- **Correct post-deploy approach** (in `full-redeploy.yml`):
  ```python
  from authentik.core.models import User, Group
  remon = User.objects.get(username='remon')
  admins = Group.objects.get(name='authentik Admins')
  admins.users.add(remon)
  ```
- **Files**: 
  - `kubernetes/apps/authentik/manifests/blueprint-users.yaml` — does NOT set `is_superuser`
  - `.github/workflows/full-redeploy.yml` step "Set Authentik admin privileges" — uses group add

### Busybox TLS Incompatibility with Modern Traefik (2026-04-30)

- **Problem**: `busybox:1.36` `wget` fails TLS handshake with Traefik with "alert code 40: handshake failure".
  The server (Traefik) sends the alert, meaning the client (busybox wget/uClibc TLS) cannot
  negotiate cipher suites with Traefik's TLS 1.3-only configuration.
- **Fix**: Replace `busybox:1.36` + `wget` with `curlimages/curl:8.10.1` + `curl -sf --max-time 5`.
  `curlimages/curl` uses modern OpenSSL and handles TLS 1.3 correctly.
- **File**: `kubernetes/apps/netbird/manifests/management.yaml` — `wait-for-oidc` init container.

### Let's Encrypt Rate Limits — Main Cert Bundle (2026-04-30)

- **Problem**: Main cert (`rlservers-com-wildcard`) had 34 SANs. After 5 full redeployments/week,
  Let's Encrypt rate-limits with: `429 too many certificates (5) for this exact set of identifiers`.
  This leaves `auth.rlservers.com` without a valid cert, blocking NetBird init container → pod stuck.
- **Fix**: 
  1. Reduced main cert to 12 active SANs only (removed unused subdomains).
  2. Created individual certs `auth-rlservers-com` and `netbird-rlservers-com` with DNS-01 (Cloudflare).
     These are never rate-limited because they have unique, small SAN sets.
  3. Pinned IngressRoutes for auth and netbird to their individual `secretName`.
- **Files**: 
  - `kubernetes/apps/external-routes/manifests/02-certificates.yaml`
  - `kubernetes/apps/external-routes/manifests/11-routes-authentik.yaml` — `tls.secretName: auth-rlservers-com-tls`
  - `kubernetes/apps/external-routes/manifests/09-routes-netbird.yaml` — `tls.secretName: netbird-rlservers-com-tls`

- When connected to NetBird VPN, DNS for `rlservers.com` is pushed to CoreDNS (`10.10.0.201`).
- CoreDNS resolves ALL `*.rlservers.com` → `10.10.0.200` (Traefik internal MetalLB IP).
- This is expected and correct — all services are accessible via VPN.
- SSO login works on both public (via Cloudflare CDN) and VPN paths.
- The `OidcTrustedDomains.js` uses hostname (`https://netbird.rlservers.com`), not the resolved IP,
  so Bearer tokens are sent correctly regardless of routing path.

### NetBird DB Encryption Format
- NetBird management stores encrypted fields (email, name) using AES-256-GCM.
- Format: `base64(nonce[12] || ciphertext || GCM-tag[16])`
- Key: `DATASTORE_ENC_KEY` env var = base64-encoded 32-byte AES key.
- Bootstrap decrypt: `base64.b64decode(env_var)` → 32 bytes → use with `AESGCM()`.
- Do NOT use `.hex()` — the management expects base64, not hex.

### Traefik CORS for Authentik Endpoints (2026-04-30)
- **Problem**: NetBird dashboard Logout button fails with `TypeError: Failed to fetch` (CORS block).
  The OIDC library (`oidc-client-ts`) on logout tries to call the token revocation endpoint
  (`/application/o/revoke/`) and then the userinfo endpoint before redirecting.
  These endpoints return no `Access-Control-Allow-Origin` header → browser blocks the fetch.
- **Cause**: Authentik adds CORS headers to application-specific endpoints (token, authorize)
  but NOT to global/utility endpoints (revoke, userinfo). These return `text/html` on OPTIONS.
- **Fix**: Add a Traefik `Middleware` with `customResponseHeaders` to the Authentik IngressRoute.
  File: `kubernetes/apps/external-routes/manifests/11-routes-authentik.yaml`
  ```yaml
  spec:
    headers:
      customResponseHeaders:
        Access-Control-Allow-Origin: "https://netbird.rlservers.com"
        Access-Control-Allow-Methods: "GET, POST, OPTIONS, HEAD"
        Access-Control-Allow-Headers: "Authorization, Content-Type, Accept"
        Access-Control-Allow-Credentials: "true"
        Access-Control-Max-Age: "86400"
  ```
- **Why `customResponseHeaders` not `accessControlAllowOriginList`**:
  `accessControlAllowOriginList` in Traefik's headers middleware did NOT inject headers
  in practice (may require backend CORS support to be fully absent; unclear). 
  `customResponseHeaders` unconditionally injects the headers, replacing any backend-set
  headers of the same name (Traefik v3 behavior). No duplicate headers occur.
- **Critical gotcha**: NEVER use `kubectl apply` directly for changes to ArgoCD-managed resources.
  ArgoCD reconciles every ~3 minutes and REVERTS any direct kubectl edits back to the Git state.
  Always commit to Git first, then trigger ArgoCD sync. Direct `kubectl apply` changes are silently
  undone by ArgoCD within minutes.
- **Stale token workaround**: If user is stuck on "Error: Unauthenticated" with broken Logout:
  ```js
  localStorage.clear(); sessionStorage.clear(); location.href = 'https://netbird.rlservers.com';
  ```

### Cloudflare gRPC Proxying for NetBird (2026-04-30)

- **Problem**: NetBird mobile app got `502 Bad Gateway` with `content-type: text/plain` when calling
  the management gRPC `GetServerPublicKey`. Desktop client got generic "connection failed".
- **Root cause diagnosed**: The 502 occurred during a management pod restart window — Cloudflare
  correctly proxied gRPC but the origin was temporarily unavailable.
- **Confirmed working**: gRPC through Cloudflare proxy works on the **Free plan** when:
  - `HTTP/2` is ON (zone setting) ✅
  - `origin_max_http_version: 2` (allows CF→origin HTTP/2) ✅
  - SSL mode: **Full** (not Flexible) ✅ — Flexible causes 308 redirect from Traefik → gRPC breaks
  - Cloudflare proxies gRPC automatically when HTTP/2 is enabled — no special "gRPC" toggle needed
- **Test command** (confirms gRPC works through CF):
  ```bash
  curl --http2 -H "Content-Type: application/grpc" -H "TE: trailers" -X POST \
    "https://netbird.rlservers.com/management.ManagementService/GetServerPublicKey"
  # Expect: HTTP/2 200 + content-type: application/grpc (grpc-status != 502)
  ```
- **Important**: SSL mode "Flexible" makes Cloudflare connect to origin on port 80 → Traefik
  returns `308 HTTPS Redirect` → gRPC doesn't follow redirects → CF returns 502.
  Always use **Full** or **Full (Strict)** for gRPC services.
- **Cloudflare token scope**: The `grpc` zone setting returns `9109 Unauthorized` — this is a
  plan/scope restriction. gRPC still works; the setting cannot be read/written via API on Free plan.
- **Cloudflare token storage**: 
  - OpenBao: `secret/platform/cloudflare.CF_API_TOKEN`
  - GitHub Secret: `CLOUDFLARE_API_TOKEN` (used in `full-redeploy.yml`)

### NetBird PKCE Scope Field — String Not Array (Critical Config Bug)

- **Error**: `PKCE Auth Scopes value is empty. Contact your NetBird administrator`
  (returned by the NetBird client after receiving the `GetPKCEAuthorizationFlow` response)
- **Root cause**: NetBird's Go `ProviderConfig` struct has `Scope string` (singular, space-separated),
  NOT `Scopes []string`. When management.json contains `"Scopes": [...]` (JSON array), Go's
  `encoding/json` silently ignores the mismatch (can't unmarshal array into string), leaving
  `Scope` empty. The management server sends empty scope in the gRPC response → client error.
- **Fix**: Use `"Scope": "openid profile email offline_access"` (space-separated string) in
  `management.json.template`, NOT `"Scopes": [...]`.
- **Files**:
  - `kubernetes/apps/netbird/manifests/management.yaml` — ConfigMap `management.json.template`
  - Live PVC file at `/var/lib/netbird/management.json` — fix with sed or by deleting + restarting
- **Source reference**: `management/internals/server/config/config.go`:
  ```go
  type ProviderConfig struct {
      ...
      Scope string  // space-separated, NOT []string
      ...
  }
  ```
- **After fix**: Delete the live PVC file OR patch it with sed, then restart the management pod.
  The init container ALWAYS overwrites the PVC file on every pod restart (writes management.json from template). No manual patching needed — just restart the pod.
### Cloudflare Universal SSL Does NOT Cover 2nd-Level Subdomains (Critical — 2026-05)

- **Problem**: NetBird clients (PC + phone) get `failed to create auth client: create connection: dial context: context deadline exceeded` when connecting to `api.netbird.rlservers.com`.
- **Root cause**: Cloudflare Universal SSL (free plan) covers `rlservers.com` and `*.rlservers.com` (ONE level of wildcard). It does NOT cover `api.netbird.rlservers.com` which is `*.netbird.rlservers.com` (TWO levels deep). When `proxied=true`, Cloudflare presents an invalid edge cert → TLS handshake fails → client sees "context deadline exceeded".
- **Fix**: Set Cloudflare DNS record for `api.netbird.rlservers.com` to **DNS-only** (`proxied=false`):
  - The Let's Encrypt cert from cert-manager (`rlservers-com-wildcard-tls`) covers `api.netbird.rlservers.com` as a SAN
  - Clients connect directly to origin IP `84.82.69.110` → cert-manager handles TLS ✅
  - gRPC over HTTP/2 works natively on the origin (Traefik with `scheme: h2c`)
- **DNS record state**: `api.netbird.rlservers.com` A → `84.82.69.110`, `proxied=false` (DNS-only)
- **Why DNS-only is better for VPN anyway**: gRPC is latency-sensitive; routing through Cloudflare adds ~20-50ms. Direct connection is faster for VPN peers.
- **Enforcement in full-redeploy.yml**: Step "Ensure Cloudflare DNS records for api.netbird.rlservers.com" always PATCHes existing record with `proxied=false` to prevent accidental re-proxying.
- **Standalone fix workflow**: `.github/workflows/fix-cloudflare-dns.yml` — run `workflow_dispatch` to immediately fix DNS without a full redeploy.
- **Rule**: Any hostname more than one level under the root domain (e.g. `sub.sub.domain.com`) MUST be DNS-only on Cloudflare Free plan, or upgrade to Advanced Certificate Manager ($10/mo).

