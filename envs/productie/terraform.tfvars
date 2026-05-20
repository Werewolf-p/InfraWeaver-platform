# =============================================================================
# Productie — terraform.tfvars
#
# Non-sensitive values. Sensitive values (proxmox_api_token, github_runner_token)
# are supplied via GitHub Actions Secrets.
#
#   export TF_VAR_proxmox_api_token="terraform@pve!platform=<uuid>"
# =============================================================================

# ---------------------------------------------------------------------------
# Cluster identity (must match cluster.yaml)
# ---------------------------------------------------------------------------
cluster_name = "infraweaver-prod"
environment  = "productie"

# ---------------------------------------------------------------------------
# Git repo for ArgoCD ApplicationSet
# ---------------------------------------------------------------------------
git_repo_url = "${GIT_REPO_URL}"
git_revision = "main"

# ---------------------------------------------------------------------------
# Two-stage apply control
#
# Set to false on first apply (cluster not yet running).
# Set to true after `tofu apply -target=module.talos_cluster` completes and
# envs/productie/generated/kubeconfig has been written.
# ---------------------------------------------------------------------------
deploy_platform_bootstrap = true

# ---------------------------------------------------------------------------
# OpenBao address (in-cluster via svc DNS — non-sensitive)
# ---------------------------------------------------------------------------
openbao_address = "http://openbao.openbao.svc.cluster.local:8200"

# ---------------------------------------------------------------------------
# SSH public keys for service VMs
# ---------------------------------------------------------------------------
proxmox_runner_ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFdahNZ67L4bZ75TsH8Yi62UvFAjlPBY6w0UHWvlI4HH github-runner"
proxmox_host_ssh_public_key   = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCzWo7PXpJm4UCL7Z/R/ZE+u05L1tNpVAyNdUGmYZPRrG2Cvcvrt3o5i1pg/oV5pChO9y3B8rrkBLEHA6ei42KQM5F2/6KkhCxqsTltezpcjYoOt7Nny5xwIo+F+cZnPCqSPwMVenkiic+i1iht75ByRZPGEdjj8ihso7CQUyjn9z+X5SWhrGd/EZBJVXd2Ssd3mR5mGGn3StG5Wj8NZtR7wS3aQ38w+v7RTj+G9vEluMo4ML5oSXYbPuk0IvdT/bjl0Kyutyc5YjQLmMzfa8jhK5a4wemL5yjSf+8mfYa9TytMh259iEcAUJ67x7urf8Qexa0oQZV6Dmr1mo04sJM4tWKONgFdrlga+ZMxBZLCy1mo7mCmvQ46oNSPPZkBZP2vE7x0O66SV/AlRVu3aKYLPn4IMDvVnzC4mhwAWf7+LR3B/hCevFpPSjpHmQGaRBEQGXcRtVMEQk1F0gtHX6gWtx9XMwtMNZtXwh8iDZG4thPQ60Jei0gRCZEPTHTnUzQw1BavjsOjhUsQ5gmj03YCzzBj3tYDK+HWLlxAZNbvPr5ZFpu0foKxhFGl/zxOvkk0aAUsm25Z9d0jS+xZCR+RFHsqKQyDR8mET4f34bd2gyQ89PeGJw8VkOERYBI1KhLqgQjC1sY89eveEaSr2b994v8YcH4pckiLES6r/UVeWQ== root@proxmox"
proxmox_extra_ssh_public_keys = []
