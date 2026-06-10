#!/usr/bin/env bash
#
# Ephemeral preview deploy for the console feedback validation pipeline.
#
# Clones the LIVE infraweaver-console Deployment/Service into matching *-preview
# resources, and clones the LIVE Traefik IngressRoute "infraweaver-console-int"
# (in the traefik namespace) into a *-preview IngressRoute. Because it clones the
# running prod objects, the preview inherits the real serviceAccount, env,
# image-pull secret, probes, TLS cert, and middlewares without hardcoding them.
#
# The preview IngressRoute differs from prod in three ways:
#   - Host(`...`) in every route match is rewritten to PREVIEW_HOST.
#   - The backend service is repointed to the preview Service. Because the route
#     lives in the traefik namespace but the preview Service lives in PREVIEW_NS,
#     an explicit `namespace:` is added to the service ref (Traefik runs with
#     allowCrossNamespace=true, verified on-cluster).
#   - forward-auth (Authentik SSO): DROPPED by default. Authentik's embedded
#     outpost is application-scoped, not a domain-level provider for
#     *.int.example.com, so an unknown preview host gets a 404 lockout instead
#     of an SSO gate. Ephemeral previews are short-lived and internal-only, so the
#     pragmatic default is to drop the forward-auth middleware (secure-headers +
#     strip-rsc are always kept). Once a preview/wildcard Authentik application is
#     registered for the preview host, set PREVIEW_FORWARD_AUTH=true to re-gate.
#
# These resources are NOT managed by ArgoCD; they are labelled
# infraweaver.io/preview=true and removed wholesale by `down` (Deployment/Service
# in PREVIEW_NS, IngressRoute in ROUTE_NS).
#
# Usage:  DRY_RUN=1 preview.sh up <feedback-id>   # render + server-validate only
#         preview.sh up   <feedback-id>
#         preview.sh down <feedback-id>
#
# Env (with defaults):
#   PREVIEW_NS           namespace of the console        (infraweaver-console)
#   PREVIEW_IMAGE        exact image ref for the preview pod. The dispatch pipeline
#                        passes this after it has built & CONFIRMED the ghcr
#                        preview-<id> tag. If unset, the preview mirrors whatever
#                        image prod is currently running (always pullable), so a
#                        standalone/manual preview never ErrImagePulls on a tag
#                        that was never built.                       (live prod image)
#   PREVIEW_HOST         hostname for the preview route (infraweaver-console-preview.int.example.com)
#   SRC_NAME             name of the deploy/svc to clone (infraweaver-console)
#   ROUTE_NS             namespace of the IngressRoute   (traefik)
#   ROUTE_NAME           name of the IngressRoute to clone (infraweaver-console-int)
#   PREVIEW_FORWARD_AUTH keep Authentik forward-auth on the preview (false)
#   DRY_RUN              if set, apply with --dry-run=server -o yaml (render only)
#
# NOTE: assumes the live Deployment/Service are named "$SRC_NAME", the app
# container is named "console", and the IngressRoute backend port is unchanged.
# Verify on first run (kubectl -n "$PREVIEW_NS" get deploy,svc;
# kubectl -n "$ROUTE_NS" get ingressroute "$ROUTE_NAME").
set -euo pipefail

ACTION="${1:?usage: preview.sh up|down <feedback-id>}"
ID="$(printf '%s' "${2:?feedback id required}" | tr -cd 'a-zA-Z0-9._-' | cut -c1-40)"

NS="${PREVIEW_NS:-infraweaver-console}"
PREVIEW_IMAGE="${PREVIEW_IMAGE:-}"
HOST="${PREVIEW_HOST:-infraweaver-console-preview.int.example.com}"
SRC="${SRC_NAME:-infraweaver-console}"
ROUTE_NS="${ROUTE_NS:-traefik}"
ROUTE_NAME="${ROUTE_NAME:-infraweaver-console-int}"
FORWARD_AUTH="${PREVIEW_FORWARD_AUTH:-false}"
DRY_RUN="${DRY_RUN:-}"

