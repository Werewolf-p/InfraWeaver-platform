---
title: agent-recommendations
description: Auto-generated recommendations for Homelab IaC agent
---
# Agent Recommendations
Generated: 2026-04-25T16:42:01Z

Detected:
- terraform: 1
- ansible: 0
- sops: 1
- workflows: 1

Recommended behavior:
- Consult .github/catalog.jsonl on init; run .github/agent-hooks/init_learn.sh if present.
- Validation: terraform validate (if terraform present), ansible-lint (if ansible present), check SOPS rules if sops present.
- Memory: update .github/memories/catalog-sync-agent.md when new facts learned.
- Append-only catalog updates; validate JSON against .github/catalog_schema.json before appending.
