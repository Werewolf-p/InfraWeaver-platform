---
title: Workflow Simplification — May 2026
description: DRY kubeconfig setup, atomic community-apps commits, updates.ts K8s-safe
---

# Workflow Simplification 2026-05

## Memory

### setup-kubectl composite action now used everywhere
- **Action**: `.github/actions/setup-kubectl`
- **Inputs**: `kubeconfig-b64` (required), `kubeconfig-fallback-b64` (optional)
- **Creates**: `~/.kube/config-platform-productie`
- **Feature**: does a connectivity test; falls back to fallback kubeconfig if primary fails
- **Rule**: ALWAYS use `actions/checkout` BEFORE this action in every job — local composite actions require the repo to be checked out first
- **Files fixed**: `apply-changes.yml` (7 jobs), `maintenance.yml` (6 jobs)
- **Do NOT convert**: `build-node.yml`, `node-rolling-update.yml`, `rollback.yml` — these have custom IP failover logic and write to `~/.kube/config` (not `config-platform-productie`)

### Community-apps atomic commit (deploy/route.ts)
- **Problem**: each file was committed via `ghPut()` in a loop → 3-6 separate commits per install → triggered `apply-changes.yml` 3-6 times per install
- **Fix**: `ghCommitAll(files, message)` uses GitHub Trees API (blobs → tree → commit → ref update) to create ONE atomic commit for all files
- **Result**: community-apps install = 1 commit, 1 workflow trigger
- **Location**: `apps/infraweaver-console/src/app/api/community-apps/deploy/route.ts`

### updates.ts — must use GitHub API, not local filesystem
- **Problem**: `updates.ts` used `execSync('git commit')` and `fs.readFile` — both fail in K8s pod (no repo on disk, no git config)
- **Fix**: 
  - `getRepoTree()` uses GitHub Trees API (`?recursive=1`) to list all `application.yaml` files (60s TTL in-memory cache)
  - `ghGetFile(path)` reads file content + SHA via GitHub Contents API
  - `ghPutFile(path, content, message, sha)` writes via Contents API PUT
- **Pattern**: same approach as `community-apps/deploy/route.ts` — use GITHUB_TOKEN + GITHUB_REPO env vars
- **Rule**: any route that reads or writes files in the platform repo MUST use the GitHub API, NOT local fs/git

### ENV_NAME anti-pattern in workflows
- **Pattern to AVOID**: `KB=~/.kube/config-platform-${{ env.ENV_NAME }}` where ENV_NAME is always "productie"
- **Pattern to USE**: `KB=~/.kube/config-platform-productie` (literal) or use `setup-kubectl` action
- **Context**: all workflows are for the single "productie" environment; the ENV_NAME variable is legacy from when multiple environments were planned
