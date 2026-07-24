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
# Matches the reference deployment's Application destination (catalog namespace
# `infraweaver-console`), which is also what the health-sweep manifests below
# pin. Override only if the console runs elsewhere.
CONSOLE_NAMESPACE="${CONSOLE_NAMESPACE:-infraweaver-console}"
CONSOLE_CONTAINER="${CONSOLE_CONTAINER:-console}"

# ── WordPress health-sweep wiring (source of the shared cron token) ───────────
# The hourly sweep CronJob and the console must present the SAME token, so it is
# read from OpenBao — the same origin ExternalSecrets syncs into the console in
# the GitOps path — rather than a committed literal. Set SKIP_HEALTH_SWEEP=1 to
# only roll the image (e.g. when OpenBao is unreachable from where you deploy).
SKIP_HEALTH_SWEEP="${SKIP_HEALTH_SWEEP:-0}"
WP_HEALTH_CRON_BAO_MOUNT="${WP_HEALTH_CRON_BAO_MOUNT:-secret}"
WP_HEALTH_CRON_BAO_PATH="${WP_HEALTH_CRON_BAO_PATH:-platform/infraweaver-console}"
WP_HEALTH_CRON_BAO_PROP="${WP_HEALTH_CRON_BAO_PROP:-wordpress-health-cron-token}"
WP_HEALTH_CRON_SECRET="${WP_HEALTH_CRON_SECRET:-wordpress-health-cron}"

# ── WordPress Manage-snapshot sweep wiring (durable cache warm) ───────────────
# The 30-min Manage sweep CronJob and the console must present the SAME token
# (the console's WORDPRESS_METRICS_CRON_TOKEN env). It is its own dedicated token,
# distinct from the health/rotation tokens, so read it from the same OpenBao origin
# ExternalSecrets projects into the console. Set SKIP_MANAGE_SWEEP=1 to skip.
SKIP_MANAGE_SWEEP="${SKIP_MANAGE_SWEEP:-0}"
WP_MANAGE_CRON_BAO_MOUNT="${WP_MANAGE_CRON_BAO_MOUNT:-secret}"
WP_MANAGE_CRON_BAO_PATH="${WP_MANAGE_CRON_BAO_PATH:-platform/infraweaver-console}"
WP_MANAGE_CRON_BAO_PROP="${WP_MANAGE_CRON_BAO_PROP:-wordpress-metrics-cron-token}"
WP_MANAGE_CRON_SECRET="${WP_MANAGE_CRON_SECRET:-wordpress-manage-cron}"

# ── WordPress Connector metrics wiring (Prometheus scrape token) ──────────────
# The ServiceMonitor scrapes /api/wordpress/metrics with a Bearer token that MUST
# match the console's WORDPRESS_METRICS_TOKEN env — sourced from the same OpenBao
# secret so they never drift. Set SKIP_METRICS=1 to skip (e.g. no Prometheus
# operator, or OpenBao unreachable). The ServiceMonitor apply is best-effort: a
# cluster without the monitoring CRDs warns instead of failing the deploy.
SKIP_METRICS="${SKIP_METRICS:-0}"
WP_METRICS_BAO_MOUNT="${WP_METRICS_BAO_MOUNT:-secret}"
WP_METRICS_BAO_PATH="${WP_METRICS_BAO_PATH:-platform/infraweaver-console}"
WP_METRICS_BAO_PROP="${WP_METRICS_BAO_PROP:-wordpress-metrics-token}"
WP_METRICS_SECRET="${WP_METRICS_SECRET:-wordpress-metrics-token}"

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

# Read a KV v2 field from OpenBao. Prefers the `bao`/`vault` CLI when present,
# else falls back to the HTTP API (curl + jq). Needs OPENBAO_ADDR + OPENBAO_TOKEN.
read_openbao_field() {
  local mount="$1" path="$2" field="$3" cli val
  : "${OPENBAO_ADDR:?set OPENBAO_ADDR, e.g. http://openbao.openbao.svc.cluster.local:8200}"
  : "${OPENBAO_TOKEN:?set OPENBAO_TOKEN with read access to ${mount}/${path}}"
  if cli="$(command -v bao || command -v vault)"; then
    BAO_ADDR="${OPENBAO_ADDR}" BAO_TOKEN="${OPENBAO_TOKEN}" \
    VAULT_ADDR="${OPENBAO_ADDR}" VAULT_TOKEN="${OPENBAO_TOKEN}" \
      "${cli}" kv get -mount="${mount}" -field="${field}" "${path}"
    return
  fi
  command -v jq >/dev/null || { echo "error: need the bao/vault CLI or jq to read OpenBao" >&2; return 1; }
  val="$(curl --fail --silent --show-error \
      -H "X-Vault-Token: ${OPENBAO_TOKEN}" \
      "${OPENBAO_ADDR}/v1/${mount}/data/${path}" \
    | jq -er ".data.data[\"${field}\"]")" \
    || { echo "error: could not read ${field} from ${mount}/${path} in OpenBao" >&2; return 1; }
  printf '%s' "${val}"
}

echo "==> 1/6 unit tests (pure core must be green before shipping)"
npx jest tests/unit/wordpress-manager

