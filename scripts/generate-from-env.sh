#!/usr/bin/env bash
# generate-from-env.sh — Substitute ${PLACEHOLDER} variables from .env into template files.
# This replaces ALL occurrences of ${VAR_NAME} in kubernetes/ and envs/ YAML/TFVars files
# with the corresponding value from .env.
# Run this BEFORE ArgoCD bootstrap — the substituted files must be in the local git repo
# that ArgoCD watches (local Onedev, not the public GitHub template).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: .env not found at $ENV_FILE" >&2
    exit 1
fi

echo "==> generate-from-env: substituting template placeholders from .env"

# Use Python for reliable multi-variable substitution
python3 - "$ENV_FILE" "$REPO_DIR" << 'PYEOF'
import sys, os, re

env_file = sys.argv[1]
repo_dir = sys.argv[2]

# Parse .env
env_vars = {}
with open(env_file) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            k, _, v = line.partition('=')
            env_vars[k.strip()] = v.strip().strip('"\'')

# Substitute ${VAR} in a file, in-place
def process_file(path):
    try:
        with open(path) as f:
            content = f.read()
    except Exception:
        return False

    if not re.search(r'\$\{[A-Z_][A-Z0-9_]*\}', content):
        return False

    original = content

    def replace(match):
        key = match.group(1)
        return env_vars.get(key, match.group(0))

    new_content = re.sub(r'\$\{([A-Z_][A-Z0-9_]*)\}', replace, content)
    if new_content != original:
        with open(path, 'w') as f:
            f.write(new_content)
        return True
    return False

search_dirs = ['kubernetes', 'envs']
changed = 0
for search_dir in search_dirs:
    abs_dir = os.path.join(repo_dir, search_dir)
    if not os.path.isdir(abs_dir):
        continue
    for root, dirs, files in os.walk(abs_dir):
        dirs[:] = [d for d in dirs if d != 'generated']
        for fname in files:
            if fname.endswith(('.yaml', '.yml', '.tfvars')):
                fpath = os.path.join(root, fname)
                if process_file(fpath):
                    print(f"  substituted: {os.path.relpath(fpath, repo_dir)}")
                    changed += 1

print(f"==> generate-from-env: {changed} files updated")
PYEOF
