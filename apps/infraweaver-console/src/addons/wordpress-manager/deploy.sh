#!/usr/bin/env bash
# Deploy the WordPress Manager addon. Run from the infraweaver-console app root.
# This ships the addon as part of the console image — there is no separate
# service. It assumes the required environment (see README.md) is already set on
# the console Deployment and that kubectl + docker target the live cluster/registry.
set -euo pipefail

NAMESPACE="${WORDPRESS_NAMESPACE:-wordpress}"
ZOT="${ZOT_REGISTRY:?set ZOT_REGISTRY, e.g. zot.example.com/infraweaver-console}"
TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
CONSOLE_DEPLOYMENT="${CONSOLE_DEPLOYMENT:-infraweaver-console}"
CONSOLE_NAMESPACE="${CONSOLE_NAMESPACE:-infraweaver}"
CONSOLE_CONTAINER="${CONSOLE_CONTAINER:-console}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The console app root is three levels up (src/addons/wordpress-manager). Resolve
# and cd there so tests, typecheck, and the docker build context are correct no
# matter where the script was invoked from.
app_root="$(cd "${here}/../../.." && pwd)"
if [[ ! -f "${app_root}/package.json" || ! -f "${app_root}/Dockerfile" ]]; then
  echo "error: expected the console app root with package.json + Dockerfile at ${app_root}" >&2
  exit 1
fi
cd "${app_root}"

echo "==> 1/5 unit tests (pure core must be green before shipping)"
npx jest tests/unit/wordpress-manager

echo "==> 2/5 typecheck"
npx tsc --noEmit -p tsconfig.json

echo "==> 3/5 ensure namespace + PodSecurity labels"
kubectl apply -f "${here}/k8s/namespace.yaml"

echo "==> 4/5 build and push the console image to Zot"
docker build -t "${ZOT}:${TAG}" .
docker push "${ZOT}:${TAG}"

echo "==> 5/5 roll the console to the new image"
kubectl -n "${CONSOLE_NAMESPACE}" set image "deployment/${CONSOLE_DEPLOYMENT}" \
  "${CONSOLE_CONTAINER}=${ZOT}:${TAG}"
kubectl -n "${CONSOLE_NAMESPACE}" rollout status "deployment/${CONSOLE_DEPLOYMENT}"

echo "Done. Enable the 'wordpress-manager' addon in console settings, then visit /wordpress."
echo "Namespace: ${NAMESPACE}  Image: ${ZOT}:${TAG}"
