# NetBird Architecture

## Overview

NetBird is deployed in Kubernetes (namespace: `netbird`) on the Talos cluster.
- Management, Signal, Relay, and Dashboard are all K8s services
- Exposed via Traefik at various domains
- Bootstrap job runs as ArgoCD PostSync hook to set up all configuration

## Domains

| Domain | Access | Purpose |
|--------|--------|---------|
| `netbird.int.rlservers.com` | VPN-only | Dashboard (primary URL) |
| `netbird.rlservers.com` | Public | Redirects 302 → netbird.int.rlservers.com |
| `api-netbird.rlservers.com` | Public | Management API + gRPC (enrollment required) |
| `relay.netbird.rlservers.com` | Public | TURN/STUN relay |

## Network Architecture

- NetBird WireGuard IP space: `100.64.0.0/10`
- Router VM `netbird-router-vlan3` at `10.10.0.10` advertises `10.10.0.0/24` and `10.25.0.0/24`
- Subnet routes use `peer_groups=[routing-peers-vlan3]` (advertisers) + `groups=[All]` (consumers)

## Groups (8 role-based + 2 legacy)

| Group ID | Name | Purpose | Who joins |
|----------|------|---------|-----------|
| grp00000-...001 | All | Every enrolled peer | All keys |
| grp00000-...002 | routing-peers-vlan3 | Router VMs that advertise subnet routes | infrastructure-key |
| grp00000-...003 | infrastructure | Router + runner VMs | infrastructure-key |
| grp00000-...004 | ci-runners | CI/CD runner VMs | ci-runner-key |
| grp00000-...005 | platform-admins | Admin devices (remon) | admin-client-key |
| grp00000-...006 | platform-users | Regular devices | user-client-key |
| grp00000-...007 | internal-services-admin | Resource group: admin-only services | n/a |
| grp00000-...008 | internal-services-all | Resource group: all-user services | n/a |

Legacy groups (pre-existing, kept for compatibility): `Admin`, `cluster-only`

## Setup Keys (4 role-based)

| Key | Auto-groups | Used by |
|-----|-------------|---------|
| `infrastructure-key` | All, routing-peers-vlan3, infrastructure | Router VM (10.10.0.10) |
| `ci-runner-key` | All, ci-runners | Runner VMs (10.10.0.118) |
| `admin-client-key` | All, platform-admins | Admin devices (remon's PC/phone) |
| `user-client-key` | All, platform-users | Regular devices |

**Key management**: ci-runner-key, admin-client-key, user-client-key are created via the
NetBird management API by `ensure-keys.py` in the bootstrap job. Key values are stored
in the `netbird-setup-keys` Kubernetes secret (NOT managed by ESO — separate from `netbird-secrets`).
This is idempotent: on re-runs, keys are kept if prefix still matches stored value.

**infrastructure-key value** = `SETUP_KEY` from OpenBao (via SQLite direct write — backward compatible with router VM).

**`netbird-setup-keys` secret** (namespace: netbird):
- `CI_RUNNER_KEY`, `ADMIN_CLIENT_KEY`, `USER_CLIENT_KEY`
- Created fresh on every full redeploy; bootstrap re-creates keys if secret is missing
- NOT owned by ExternalSecretOperator (separate from `netbird-secrets` which ESO owns)

## Access Policies (5 policies)

| Policy | Source → Destination | Protocol |
|--------|---------------------|----------|
| Default | All → All | all (migration compat) |
| admin-full-access | platform-admins ↔ All | all |
| user-subnet-access | platform-users → routing-peers-vlan3 | all |
| infra-to-all | infrastructure ↔ All | all |
| ci-runner-mgmt | ci-runners → infrastructure | TCP 22, 443 |

## Bootstrap Job

`kubernetes/platform/netbird/manifests/bootstrap-job.yaml`

Runs on every ArgoCD PostSync. Steps:
1. SQLite section (management scaled to 0): creates groups, keys, policies, routes
2. API section (management running): classifies connected peers into correct groups
   - Router peers (name contains 'netbird-router') → routing-peers-vlan3 + infrastructure
   - Runner peers (name contains 'runner'/'github-actions') → ci-runners + infrastructure
3. DNS nameservers: prod.local, rlservers.com, int.rlservers.com → CoreDNS (10.10.0.201)

## Key Secrets (in OpenBao, surfaced via ExternalSecret)

- `SETUP_KEY` — main infrastructure setup key
- `datastore-enc-key` — AES-256-GCM key for SQLite field encryption
- `netbird-pat-token` — PAT for admin API access (linked to 'remon' user)
- `TURN_PASSWORD` — TURN relay credential

## Post-Redeploy Checklist (automated)

After any full redeploy, the bootstrap job handles:
- Creates all 8 groups in NetBird SQLite (management scaled to 0)
- Creates infrastructure-key in SQLite
- Creates ci-runner-key, admin-client-key, user-client-key via API → saves to `netbird-setup-keys`
- Classifies connected peers into correct groups (router → routing-peers-vlan3, runner → ci-runners)
- Sets DNS nameservers for internal domains

**Manual post-redeploy steps** (not yet automated):
- Re-enroll runner: `netbird up --management-url https://api-netbird.rlservers.com:443 --setup-key <CI_RUNNER_KEY>`
- PC/phone must re-enroll with admin-client-key or user-client-key from `netbird-setup-keys`

## Known Issues / Gotchas

- **bootstrap OutOfSync fix (2026-05)**: `kubernetes/platform/external-dns/application.yaml` was
  causing platform-apps ApplicationSet to generate a duplicate `platform-external-dns` app
  (with ServerSideApply=true), conflicting with bootstrap's standalone `app-external-dns-helm.yaml`.
  Fixed by renaming to `application.yaml.standalone-managed`. Do NOT re-enable it.
  
- **ESO overwrites patches**: `netbird-secrets` is owned by ESO (creationPolicy: Owner).
  Any `kubectl patch` to it will be reverted at next ESO reconciliation.
  Use the separate `netbird-setup-keys` secret for API-generated key values.

- **Bootstrap PostSync hook**: Only runs when ArgoCD triggers a sync and detects changes.
  For manual testing: `kubectl apply -f kubernetes/platform/netbird/manifests/bootstrap-job.yaml`
  (then delete old job first: `kubectl -n netbird delete job netbird-bootstrap`)
