# Traefik Middlewares Reference

All shared Traefik middlewares live in:
`kubernetes/platform/external-routes/manifests/01-middlewares.yaml`

---

## Available Middlewares

| Name | Namespace | Purpose |
|------|-----------|---------|
| `redirect-to-https` | traefik | HTTP → HTTPS permanent redirect (applied to all port-80 traffic) |
| `internal-only` | traefik | Allow homelab LAN + VPN, block public internet |
| `netbird-vpn-only` | traefik | Allow ONLY NetBird VPN traffic (used for all `*.int.rlservers.com` routes) |
| `add-https-headers` | traefik | Sets `X-Forwarded-Proto: https` for backends |
| `secure-headers` | traefik | Browser security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) |
| `forward-auth` | traefik | Authentik proxy auth — any logged-in Authentik user passes |
| `forward-auth-admin` | traefik | Authentik proxy auth — `platform-admins` group required |
| `rate-limit-auth` | traefik | Brute-force protection on auth endpoints |
| `cors-authentik` | traefik | CORS headers for `auth.rlservers.com` OIDC endpoints |

---

## Usage Examples

### VPN-only Internal Route (default)
```yaml
middlewares:
  - name: netbird-vpn-only
    namespace: traefik
```
> Use for all `*.int.rlservers.com` routes. VPN is the authentication layer.

### Authentik Proxy Auth (any logged-in user) {#any-auth}
```yaml
middlewares:
  - name: forward-auth
    namespace: traefik
```
> Users are redirected to `auth.rlservers.com` to log in, then returned to the app.
> Add label `infraweaver.io/auth: proxy` to your Deployment for visibility.

### Authentik Proxy Auth (admin-only) {#admin-auth}
```yaml
middlewares:
  - name: forward-auth-admin
    namespace: traefik
```
> Same as `forward-auth` but the Authentik Application should have a Policy Binding
> requiring the `platform-admins` group.
>
> **Authentik policy setup:**
> 1. Go to **Applications → Providers → Create → Proxy Provider**
> 2. Set Forward Auth URL to your app's URL
> 3. Create an **Application** linked to this Provider
> 4. Add a **Policy Binding**: Expression Policy with:
>    ```python
>    return ak_is_group_member(request.user, name="platform-admins")
>    ```
> 5. Apply this middleware in your IngressRoute

> Add label `infraweaver.io/auth: admin` to your Deployment for visibility.

### Public Route (no auth) ⚠️
```yaml
# No middlewares — world-accessible
```
> Only use for apps explicitly designed to be public.
> Add label `infraweaver.io/auth: public` to your Deployment.

### Security Headers (applied automatically)
```yaml
middlewares:
  - name: secure-headers
    namespace: traefik
  - name: netbird-vpn-only   # or forward-auth / cors-authentik etc
    namespace: traefik
```
> `secure-headers` is applied to **all HTTP-serving routes** by default (via `new-app.sh` and platform routes).
> It adds the following response headers:
> - `Strict-Transport-Security: max-age=31536000; includeSubDomains` — HSTS, forces HTTPS for 1 year
> - `X-Frame-Options: SAMEORIGIN` — prevents clickjacking
> - `X-Content-Type-Options: nosniff` — prevents MIME sniffing
> - `Referrer-Policy: strict-origin-when-cross-origin` — limits referrer leakage
> - `Permissions-Policy: camera=(), microphone=(), geolocation=()` — disables browser APIs
> - `X-XSS-Protection: 0` — disables legacy XSS filter (modern browsers use CSP instead)
>
> ⚠️ **NOT applied to gRPC routes** (NetBird management, signal, relay) — HTTP headers don't apply to gRPC.
> ⚠️ **CSP is intentionally omitted** — Content-Security-Policy is highly app-specific and breaks most apps.

---

## Auth Labels

When you scaffold an app with `new-app.sh`, a label is added to the Deployment
so you can see auth status at a glance across all apps:

```bash
kubectl get deploy -A -L infraweaver.io/auth
```

| Label Value | Meaning |
|-------------|---------|
| `vpn` | VPN-only (NetBird, internal access) — default |
| `proxy` | Authentik proxy auth (any logged-in user) |
| `admin` | Authentik proxy auth (platform-admins group only) |
| `sso` | App uses native OIDC/SSO |
| `public` | No auth, world-accessible |

---

## Scaffold with Auth

Use `new-app.sh` flags to auto-generate the correct IngressRoute and set the label:

```bash
# Default: VPN-only internal access
bash scripts/new-app.sh my-app

# Authentik proxy: any logged-in user
bash scripts/new-app.sh my-app --auth

# Authentik proxy: platform-admins only
bash scripts/new-app.sh my-app --auth-admin

# Native OIDC (app handles its own auth)
bash scripts/new-app.sh my-app --auth-sso

# Public, no auth
bash scripts/new-app.sh my-app --public
```

---

## Adding Auth to an Existing App

1. Add the middleware to your IngressRoute:
   ```yaml
   middlewares:
     - name: forward-auth
       namespace: traefik
   ```
2. Add the label to your Deployment:
   ```yaml
   labels:
     infraweaver.io/auth: proxy
   ```
3. Push → ArgoCD auto-syncs within ~3 minutes.

---

## How `forward-auth` Works

```
Browser → Traefik → forward-auth middleware
                        ↓
              https://auth.rlservers.com/outpost.goauthentik.io/auth/traefik
                        ↓ (not authenticated)
              Redirect to auth.rlservers.com → login
                        ↓ (authenticated)
              Traefik passes request to backend
              with X-authentik-* headers set
```

The Authentik embedded outpost handles the session check.
`authResponseHeaders` passes user identity to the backend:
- `X-authentik-username` — logged-in username
- `X-authentik-groups` — comma-separated group list
- `X-authentik-email` — user email
