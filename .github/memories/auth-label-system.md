---
title: Auth Label System — infraweaver.io/auth Labels + Authentik Middleware
description: How the auth label system works — new-app.sh flags, Traefik middlewares, and label conventions for Authentik proxy protection.
---

# Auth Label System

## Memory

- **File paths:**
  - `scripts/new-app.sh` — `--auth`, `--auth-admin`, `--auth-sso`, `--public` flags
  - `kubernetes/platform/external-routes/manifests/01-middlewares.yaml` — `forward-auth` and `forward-auth-admin` Traefik Middleware
  - `docs/MIDDLEWARES.md` — full reference for all Traefik middlewares
  - `docs/templates/app/manifests/ingressroute-auth.yaml.example` — template for auth-protected routes

- **Decision:** Label `infraweaver.io/auth` is set on every Deployment to document auth mode.
  - `vpn` = NetBird VPN only (default)
  - `proxy` = Authentik forward-auth (any logged-in user)
  - `admin` = Authentik forward-auth + platform-admins group policy
  - `sso` = app uses native OIDC
  - `public` = no auth, world-accessible

- **Why it matters:**
  - Without the label, there's no way to see which apps have auth protection at a glance
  - `kubectl get deploy -A -L infraweaver.io/auth` shows all apps and their auth mode
  - Prevents accidentally leaving apps unprotected

- **forward-auth middleware URL:**
  - CORRECT: `https://auth.rlservers.com/outpost.goauthentik.io/auth/traefik`
  - WRONG (old): `https://auth.rlservers.com` (would hit Authentik UI, not outpost)
  - Must include `authResponseHeaders` list to pass user identity to backends
  - Old URL was in `01-middlewares.yaml` before May 2026 — now fixed

- **forward-auth-admin vs forward-auth:**
  - Both use the SAME Traefik middleware URL (Authentik embedded outpost)
  - The group restriction is enforced in Authentik via a Policy Binding on the Application
  - Traefik just forwards the auth check; Authentik returns 403 for unauthorized users
  - Setup: Applications → Providers → Proxy Provider → Policy Binding: `ak_is_group_member(request.user, name="platform-admins")`

- **Validation:**
  - `kubectl get deploy -A -L infraweaver.io/auth` shows all auth labels
  - Check middleware: `kubectl get middleware -n traefik`
  - Test: hit a protected URL without session → should redirect to `auth.rlservers.com`

- **Related:**
  - `docs/MIDDLEWARES.md` — complete middleware reference
  - `scripts/new-app.sh` — scaffold flags
  - Authentik docs: https://docs.goauthentik.io/docs/providers/proxy/forward_auth

- **Lesson learned:** Authentik forward-auth requires the `/outpost.goauthentik.io/auth/traefik` path suffix. Without it, Traefik hits the Authentik login UI directly, which doesn't return proper 401/redirect responses for the forwardAuth flow.
