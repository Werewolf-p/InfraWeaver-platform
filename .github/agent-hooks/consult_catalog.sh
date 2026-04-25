#!/usr/bin/env bash
# consult_catalog.sh - agent hook to ensure catalog is present and loadable
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="/home/runner/.copilot/session-state/helpers/catalog_sync.sh"
if [ -x "$HELPER" ]; then
  status=$($HELPER check "$REPO_ROOT")
  if [ "$status" = "OK" ]; then
    echo "catalog: OK"
  else
    echo "catalog: $status"
  fi
else
  echo "helper missing"
fi
