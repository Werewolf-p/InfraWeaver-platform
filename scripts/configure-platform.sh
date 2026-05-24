#!/usr/bin/env bash
# configure-platform.sh — sync .env feature flags to platform.yaml + route manifests
#
# Called by deploy-local.sh before deployment to ensure platform.yaml and
# Traefik route manifests reflect the feature choices in .env.
#
# Reads from .env:
#   ENABLE_NETBIRD      true|false  (default: false)
#   ENABLE_MONITORING   true|false  (default: false)
#   ENABLE_EXTERNAL_DNS true|false  (default: false)
#   BACKUP_PROVIDER     none|longhorn|velero|both  (default: longhorn)
#   ENABLE_LONGHORN     true|false  (default: true)
#   ENABLE_KYVERNO      true|false  (default: true)
#
# Effects:
#   1. platform.yaml  — sets groups.core-platform.apps.<app>.enabled flags
#   2. Traefik routes — switches private routes between netbird-vpn-only and internal-only
#   3. bootstrap/     — companion .disabled files managed (via sync-groups.sh)
#   4. core apps      — renames application.yaml ↔ application.yaml.disabled for
#                       optional core components (longhorn, kyverno)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Allow override via environment variable (useful for testing)
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env}"
PLATFORM_YAML="${PLATFORM_YAML:-${REPO_DIR}/platform.yaml}"
VPN_ROUTES="${REPO_DIR}/kubernetes/platform/external-routes/manifests/10-routes-vpn-only.yaml"
MIDDLEWARES_FILE="${REPO_DIR}/kubernetes/platform/external-routes/manifests/01-middlewares.yaml"

# ── Read .env ──────────────────────────────────────────────────────────────
_env_val() {
    local key="$1" default="${2:-}"
    if [[ -f "$ENV_FILE" ]]; then
        local val
        val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
        echo "${val:-$default}"
    else
        echo "$default"
    fi
}

ENABLE_NETBIRD=$(_env_val ENABLE_NETBIRD "false")
ENABLE_MONITORING=$(_env_val ENABLE_MONITORING "false")
ENABLE_EXTERNAL_DNS=$(_env_val ENABLE_EXTERNAL_DNS "false")
BACKUP_PROVIDER=$(_env_val BACKUP_PROVIDER "longhorn")
LOCAL_IP_RANGES=$(_env_val LOCAL_IP_RANGES "")
ENABLE_LONGHORN=$(_env_val ENABLE_LONGHORN "true")
ENABLE_KYVERNO=$(_env_val ENABLE_KYVERNO "true")
ENABLE_GRAFANA=$(_env_val ENABLE_GRAFANA "false")
ENABLE_LOKI=$(_env_val ENABLE_LOKI "true")
ENABLE_AUTHENTIK_LDAP=$(_env_val ENABLE_AUTHENTIK_LDAP "true")
# MONITORING_STACK: which Prometheus-compatible stack to use when ENABLE_MONITORING=true
#   kube-prometheus-stack  — default, full-featured, ~600Mi RAM
#   victoria-metrics       — lightweight PromQL-compatible alternative, ~280Mi RAM
MONITORING_STACK=$(_env_val MONITORING_STACK "kube-prometheus-stack")

echo "==> configure-platform: syncing feature flags to platform.yaml"
echo "    ENABLE_NETBIRD=${ENABLE_NETBIRD}"
echo "    ENABLE_MONITORING=${ENABLE_MONITORING}"
echo "    MONITORING_STACK=${MONITORING_STACK}"
echo "    ENABLE_EXTERNAL_DNS=${ENABLE_EXTERNAL_DNS}"
echo "    BACKUP_PROVIDER=${BACKUP_PROVIDER}"
echo "    LOCAL_IP_RANGES=${LOCAL_IP_RANGES:-<empty>}"
echo "    ENABLE_LONGHORN=${ENABLE_LONGHORN}"
echo "    ENABLE_KYVERNO=${ENABLE_KYVERNO}"
echo "    ENABLE_GRAFANA=${ENABLE_GRAFANA}"
echo "    ENABLE_LOKI=${ENABLE_LOKI}"
echo "    ENABLE_AUTHENTIK_LDAP=${ENABLE_AUTHENTIK_LDAP}"

