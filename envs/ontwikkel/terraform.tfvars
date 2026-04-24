# =============================================================================
# Ontwikkel (Development) — terraform.tfvars
#
# Non-sensitive values. Sensitive values (proxmox_api_token, openbao_token,
# github_runner_token) MUST be supplied via the SOPS-decrypted
# envs/ontwikkel/secrets.sops.yaml file:
#
#   sops exec-env envs/ontwikkel/secrets.sops.yaml \
#     'tofu -chdir=terraform apply -var-file="../envs/ontwikkel/terraform.tfvars"'
#
# Or export individually:
#   export TF_VAR_proxmox_api_token="terraform@pve!platform=<uuid>"
# =============================================================================

# ---------------------------------------------------------------------------
# Cluster identity (must match cluster.yaml)
# ---------------------------------------------------------------------------
cluster_name = "infraweaver-dev"
environment  = "ontwikkel"

# ---------------------------------------------------------------------------
# Git repo for ArgoCD ApplicationSet
# ---------------------------------------------------------------------------
git_repo_url = "https://github.com/Werewolf-p/InfraWeaver-platform"
git_revision = "HEAD"

# ---------------------------------------------------------------------------
# Two-stage apply control
#
# Set to false on first apply (cluster not yet running).
# Set to true after `tofu apply -target=module.talos_cluster` completes and
# envs/ontwikkel/generated/kubeconfig has been written.
# ---------------------------------------------------------------------------
deploy_platform_bootstrap = false

# ---------------------------------------------------------------------------
# OpenBao address (non-sensitive)
# ---------------------------------------------------------------------------
openbao_address = "https://10.25.0.241:8200"
