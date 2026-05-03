#!/usr/bin/env bash
# sync-authentik-users.sh
# Idempotently syncs all users from users.yaml into Authentik group memberships.
# Called by: apply-changes.yml (incremental) + full-redeploy.yml (post-deploy).
#
# Usage: sync-authentik-users.sh <KUBECONFIG> [USERS_YAML]
#   KUBECONFIG  Path to kubeconfig file
#   USERS_YAML  Path to users.yaml (default: ./users.yaml)
#
# Prerequisites:
#   - Authentik worker pod must be ready
#   - users.yaml must be valid YAML with .users[] list
#
# Output: prints OK/WARN lines per user, exits 0 even for non-critical failures
set -euo pipefail

KB="${1:?missing KUBECONFIG}"
USERS_YAML="${2:-./users.yaml}"
KT="kubectl --kubeconfig $KB --insecure-skip-tls-verify"

if [ ! -f "$USERS_YAML" ]; then
  echo "⚠ users.yaml not found at $USERS_YAML — skipping group sync"
  exit 0
fi

# Wait for Authentik worker to be ready (up to 15 minutes)
echo "==> Waiting for Authentik worker to be ready..."
for i in $(seq 1 90); do
  READY=$($KT get deployment/authentik-worker -n authentik \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  if [ "${READY:-0}" -ge 1 ]; then
    echo "  [${i}/90] Authentik worker ready (${READY} replicas)"
    break
  fi
  echo "  [${i}/90] Waiting for authentik-worker (readyReplicas=${READY:-0})..."
  sleep 10
done

WORKER_POD=$($KT get pod -n authentik \
  -l app.kubernetes.io/component=worker \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [ -z "$WORKER_POD" ]; then
  echo "❌ Could not find Authentik worker pod"
  exit 1
fi

echo "==> Syncing users from $USERS_YAML (worker: $WORKER_POD)..."

# Build Python script from users.yaml
SYNC_PY=$(python3 -c "
import yaml, sys, json

with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)

users = config.get('users', [])
lines = [
    'from authentik.core.models import User, Group',
    '',
]

for u in users:
    username = u['username']
    groups = u.get('groups', [])
    lines.append(f'# --- {username} ---')
    for g in groups:
        lines.append(f'grp_{username}_{g.replace(\" \",\"_\").replace(\"-\",\"_\")}, _ = Group.objects.get_or_create(name={repr(g)})')
    lines.append(f'try:')
    lines.append(f'    u_{username} = User.objects.get(username={repr(username)})')
    for g in groups:
        vname = f'grp_{username}_{g.replace(\" \",\"_\").replace(\"-\",\"_\")}'
        lines.append(f'    {vname}.users.add(u_{username})')
    lines.append(f'    print(\"OK: {username} -> {\" + \", \".join(groups)}\")')
    lines.append(f'except User.DoesNotExist:')
    lines.append(f'    print(\"WARN: {username} not found in Authentik (blueprint may not have run yet)\")')
    lines.append('')

print('\n'.join(lines))
" "$USERS_YAML" 2>/dev/null)

if [ -z "$SYNC_PY" ]; then
  echo "❌ Failed to generate sync script from $USERS_YAML"
  exit 1
fi

# Wait for each user to exist (blueprint creates them async)
USERNAMES=$(python3 -c "
import yaml, sys
with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)
for u in config.get('users', []):
    print(u['username'])
" "$USERS_YAML" 2>/dev/null)

for USERNAME in $USERNAMES; do
  echo "==> Waiting for user '$USERNAME' to be created by blueprint..."
  for i in $(seq 1 30); do
    EXISTS=$($KT exec -n authentik "$WORKER_POD" -- ak shell -c \
      "from authentik.core.models import User; print('yes' if User.objects.filter(username='${USERNAME}').exists() else 'no')" \
      2>/dev/null | grep -E "^(yes|no)$" | tail -1 || echo "no")
    echo "  [${i}/30] $USERNAME exists: $EXISTS"
    [ "$EXISTS" = "yes" ] && break
    sleep 10
  done
done

# Execute the group sync
echo "==> Executing group sync..."
B64=$(echo "$SYNC_PY" | base64 -w0)
echo "$B64" | base64 -d | $KT exec -i -n authentik "$WORKER_POD" -- ak shell
echo "✅ User group sync complete"
