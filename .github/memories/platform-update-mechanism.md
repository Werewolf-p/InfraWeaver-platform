# Platform Update Mechanism

## Architecture
Two-part update system:

### Developer Side (CI Pipeline)
- `.onedev-buildspec.yml` in repo root defines Onedev CI
- On push to `main`: build API + console + node images with buildah
- Tags: `<registry>/<app>:main-<short-sha>` (e.g. `main-99607ed`)
- Pushes to `onedev.rlservers.com/infraweaver-platform/`
- Updates image tags in `kubernetes/catalog/*/manifests/deployment.yaml`
- Commits updated tags → ArgoCD auto-deploys

### Manual Build (until CI agent configured)
- Build on init VM: `buildah build -f apps/<app>/Dockerfile.prebuilt --tag <registry>/<app>:main-<sha>`
- Dockerfile.prebuilt: skips tsc inside container (uses pre-built dist/) — avoids Alpine tsc segfault
- Push: `buildah push --tls-verify=false <image>`
- Update manifest tags and commit → ArgoCD picks up automatically

### User Side (Update Manager)
- `scripts/update.sh --json`: git pull + rebuild init site if changed + structured output
- `GET /api/platform-version` on init VM (port 8080): returns current/remote SHA + changelog
- `POST /api/self-update` on init VM: triggers update.sh + restarts server.py
- `GET /api/v1/platform/version` in infraweaver-api: proxies to init VM
- `POST /api/v1/platform/update` in infraweaver-api: proxies to init VM (requires cluster:admin)
- Console: `/settings/platform` page shows version diff + Apply Update button

## Git Remote on Init VM
- Stable remote: `https://admin:<token>@onedev.rlservers.com/InfraWeaver-platform`
- Works because `/etc/hosts` has: `10.10.0.200 onedev.rlservers.com` (Traefik VIP)
- Old localhost:19311 remote still exists as `onedev` (port-forward only)

## Key Files
- `scripts/update.sh` — update script for init VM
- `scripts/init/server.py` — `_platform_version()` + enhanced `_self_update()`
- `apps/infraweaver-api/src/routes/platform.ts` — platform API route
- `apps/infraweaver-console/src/app/(dashboard)/settings/platform/page.tsx` — update UI
- `apps/infraweaver-api/Dockerfile.prebuilt` — production build without in-container tsc
- `.onedev-buildspec.yml` — CI pipeline definition

## Known Issues / Notes
- Onedev CI needs an agent with Docker/buildah configured to actually run the buildspec
- tsc segfaults inside Alpine containers on the init VM — use Dockerfile.prebuilt instead
- cp2 (talos-prod-cp2, Proxmox vmid 9301) hosts Onedev PVC (local-path) — if cp2 goes down, Onedev is unreachable
- Onedev external DNS (onedev.rlservers.com) points to Cloudflare → 503; init VM uses /etc/hosts override
- INIT_VM_URL env var in infraweaver-api deployment defaults to http://10.10.0.50:8080

## Image Tags at Last Deploy
- infraweaver-api: main-99607ed
- infraweaver-console: main-99607ed
- infraweaver-node: main-b67c090 (unchanged)