# ── Helper: update a platform.yaml value using Python ───────────────────────
_set_platform_flag() {
    # Usage: _set_platform_flag "groups.core-platform.apps.netbird.enabled" "true"
    local key_path="$1" value="$2"
    python3 - <<EOF
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)  # Skip if PyYAML not available

path = "${PLATFORM_YAML}"
with open(path) as f:
    content = f.read()

# Simple line-based replacement for nested YAML keys
# This is more reliable than full YAML round-trip (preserves comments)
key_parts = "${key_path}".split(".")
leaf_key = key_parts[-1]

# Build the value representation
val = "${value}"
if val in ("true", "false"):
    yaml_val = val
else:
    yaml_val = '"' + val + '"'

import re

# For simple patterns like "groups.core-platform.apps.<app>.enabled"
# Match: indented "enabled: <value>" lines under the app key
# This is done by finding the app name first then the enabled flag
# Strategy: find block for the key path and update

# Try direct key: value pattern (works for top-level or simple structures)
# We'll use a regex that matches the key at any indentation
pattern = r'^(\s*)' + re.escape(leaf_key) + r':\s*\S.*$'
found = False
lines = content.split('\n')

# Find the right context for the key path
# Walk through parts to find the right indentation level
if len(key_parts) >= 2:
    parent_key = key_parts[-2]
    lines_out = []
    in_parent = False
    replaced = False
    parent_indent = -1
    
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        
        if not replaced and re.match(r'\s*' + re.escape(parent_key) + r':', line):
            in_parent = True
            parent_indent = indent
            lines_out.append(line)
            continue
        
        if in_parent and not replaced:
            # Check if we've left the parent block (dedented)
            if stripped and indent <= parent_indent and not stripped.startswith('#'):
                in_parent = False
                lines_out.append(line)
                continue
            
            # Look for the leaf key
            if re.match(r'\s*' + re.escape(leaf_key) + r':', line):
                new_indent = ' ' * indent
                lines_out.append(f'{new_indent}{leaf_key}: {yaml_val}')
                replaced = True
                in_parent = False
                continue
        
        lines_out.append(line)
    
    if replaced:
        content = '\n'.join(lines_out)

with open(path, 'w') as f:
    f.write(content)

if not replaced:
    print(f"  WARNING: could not find key path ${key_path} in platform.yaml", file=sys.stderr)
else:
    print(f"  set ${key_path} = ${value}")
EOF
}

# ── Helper: regenerate internal-only middleware sourceRange ─────────────────
# Reads LOCAL_IP_RANGES from .env and rebuilds the Traefik ipAllowList.
# Always-included (not user-configurable):
#   10.244.0.0/16  — K8s pod CIDR (health probes from Gatus, liveness checks)
#   127.0.0.1/32   — Localhost
#   <node VLAN>    — K8s nodes VLAN3 (10.10.0.0/24 by default from cluster.yaml)
# Conditional (when ENABLE_NETBIRD=true):
#   100.64.0.0/10  — NetBird CGNAT (direct WireGuard peers, no masquerade)
_configure_internal_middleware() {
    local user_ranges="$1"     # comma-separated, may be empty
    local netbird_enabled="$2" # "true" or "false"
    local middlewares_file="$3"
    local node_vlan="${4:-10.10.0.0/24}"  # default VLAN3 node network

    if [[ ! -f "$middlewares_file" ]]; then
        echo "  WARNING: middlewares file not found: $middlewares_file" >&2
        return
    fi

    python3 - <<EOF
import sys, re

user_ranges_raw = "${user_ranges}"
netbird_enabled = "${netbird_enabled}" == "true"
middlewares_file = "${middlewares_file}"
node_vlan = "${node_vlan}"

# Parse user-supplied ranges (comma-separated, filter empties)
user_ranges = [r.strip() for r in user_ranges_raw.split(",") if r.strip()]

# Validate CIDR format (basic check)
import socket, struct
def is_valid_cidr(cidr):
    try:
        parts = cidr.split("/")
        if len(parts) != 2:
            return False
        socket.inet_aton(parts[0])
        prefix = int(parts[1])
        return 0 <= prefix <= 32
    except Exception:
        return False

valid_user = [r for r in user_ranges if is_valid_cidr(r)]
invalid = [r for r in user_ranges if not is_valid_cidr(r)]
if invalid:
    print(f"  WARNING: ignoring invalid CIDR(s): {invalid}", file=sys.stderr)

# Build the final sourceRange list
# Order: user ranges first (most meaningful), then system ranges
source_ranges = []

# User-configured homelab/LAN ranges
for cidr in valid_user:
    source_ranges.append((cidr, "Homelab LAN — from LOCAL_IP_RANGES in .env"))

# Always-included system ranges
source_ranges.append(("127.0.0.1/32", "Localhost"))
source_ranges.append((node_vlan, "K8s node VLAN — in-cluster traffic + health probes"))
source_ranges.append(("10.244.0.0/16", "K8s pod CIDR — health probes (Gatus, liveness, etc.)"))

# NetBird CGNAT — only when VPN is enabled
if netbird_enabled:
    source_ranges.append(("100.64.0.0/10", "NetBird CGNAT (direct WireGuard peers)"))

# Build YAML sourceRange block
range_lines = []
for cidr, comment in source_ranges:
    range_lines.append(f"      - {cidr:<20}# {comment}")
ranges_yaml = "\n".join(range_lines)

# Read current middleware file
content = open(middlewares_file).read()

# Replace the sourceRange block inside the internal-only middleware
# Pattern: find 'name: internal-only' ... 'sourceRange:' ... next '---' or next kind
pattern = r"(# Middleware: internal-only.*?sourceRange:\n)((?:      - [^\n]+\n)+)"
replacement = r"\g<1>" + ranges_yaml + "\n"
new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)