echo "==> 2/6 typecheck"
npx tsc --noEmit -p tsconfig.json

echo "==> 3/6 ensure namespace + PodSecurity labels"
kubectl apply -f "${here}/k8s/namespace.yaml"

echo "==> 4/6 build and push the console image to Zot"
docker build -t "${ZOT}:${TAG}" .
docker push "${ZOT}:${TAG}"

echo "==> 5/6 roll the console to the new image"
kubectl -n "${CONSOLE_NAMESPACE}" set image "deployment/${CONSOLE_DEPLOYMENT}" \
  "${CONSOLE_CONTAINER}=${ZOT}:${TAG}"
kubectl -n "${CONSOLE_NAMESPACE}" rollout status "deployment/${CONSOLE_DEPLOYMENT}"

if [[ "${SKIP_HEALTH_SWEEP}" == "1" ]]; then
  echo "==> 6/6 WordPress health-sweep — SKIPPED (SKIP_HEALTH_SWEEP=1)"
else
  echo "==> 6/6 wire the hourly WordPress health-sweep (cron token from OpenBao)"
  # The CronJob and the console must present the same token; source it from the
  # console's OpenBao secret so they can never drift (a committed literal never
  # matches the console's WORDPRESS_HEALTH_CRON_TOKEN env → sweep 401/403s).
  cron_token="$(read_openbao_field "${WP_HEALTH_CRON_BAO_MOUNT}" "${WP_HEALTH_CRON_BAO_PATH}" "${WP_HEALTH_CRON_BAO_PROP}")"
  kubectl -n "${CONSOLE_NAMESPACE}" create secret generic "${WP_HEALTH_CRON_SECRET}" \
    --from-literal=token="${cron_token}" --dry-run=client -o yaml \
    | kubectl -n "${CONSOLE_NAMESPACE}" apply -f -
  # Zero-trust egress/ingress for the default-denied sweep pods, then the CronJob.
  kubectl apply -f "${here}/k8s/health-sweep-netpol.yaml"
  kubectl apply -f "${here}/k8s/health-sweep-cronjob.yaml"
  echo "health sweep wired: CronJob wordpress-connector-health-sweep (0 * * * *)"
fi

if [[ "${SKIP_MANAGE_SWEEP}" == "1" ]]; then
  echo "==> Manage-snapshot sweep — SKIPPED (SKIP_MANAGE_SWEEP=1)"
else
  echo "==> wire the 30-min Manage-snapshot sweep (warms the durable cache; cron token from OpenBao)"
  # Same-origin token as the console's WORDPRESS_METRICS_CRON_TOKEN env, so the
  # sweep and the console agree (a committed literal never matches → 401/403).
  manage_token="$(read_openbao_field "${WP_MANAGE_CRON_BAO_MOUNT}" "${WP_MANAGE_CRON_BAO_PATH}" "${WP_MANAGE_CRON_BAO_PROP}")"
  kubectl -n "${CONSOLE_NAMESPACE}" create secret generic "${WP_MANAGE_CRON_SECRET}" \
    --from-literal=token="${manage_token}" --dry-run=client -o yaml \
    | kubectl -n "${CONSOLE_NAMESPACE}" apply -f -
  # No dedicated NetworkPolicy: the sweep pods carry the iwsl labels the
  # health-sweep-netpol.yaml already selects (egress to CoreDNS + console, ingress
  # to the console pod). Just apply the CronJob.
  kubectl apply -f "${here}/k8s/manage-sweep-cronjob.yaml"
  echo "manage sweep wired: CronJob wordpress-manage-snapshot-sweep (15,45 * * * *)"
fi

if [[ "${SKIP_METRICS}" == "1" ]]; then
  echo "==> Connector metrics — SKIPPED (SKIP_METRICS=1)"
else
  echo "==> wire the Connector metrics scrape (Bearer token from OpenBao)"
  # Same-origin token as the console's WORDPRESS_METRICS_TOKEN env, so Prometheus
  # and the console agree (a committed literal never matches → 401/403 scrape).
  metrics_token="$(read_openbao_field "${WP_METRICS_BAO_MOUNT}" "${WP_METRICS_BAO_PATH}" "${WP_METRICS_BAO_PROP}")"
  kubectl -n "${CONSOLE_NAMESPACE}" create secret generic "${WP_METRICS_SECRET}" \
    --from-literal=token="${metrics_token}" --dry-run=client -o yaml \
    | kubectl -n "${CONSOLE_NAMESPACE}" apply -f -
  # Best-effort: a cluster without the prometheus-operator CRDs (ServiceMonitor)
  # must not abort the deploy — the token + NetworkPolicy still apply usefully.
  if kubectl apply -f "${here}/k8s/metrics-servicemonitor.yaml"; then
    echo "metrics wired: ServiceMonitor wordpress-connector-metrics (/api/wordpress/metrics)"
  else
    echo "warn: ServiceMonitor apply failed (prometheus-operator CRDs missing?) — token/NetworkPolicy may be partial" >&2
  fi
fi

echo "Done. Enable the 'wordpress-manager' addon in console settings, then visit /wordpress."
echo "Namespace: ${NAMESPACE}  Image: ${ZOT}:${TAG}"
