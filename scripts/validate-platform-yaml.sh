#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/validate-platform-yaml.sh — Validate platform.yaml catalog references
#
# Checks:
#   1. All enabled apps have a catalog directory with catalog.yaml
#   2. No orphaned catalog entries reference non-existent directories
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

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