if new_content == content:
    print("  WARNING: could not find internal-only sourceRange block to replace", file=sys.stderr)
else:
    open(middlewares_file, "w").write(new_content)
    range_count = len(source_ranges)
    print(f"  internal-only middleware: {range_count} sourceRange entries")
    for cidr, comment in source_ranges:
        print(f"    + {cidr}  ({comment})")

# Also update the comment at the top of the middleware
EOF
}

_set_platform_flag "groups.core-platform.apps.netbird.enabled" "$ENABLE_NETBIRD"

# Update Traefik routes: switch private routes between netbird-vpn-only and internal-only
# The file 10-routes-vpn-only.yaml is the source of truth for VPN-tier private routes.
# When NetBird is disabled, routes fall back to internal-only (LAN-accessible from homelab).
# The access-tier: vpn LABEL is preserved regardless — it reflects the policy intent.
if [[ -f "$VPN_ROUTES" ]]; then
    if [[ "$ENABLE_NETBIRD" == "true" ]]; then
        echo "  NetBird enabled → private routes use netbird-vpn-only middleware"
        # Replace any internal-only fallback back to netbird-vpn-only
        # Only in route middleware references (not in comments or other contexts)
        python3 -c "
import re, sys
content = open('$VPN_ROUTES').read()
# Replace only middleware name references (indented list items)
content = re.sub(r'(\s+- name: )internal-only\b', r'\1netbird-vpn-only', content)
open('$VPN_ROUTES', 'w').write(content)
print('  routes: netbird-vpn-only')
"
    else
        echo "  NetBird disabled → private routes fall back to internal-only middleware"
        python3 -c "
import re, sys
content = open('$VPN_ROUTES').read()
# Replace netbird-vpn-only middleware references with internal-only fallback
content = re.sub(r'(\s+- name: )netbird-vpn-only\b', r'\1internal-only', content)
open('$VPN_ROUTES', 'w').write(content)
print('  routes: internal-only (fallback)')
"
    fi
fi

# ── 2. Monitoring ────────────────────────────────────────────────────────────
_set_platform_flag "groups.core-monitoring.enabled" "$ENABLE_MONITORING"

# ── 3. External DNS ──────────────────────────────────────────────────────────
_set_platform_flag "groups.core-platform.apps.external-dns.enabled" "$ENABLE_EXTERNAL_DNS"

# ── 4. Backup provider ───────────────────────────────────────────────────────
case "$BACKUP_PROVIDER" in
    velero)
        _set_platform_flag "groups.core-platform.apps.velero.enabled" "true"
        _set_platform_flag "groups.core-platform.apps.minio-velero.enabled" "true"
        _set_platform_flag "backup.provider" "velero"
        echo "  Backup: velero + minio-velero enabled"
        ;;
    both)
        _set_platform_flag "groups.core-platform.apps.velero.enabled" "true"
        _set_platform_flag "groups.core-platform.apps.minio-velero.enabled" "true"
        _set_platform_flag "backup.provider" "both"
        echo "  Backup: longhorn (always on) + velero + minio-velero enabled"
        ;;
    none)
        _set_platform_flag "groups.core-platform.apps.velero.enabled" "false"
        _set_platform_flag "groups.core-platform.apps.minio-velero.enabled" "false"
        _set_platform_flag "backup.provider" "none"
        echo "  Backup: all backup providers disabled"
        ;;
    longhorn|*)
        _set_platform_flag "groups.core-platform.apps.velero.enabled" "false"
        _set_platform_flag "groups.core-platform.apps.minio-velero.enabled" "false"
        _set_platform_flag "backup.provider" "longhorn"
        echo "  Backup: velero disabled (longhorn built-in backup active)"
        ;;
