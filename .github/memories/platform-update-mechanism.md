# Platform Update Mechanism

## Architecture
- **Version source**: GitHub API (api.github.com) — public repo, no auth needed for GET
- **CI trigger**: GitHub Actions `workflow_dispatch` (requires GITHUB_TOKEN PAT)
- **GitOps**: ArgoCD reads from internal Onedev, `origin = https://admin:...@onedev.rlservers.com/InfraWeaver-platform`
- **Apply update**: `POST /api/v1/platform/update` rewrites image tags in Onedev manifests → ArgoCD hard-refresh

## GitHub Repository
- URL: `https://github.com/Werewolf-p/InfraWeaver-platform`
- Status: Public, populated. No releases yet (first release = v0.1.0)
- GitHub Actions CI: `.github/workflows/release.yml` — builds 3 images → ghcr.io on push/tag

## API Endpoints (`apps/infraweaver-api/src/routes/platform.ts`)
- `GET /api/v1/platform/version` — returns currentVersion, latestVersion, updateAvailable, changelog
- `POST /api/v1/platform/update` — rewrites manifest image tags, triggers ArgoCD sync
- `POST /api/v1/platform/trigger-ci` — dispatches GitHub Actions workflow (needs GITHUB_TOKEN)
- `GET /api/v1/platform/workflow/:runId` — polls GitHub Actions run status

## Environment Variables (API pod)
- `APP_VERSION` — set from manifest, e.g. `main-5ced2e5`. Read by GET /version
- `GITHUB_TOKEN` — from `infraweaver-console-secret.github-token` (optional; enables CI trigger)
- `GITHUB_REPO` — `Werewolf-p/InfraWeaver-platform`
- `ARGOCD_TOKEN` — from `infraweaver-console-secret.argocd-token`

## Image Tags Format
- Manual builds (init VM): `onedev.rlservers.com/infraweaver-platform/infraweaver-{app}:main-{8-char-sha}`
- GitHub CI: `ghcr.io/werewolf-p/infraweaver-{app}:v{semver}` or `main-{sha}`

## Important Notes
- buildah/Alpine segfaults when running npm ci / tsc inside container on init VM
- Workaround: pre-build on host, use `Dockerfile.prebuilt` (copies pre-built artifacts)
- `apps/infraweaver-api/dist/` and `apps/infraweaver-node/dist/` are gitignored (built locally, not committed)
- To push GitHub update: `git push github main` (if github remote is set up with PAT)
- ArgoCD self-heal is ON — manual kubectl edits are reverted within 3 minutes
- To force re-apply: `kubectl apply -f <manifest>` then wait for ArgoCD self-heal to confirm

## Current Status (2026-05-24)
- API: main-5ced2e5 deployed ✅
- Console: main-5ced2e5 deployed ✅
- GITHUB_TOKEN: empty (CI trigger disabled; GET /version works without it)
- No GitHub releases yet — set GITHUB_PAT and push a v0.1.0 tag to enable update detection
