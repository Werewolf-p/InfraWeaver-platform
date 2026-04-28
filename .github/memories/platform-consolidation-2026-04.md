---
title: Platform consolidation — all services on 10.25.0.3, no pve-prod cluster
description: Moved openbao/runner/cloud-init from InfraWeaver-base to InfraWeaver-platform; 3 Talos VMs directly on 10.25.0.3
---

# Platform Consolidation — April 2026

## Memory

- **Architecture:** 3 Talos VMs (9300/9301/9302 at .90/.91/.92) + OpenBao (9200 at .86) + GitHub Runner (9100 at .85) + cloud-init template (9000) all on 10.25.0.3 (node: `proxmox`)
- **Decision:** Removed intermediate pve-prod1/2/3 Proxmox cluster (was at .80/.81/.82). Everything runs directly on 10.25.0.3.
- **Modules copied from base to platform:** `cloud-init-template`, `github-runner`, `openbao` plus `ansible/` directory
- **Why it matters:** Eliminates extra overhead of nested virtualization (Proxmox VMs running Proxmox)
- **Secrets setup:**
  - Platform `PROXMOX_API_TOKEN` = base token `Automation@pam!Token=...` (since targeting 10.25.0.3)
  - `RUNNER_REGISTRATION_TOKEN` = GitHub PAT for runner registration (GitHub blocks `GITHUB_` prefix secrets)
  - Exported as `TF_VAR_github_runner_token` in workflow
- **Base changes:** `nodes.yaml` emptied — base now only manages Proxmox host prereqs on 10.25.0.3
- **Critical gotcha:** Base uses `build-tfvars.py` to REGENERATE `nodes.auto.tfvars` from `nodes.yaml`. Editing `nodes.auto.tfvars` directly has no effect — must update `nodes.yaml`
- **Ansible:** Platform needed `ansible/` directory (Dockerfile + playbooks) since modules reference `${path.root}/../ansible/Dockerfile`