esac

# ── 5. Regenerate internal-only middleware from LOCAL_IP_RANGES ──────────────
echo "==> configure-platform: regenerating internal-only Traefik middleware"
# Read K8s node network from cluster.yaml if available
NODE_VLAN="10.10.0.0/24"
CLUSTER_YAML="${REPO_DIR}/envs/productie/cluster.yaml"
if [[ -f "$CLUSTER_YAML" ]]; then
    DETECTED_VLAN=$(grep -E "^\s+cidr:" "$CLUSTER_YAML" | head -1 | awk '{print $2}' | tr -d '"' || true)
    if [[ -n "$DETECTED_VLAN" ]]; then
        NODE_VLAN="$DETECTED_VLAN"
        echo "  Node VLAN from cluster.yaml: ${NODE_VLAN}"
    fi
fi

if [[ -n "$LOCAL_IP_RANGES" ]]; then
    echo "  User ranges: ${LOCAL_IP_RANGES}"
else
    echo "  LOCAL_IP_RANGES is empty — only system ranges will be allowed for internal tier"
fi

_configure_internal_middleware "$LOCAL_IP_RANGES" "$ENABLE_NETBIRD" "$MIDDLEWARES_FILE" "$NODE_VLAN"

# ── 6. Optional core components (Longhorn, Kyverno) ──────────────────────────
# These apps live in kubernetes/core/ and are picked up by appset-core.yaml.
# When disabled, their application.yaml is renamed to application.yaml.disabled
# so the ApplicationSet glob skips them and ArgoCD stops managing them.
_toggle_core_app() {
    local app_name="$1" enabled="$2"
    local app_yaml="${REPO_DIR}/kubernetes/core/${app_name}/application.yaml"
    local app_yaml_disabled="${app_yaml}.disabled"
    if [[ "$enabled" == "false" ]]; then
        if [[ -f "$app_yaml" ]]; then
            mv "$app_yaml" "$app_yaml_disabled"
            echo "  ⏸  core/${app_name}: disabled (application.yaml → .disabled)"
        else
            echo "  ⏭  core/${app_name}: already disabled"
        fi
    else
        if [[ -f "$app_yaml_disabled" && ! -f "$app_yaml" ]]; then
            mv "$app_yaml_disabled" "$app_yaml"
            echo "  ▶  core/${app_name}: enabled (application.yaml restored)"
        else
            echo "  ⏭  core/${app_name}: already enabled"
        fi
    fi
}

# Also toggle companion bootstrap files that depend on the core app
_toggle_bootstrap_companion() {
    local fname="$1" enabled="$2"
    local active="${REPO_DIR}/kubernetes/bootstrap/${fname}"
    local disabled="${active}.disabled"
    if [[ "$enabled" == "false" ]]; then
        if [[ -f "$active" ]]; then
            mv "$active" "$disabled"
            echo "  ⏸  bootstrap/${fname}: disabled"
        fi
    else
        if [[ -f "$disabled" && ! -f "$active" ]]; then
            mv "$disabled" "$active"
            echo "  ▶  bootstrap/${fname}: restored"
        fi
    fi
}

echo "==> configure-platform: toggling optional core apps"

_toggle_core_app "longhorn" "$ENABLE_LONGHORN"
_toggle_bootstrap_companion "app-longhorn-manifests.yaml" "$ENABLE_LONGHORN"

_toggle_core_app "kyverno" "$ENABLE_KYVERNO"
_toggle_bootstrap_companion "core-kyverno-policies.yaml" "$ENABLE_KYVERNO"