DST="${SRC}-preview"               # preview Deployment/Service name (in NS)
DST_ROUTE="${ROUTE_NAME}-preview"  # preview IngressRoute name (in ROUTE_NS)

# apply <namespace> — pipe a manifest in; honours DRY_RUN by switching to a
# server-side dry-run that renders the resulting object instead of persisting it.
apply() {
  local ns="$1"
  if [[ -n "$DRY_RUN" ]]; then
    kubectl -n "$ns" apply --dry-run=server -o yaml -f -
  else
    kubectl -n "$ns" apply -f -
  fi
}

down() {
  kubectl -n "$NS" delete deploy,svc \
    -l infraweaver.io/preview=true --ignore-not-found
  kubectl -n "$ROUTE_NS" delete ingressroute \
    -l infraweaver.io/preview=true --ignore-not-found
}

up() {
  # Resolve the preview image. The dispatch pipeline passes PREVIEW_IMAGE
  # explicitly once it has built & confirmed the ghcr preview-<id> tag. For a
  # standalone/manual preview (no fresh build) mirror whatever image prod is
  # currently running, so the pod is always pullable instead of ErrImagePull on a
  # tag that was never built.
  local img="$PREVIEW_IMAGE"
  if [[ -z "$img" ]]; then
    img="$(kubectl -n "$NS" get deploy "$SRC" \
            -o jsonpath='{.spec.template.spec.containers[?(@.name=="console")].image}')"
    echo "note: PREVIEW_IMAGE unset — mirroring live prod image ${img}" >&2
  fi

  # Deployment — rename, repoint image, single replica, distinct selector.
  kubectl -n "$NS" get deploy "$SRC" -o json \
    | jq --arg name "$DST" --arg img "$img" '
        .metadata.name = $name
        | .metadata.labels["infraweaver.io/preview"] = "true"
        | del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp,
              .metadata.generation, .status,
              .metadata.annotations["deployment.kubernetes.io/revision"],
              .metadata.annotations["argocd.argoproj.io/tracking-id"],
              .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])
        | .spec.replicas = 1
        | .spec.selector.matchLabels.app = $name
        | .spec.template.metadata.labels.app = $name
        | (.spec.template.spec.containers[] | select(.name == "console").image) = $img
      ' \
    | apply "$NS"

  # Service — rename, repoint selector at the preview pods.
  kubectl -n "$NS" get svc "$SRC" -o json \
    | jq --arg name "$DST" '
        .metadata.name = $name
        | .metadata.labels["infraweaver.io/preview"] = "true"
        | del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp,
              .spec.clusterIP, .spec.clusterIPs, .status,
              .metadata.annotations["argocd.argoproj.io/tracking-id"],
              .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])
        | .spec.selector.app = $name
      ' \
    | apply "$NS"

  # IngressRoute — clone the live Traefik route from ROUTE_NS. Rewrite the host
  # in every route match, repoint every backend service at the preview Service
  # (cross-namespace ref into NS), and conditionally drop forward-auth.
  kubectl -n "$ROUTE_NS" get ingressroute "$ROUTE_NAME" -o json \
    | jq --arg name "$DST_ROUTE" --arg host "$HOST" --arg svc "$DST" \
         --arg ns "$NS" --arg fauth "$FORWARD_AUTH" '
        .metadata.name = $name
        | .metadata.labels["infraweaver.io/preview"] = "true"
        | del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp,
              .metadata.generation, .status,
              .metadata.annotations["argocd.argoproj.io/tracking-id"],
              .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])
        | .spec.routes |= map(
              .match |= sub("Host\\(`[^`]+`\\)"; "Host(`" + $host + "`)")
            | .services |= map(.name = $svc | .namespace = $ns)
            | (if $fauth != "true" and (.middlewares != null)
                 then .middlewares |= map(select(.name != "forward-auth"))
                 else . end)
          )
      ' \
    | apply "$ROUTE_NS"

  echo "preview up: https://${HOST} (image ${img}, forward-auth=${FORWARD_AUTH})"
}

case "$ACTION" in
  up)   up ;;
  down) down ;;
  *)    echo "usage: preview.sh up|down <feedback-id>" >&2; exit 2 ;;
esac
