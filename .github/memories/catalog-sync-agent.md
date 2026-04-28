---
title: catalog-sync-agent
description: Instructs homelab-iac-agent to consult and update the repository catalog.jsonl when new knowledge is discovered.
---

# Catalog Sync Agent Memory

- File paths:
  - .github/catalog.jsonl
  - .github/InfraWeaver-platform-full.txt
- Decision: The Homelab IaC agent should prioritize consulting the local catalog files for repository knowledge and update them when it learns new facts about the codebase or runtime. Updates must be surgical and append-only when possible.
- Why it matters: Keeps repository-level knowledge centralized and machine-readable for future agents. Ensures consistent single source of truth.
- Validation or evidence:
  - /home/runner/platform/.github/catalog.jsonl exists and is used for indexing.
  - Previous scans produced detailed indexes and summaries.
- Related scripts, playbooks, workflows, or tools:
  - .github/workflows/*tofu*.yml - terraform/automation flows that may change generated artifacts
  - scripts/get-kubeconfig.sh - depends on generated files referenced in the catalog
- User correction or lesson learned: User requested agent always consult and update catalogs; this memory formalizes that behavior.