# ── 6a-ii. Optional platform apps (kubernetes/platform/) ─────────────────────
# Same rename toggle as _toggle_core_app but for the platform/ tier.
_toggle_platform_app() {
    local app_name="$1" enabled="$2"
    local app_yaml="${REPO_DIR}/kubernetes/platform/${app_name}/application.yaml"
    local app_yaml_disabled="${app_yaml}.disabled"
    if [[ "$enabled" == "false" ]]; then
        if [[ -f "$app_yaml" ]]; then
            mv "$app_yaml" "$app_yaml_disabled"
            echo "  ⏸  platform/${app_name}: disabled (application.yaml → .disabled)"
        else
            echo "  ⏭  platform/${app_name}: already disabled"
        fi
    else
        if [[ -f "$app_yaml_disabled" && ! -f "$app_yaml" ]]; then
            mv "$app_yaml_disabled" "$app_yaml"
            echo "  ▶  platform/${app_name}: enabled (application.yaml restored)"
        else
            echo "  ⏭  platform/${app_name}: already enabled"
        fi
    fi
}

_set_platform_flag "groups.core-platform.apps.grafana.enabled" "$ENABLE_GRAFANA"
_toggle_platform_app "grafana" "$ENABLE_GRAFANA"

# Authentik LDAP outpost — managed as bootstrap companion, not AppSet
_set_platform_flag "groups.core-platform.apps.authentik-ldap-outpost.enabled" "$ENABLE_AUTHENTIK_LDAP"
_toggle_bootstrap_companion "app-authentik-ldap.yaml" "$ENABLE_AUTHENTIK_LDAP"

# ── 6b. Monitoring stack selection (kube-prometheus-stack vs victoria-metrics) ─
# Toggle which monitoring application.yaml is active under kubernetes/monitoring/.
# Only has effect when ENABLE_MONITORING=true.
_toggle_monitoring_stack() {
    local stack="$1"   # "kube-prometheus-stack" or "victoria-metrics"
    local mon_dir="${REPO_DIR}/kubernetes/monitoring"
    local stacks=("kube-prometheus-stack" "victoria-metrics")
    for s in "${stacks[@]}"; do
        local active="${mon_dir}/${s}/application.yaml"
        local disabled="${mon_dir}/${s}/application.yaml.disabled"
        if [[ "$s" == "$stack" ]]; then
            if [[ -f "$disabled" && ! -f "$active" ]]; then
                mv "$disabled" "$active"
                echo "  ▶  monitoring/${s}: enabled (application.yaml restored)"
            else
                echo "  ⏭  monitoring/${s}: already active"
            fi
        else
            if [[ -f "$active" ]]; then
                mv "$active" "$disabled"
                echo "  ⏸  monitoring/${s}: disabled (application.yaml → .disabled)"
            else
                echo "  ⏭  monitoring/${s}: already inactive"
            fi
        fi
    done
}

# Toggle an individual app within kubernetes/monitoring/ (Loki, etc.)
_toggle_monitoring_app() {
    local app_name="$1" enabled="$2"
    local app_yaml="${REPO_DIR}/kubernetes/monitoring/${app_name}/application.yaml"
    local app_yaml_disabled="${app_yaml}.disabled"
    if [[ "$enabled" == "false" ]]; then
        if [[ -f "$app_yaml" ]]; then
            mv "$app_yaml" "$app_yaml_disabled"
            echo "  ⏸  monitoring/${app_name}: disabled (application.yaml → .disabled)"
        else
            echo "  ⏭  monitoring/${app_name}: already disabled"
        fi
    else
        if [[ -f "$app_yaml_disabled" && ! -f "$app_yaml" ]]; then
            mv "$app_yaml_disabled" "$app_yaml"
            echo "  ▶  monitoring/${app_name}: enabled (application.yaml restored)"
        else
            echo "  ⏭  monitoring/${app_name}: already enabled"
        fi
    fi
}

if [[ "$ENABLE_MONITORING" == "true" ]]; then
    echo "==> configure-platform: selecting monitoring stack: ${MONITORING_STACK}"
    _toggle_monitoring_stack "$MONITORING_STACK"
fi

# Loki is toggled independently of the stack choice
_toggle_monitoring_app "loki" "$ENABLE_LOKI"

# ── 7. Run sync-groups.sh to sync AppSet and companion files ─────────────────
if [[ -f "${REPO_DIR}/scripts/sync-groups.sh" ]]; then
    echo "==> Syncing ArgoCD appsets and companion bootstrap files..."
    bash "${REPO_DIR}/scripts/sync-groups.sh"
fi

echo "==> configure-platform: done"
