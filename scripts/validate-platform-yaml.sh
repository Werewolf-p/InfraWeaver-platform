#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/validate-platform-yaml.sh — Validate platform.yaml catalog references
#
# Checks:
#   1. All enabled apps have a catalog directory with catalog.yaml
#   2. No orphaned catalog entries reference non-existent directories
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_NAME="validate-platform-yaml"
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ERRORS=0
CATALOG_DIR="kubernetes/catalog"
PLATFORM_FILE="platform.yaml"

if [[ ! -f "$PLATFORM_FILE" ]]; then
  echo "ERROR: $PLATFORM_FILE not found"
  exit 1
fi

echo "==> Validating $PLATFORM_FILE..."

# Parse enabled apps from platform.yaml
ENABLED_APPS=$(python3 -c "
import yaml, sys
data = yaml.safe_load(open('$PLATFORM_FILE'))
catalog = data.get('catalog', {})
# Support: catalog.enabled list, catalog dict of bools, or bare list
if isinstance(catalog, list):
    for app in catalog:
        print(app)
elif isinstance(catalog, dict):
    enabled_list = catalog.get('enabled', None)
    if enabled_list is not None:
        for app in enabled_list:
            print(app)
    else:
        for app, cfg in catalog.items():
            enabled = cfg if isinstance(cfg, bool) else cfg.get('enabled', False)
            if enabled:
                print(app)
")

MISSING=0
for app in $ENABLED_APPS; do
  if [[ ! -d "$CATALOG_DIR/$app" ]]; then
    echo "  ❌ Enabled app '$app' has no catalog directory: $CATALOG_DIR/$app/"
    MISSING=$((MISSING + 1))
    ERRORS=$((ERRORS + 1))
  elif [[ ! -f "$CATALOG_DIR/$app/catalog.yaml" ]]; then
    echo "  ⚠️  App '$app' catalog dir exists but missing catalog.yaml"
    ERRORS=$((ERRORS + 1))
  else
    echo "  ✅ $app"
  fi
done

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "❌ platform.yaml validation failed: $ERRORS error(s)"
  exit 1
fi

echo "✅ platform.yaml validation passed ($( echo "$ENABLED_APPS" | wc -w ) apps checked)"


# ── Validate groups: section ──────────────────────────────────────────────────
echo ""
echo "==> Validating groups: section..."

python3 - <<'PYEOF'
import yaml, sys, os

PLATFORM_FILE = 'platform.yaml'
KUBERNETES_DIR = 'kubernetes'
errors = 0

with open(PLATFORM_FILE) as f:
    data = yaml.safe_load(f)

groups = data.get('groups', {})
if not groups:
    print("  ℹ  No groups: section found (skipping)")
    sys.exit(0)

for group_name, group_cfg in groups.items():
    if group_cfg is None:
        print(f"  ❌ Group '{group_name}' is null/empty")
        errors += 1
        continue

    if 'enabled' not in group_cfg:
        print(f"  ❌ Group '{group_name}' missing required 'enabled:' key")
        errors += 1
    elif not isinstance(group_cfg['enabled'], bool):
        print(f"  ❌ Group '{group_name}' enabled: must be a boolean (true/false)")
        errors += 1

    tier = group_name[len('core-'):] if group_name.startswith('core-') else group_name
    apps = group_cfg.get('apps', {}) or {}

    for app_name, app_cfg in apps.items():
        if app_cfg is None:
            app_cfg = {}
        replicas = app_cfg.get('replicas')
        if replicas is not None:
            try:
                r = int(replicas)
                if r < 1:
                    raise ValueError
            except (ValueError, TypeError):
                print(f"  ❌ Group '{group_name}' app '{app_name}' replicas must be a positive integer, got: {replicas!r}")
                errors += 1
                continue
        app_dir = os.path.join(KUBERNETES_DIR, tier, app_name)
        if not os.path.isdir(app_dir):
            print(f"  ⚠  Group '{group_name}' app '{app_name}' has no directory {app_dir}/ (may be bootstrap-only)")
        else:
            rep_str = f" (replicas: {replicas})" if replicas else ""
            print(f"  ✅ {group_name}/{app_name}{rep_str}")

if errors > 0:
    print(f"\n❌ groups: validation failed: {errors} error(s)")
    sys.exit(1)
else:
    print(f"✅ groups: validation passed")
PYEOF
GROUPS_EXIT=$?
if [[ $GROUPS_EXIT -ne 0 ]]; then
  ERRORS=$((ERRORS + 1))
fi
