---
title: NetBird Relay Configuration and Traefik WebSocket Routing
description: How to configure the NetBird relay in management.json and route it correctly through Traefik
---

# NetBird Relay Configuration and Traefik WebSocket Routing

## Memory

- **File paths:**
  - `kubernetes/platform/netbird/manifests/management.yaml` — management.json.template + init container
  - `kubernetes/platform/external-routes/manifests/09-routes-netbird.yaml` — Traefik IngressRoutes

- **Decision:** NetBird relay must be configured in management.json under the `"Relay"` key, and the Traefik route to the relay must use `scheme: http` (NOT `serversTransport: insecure-skip-verify`).

- **Why it matters:**
  1. Without the `"Relay"` config in management.json, the management server never advertises the relay URL to peers. Peers see `Relays:` as empty in `netbird status`. WireGuard tunnels fail when P2P/STUN is blocked by NAT, and `relay client not connected` appears in the detailed status.
  2. The relay pod serves plain HTTP WebSocket on port 443 (no TLS at pod level). Traefik handles TLS termination. Using `serversTransport: insecure-skip-verify` forces Traefik to connect to the relay backend via HTTPS, causing 500 errors. The correct setting is `scheme: http`.

- **Required management.json Relay section:**
  ```json
  "Relay": {
    "Addresses": ["rels://netbird.rlservers.com:443/relay"],
    "CredentialsTTL": "12h",
    "Secret": "<same value as NB_AUTH_SECRET / turn-password secret>"
  }
  ```

- **Init container substitution:** The secret is substituted via `sed` in the init container using `NB_RELAY_SECRET` env var from the `netbird-secrets` secret key `turn-password`. Both `NB_AUTH_SECRET` on the relay deployment and the `Secret` in management.json must match.

- **Correct Traefik relay route:**
  ```yaml
  services:
    - name: netbird-relay
      port: 443
      scheme: http   # MUST be http — relay speaks plain WebSocket, not HTTPS
  ```

- **Dashboard chicken-and-egg:** The `netbird.rlservers.com` dashboard must NOT have `netbird-vpn-only` middleware. Users need to access the dashboard to log in, which requires VPN which requires the dashboard. The dashboard has its own PAT auth. Only `*.int.rlservers.com` routes should be VPN-only.

- **Validation:** After restart of the management pod:
  ```bash
  # On routing peer:
  sudo netbird status --detail | grep -A5 "Relays:"
  # Should show: [rels://...] is Available
  # Peers count should increase as relay enables connections
  ```

- **Related:**
  - `kubernetes/platform/netbird/manifests/relay.yaml` — relay deployment with `NB_AUTH_SECRET` from `netbird-secrets.turn-password`
  - The management pod must be restarted after changing management.json.template (init container regenerates the file on pod start)

- **Lesson learned:** The relay was running and exposed correctly, but two independent bugs prevented it from being used: (1) management didn't know about it (missing Relay config in management.json), and (2) Traefik was connecting to it wrong (HTTPS vs HTTP). Both had to be fixed together.
