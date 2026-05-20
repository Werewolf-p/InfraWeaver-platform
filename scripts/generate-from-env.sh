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
import os
import re
import sys

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
            env_vars[k.strip()] = v.strip().strip("\"'")

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

# ── Per-node defaults & PVE_NODES_MAP ────────────────────────────────────────
# Fill per-node vars from global defaults if not explicitly set in .env
for n in range(1, 4):
    p = f"NODE_{n}_"
    if not env_vars.get(f"{p}PVE_NODE"):
        env_vars[f"{p}PVE_NODE"] = env_vars.get("PROXMOX_NODE_NAME", "pve")
    if not env_vars.get(f"{p}DATASTORE"):
        env_vars[f"{p}DATASTORE"] = env_vars.get("TALOS_DATASTORE", "lvm-proxmox")
    if not env_vars.get(f"{p}CPU"):
        env_vars[f"{p}CPU"] = "4"
    if not env_vars.get(f"{p}MEMORY"):
        env_vars[f"{p}MEMORY"] = "8192"
    if not env_vars.get(f"{p}DISK"):
        env_vars[f"{p}DISK"] = "100"

# Build PVE_NODES_MAP YAML block  (  name: "ip"  per line, 2-space indent  )
pve_nodes_raw = env_vars.get("PVE_NODES", "").strip()
if not pve_nodes_raw:
    node_name   = env_vars.get("PROXMOX_NODE_NAME", "pve")
    proxmox_host = env_vars.get("PROXMOX_HOST", "")
    if proxmox_host:
        pve_nodes_raw = f"{node_name}:{proxmox_host}"
pve_map_lines = []
for entry in pve_nodes_raw.split(","):
    entry = entry.strip()
    if ":" in entry:
        n_part, ip_part = entry.split(":", 1)
        pve_map_lines.append(f'  {n_part.strip()}: "{ip_part.strip()}"')
env_vars["PVE_NODES_MAP"] = "\n".join(pve_map_lines) if pve_map_lines else "  # no pve_nodes configured"
# ─────────────────────────────────────────────────────────────────────────────

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

# Generate DNS solver spec for cert-manager
dns_provider = env_vars.get('DNS_PROVIDER', 'cloudflare').lower()
aws_region = env_vars.get('AWS_REGION', 'us-east-1')
aws_zone_id = env_vars.get('AWS_HOSTED_ZONE_ID', '')
azure_client_id = env_vars.get('AZURE_CLIENT_ID', '')
azure_sub_id = env_vars.get('AZURE_SUBSCRIPTION_ID', '')
azure_tenant_id = env_vars.get('AZURE_TENANT_ID', '')
azure_rg = env_vars.get('AZURE_RESOURCE_GROUP', '')
base_domain = env_vars.get('BASE_DOMAIN', '')
admin_email = env_vars.get('ADMIN_EMAIL', '${ADMIN_EMAIL}')

solver_specs = {
    'cloudflare': """          cloudflare:
              apiTokenSecretRef:
                name: dns-provider-credentials
                key: cloudflare-api-token""",
    'route53': f"""          route53:
              region: {aws_region}
              accessKeyIDSecretRef:
                name: dns-provider-credentials
                key: aws-access-key-id
              secretAccessKeySecretRef:
                name: dns-provider-credentials
                key: aws-secret-access-key""" + (f"\n              hostedZoneID: {aws_zone_id}" if aws_zone_id else ''),
    'azure': f"""          azuredns:
              clientID: {azure_client_id}
              clientSecretSecretRef:
                name: dns-provider-credentials
                key: azure-client-secret
              subscriptionID: {azure_sub_id}
              tenantID: {azure_tenant_id}
              resourceGroupName: {azure_rg}
              environment: AzurePublicCloud
              hostedZoneName: {base_domain}""",
    'digitalocean': """          digitalocean:
              tokenSecretRef:
                name: dns-provider-credentials
                key: do-token""",
    'hetzner': f"""          webhook:
              groupName: acme.hetzner.cloud
              solverName: hetzner
              config:
                apiKeySecretRef:
                  name: dns-provider-credentials
                  key: hetzner-api-key
                zoneName: {base_domain}""",
    'none': """          cloudflare:
              # placeholder — DNS-01 disabled, using HTTP-01 only
              apiTokenSecretRef:
                name: dns-provider-credentials
                key: cloudflare-api-token""",
}

dns_solver = solver_specs.get(dns_provider, solver_specs['cloudflare'])
issuer_template = """# Auto-generated by generate-from-env.sh — DO NOT EDIT directly
# Re-generate: bash scripts/generate-from-env.sh
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-http
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${ADMIN_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-http-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-http-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${ADMIN_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-http-staging-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${ADMIN_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-dns-account-key
    solvers:
      - dns01:
${DNS_SOLVER_SPEC}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${ADMIN_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-dns-staging-account-key
    solvers:
      - dns01:
${DNS_SOLVER_SPEC}
"""
issuer_content = issuer_template.replace('${ADMIN_EMAIL}', admin_email).replace('${DNS_SOLVER_SPEC}', dns_solver)
issuer_path = os.path.join(repo_dir, 'kubernetes/core/cert-manager/manifests/cluster-issuer.yaml')
with open(issuer_path, 'w') as f:
    f.write(issuer_content)
print(f"  ✓ Generated DNS-01 solver for provider: {dns_provider}")

print(f"==> generate-from-env: {changed} files updated")
PYEOF
