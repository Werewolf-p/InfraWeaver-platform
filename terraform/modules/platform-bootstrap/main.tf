# =============================================================================
# platform-bootstrap/main.tf
#
# Bootstraps the platform layer on top of a fresh Talos cluster:
#   1. Create the argocd namespace
#   2. Install ArgoCD via Helm (argo/argo-cd chart ~7.x)
#      - HA replicas for productie, single instance for ontwikkel
#   3. Wait briefly for ArgoCD CRDs to be registered in the API server
#   4. Create an ArgoCD AppProject scoped to this cluster
#   5. Create a platform-wide ApplicationSet using a Git directory generator
#      that points to the kubernetes/ directory of the platform repo
#
# Provider dependency: kubernetes and helm providers must be configured in the
# root module and passed to this module via the `providers` argument.
# =============================================================================

terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }
}

# ---------------------------------------------------------------------------
# ArgoCD namespace
# ---------------------------------------------------------------------------

resource "kubernetes_namespace" "argocd" {
  metadata {
    name = var.argocd_namespace

    labels = {
      "app.kubernetes.io/managed-by" = "opentofu"
      "app.kubernetes.io/part-of"    = "platform-bootstrap"
    }
  }

  lifecycle {
    # Ignore changes to labels/annotations added by ArgoCD or other controllers
    # after initial creation. Also prevents re-creation if namespace already exists
    # and was imported into state.
    ignore_changes = [metadata[0].labels, metadata[0].annotations]
  }
}

# ---------------------------------------------------------------------------
# ArgoCD Helm release
#
# HA mode (productie):
#   server.replicas = 2, applicationSet.replicas = 2
# Single mode (ontwikkel):
#   all replica counts = 1
# ---------------------------------------------------------------------------

locals {
  argocd_ha_values = {
    global = {
      # Ensure ArgoCD knows its own hostname for SSO callbacks etc.
      # Override in production with a real ingress hostname.
      domain = "argocd.${var.cluster_name}.local"
    }

    server = {
      replicas = var.ha_mode ? 2 : 1

      # Expose via ClusterIP; users port-forward or use an Ingress in front
      service = {
        type = "ClusterIP"
      }

      # Useful defaults for GitOps
      extraArgs = ["--insecure"]
    }

    applicationSet = {
      replicas = var.ha_mode ? 2 : 1
    }

    controller = {
      replicas = 1 # Application controller runs as StatefulSet; 1 is standard
    }

    repoServer = {
      replicas = var.ha_mode ? 2 : 1
    }

    redis = {
      # Single-instance Redis for ontwikkel (simple, no quorum needed)
      enabled = !var.ha_mode
    }

    redis-ha = {
      # Redis HA (3-node Sentinel) for productie — requires ha_mode=true
      # Topology: 3 Redis nodes with Sentinel for automatic failover
      enabled = var.ha_mode
    }

    configs = {
      params = {
        # Disable TLS between components inside the cluster (handled by mTLS if needed)
        "server.insecure" = "true"
      }
    }
  }
}

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = var.argocd_chart_version
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  # Render the values map to YAML and pass as a Helm values file
  values = [yamlencode(local.argocd_ha_values)]

  # ArgoCD installs can take several minutes on a fresh cluster
  timeout = 600

  # Wait for all ArgoCD pods to become Ready before proceeding
  wait          = true
  wait_for_jobs = true

  # On upgrades, allow replacing immutable resources (e.g. Jobs)
  replace = true

  depends_on = [kubernetes_namespace.argocd]
}

# ---------------------------------------------------------------------------
# Wait for ArgoCD CRDs to propagate in the API server
#
# kubernetes_manifest validates manifests against the API at plan time. The
# time_sleep gives the CRD controllers a moment to register their schemas
# after the Helm release completes, preventing spurious "CRD not found"
# errors on the first apply.
# ---------------------------------------------------------------------------

resource "time_sleep" "wait_for_argocd_crds" {
  create_duration = "30s"

  depends_on = [helm_release.argocd]
}

# ---------------------------------------------------------------------------
# ArgoCD AppProject
#
# Defines a project that:
#   - Allows any source repo
#   - Targets the local cluster (in-cluster)
#   - Permits all cluster-scoped and namespace-scoped resources
# ---------------------------------------------------------------------------

resource "kubernetes_manifest" "app_project" {
  # ArgoCD controller adds computed fields (syncWindows, roles, etc.) after creation.
  # Marking them as computed prevents the provider from producing inconsistent plan errors.
  computed_fields = [
    "metadata.annotations",
    "metadata.labels",
    "spec.syncWindows",
    "spec.roles",
    "spec.orphanedResources",
  ]

  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "AppProject"
    metadata = {
      name      = var.cluster_name
      namespace = var.argocd_namespace
      labels = {
        "app.kubernetes.io/managed-by" = "opentofu"
        "app.kubernetes.io/part-of"    = "platform-bootstrap"
      }
    }
    spec = {
      description = "Platform applications for cluster ${var.cluster_name} (${var.environment})"

      sourceRepos = ["*"]

      destinations = [
        {
          namespace = "*"
          server    = "https://kubernetes.default.svc"
          name      = "in-cluster"
        }
      ]

      # Allow all cluster-scoped resource types (CRDs, ClusterRoles, etc.)
      clusterResourceWhitelist = [
        { group = "*", kind = "*" }
      ]

      # Allow all namespace-scoped resources
      namespaceResourceWhitelist = [
        { group = "*", kind = "*" }
      ]
    }
  }

  depends_on = [time_sleep.wait_for_argocd_crds]
}

# ---------------------------------------------------------------------------
# Platform ApplicationSet
#
# Uses a Git directory generator that scans `kubernetes/<subdir>` in the
# platform repo. Each discovered directory becomes an ArgoCD Application:
#   - App name:  the directory basename (e.g. monitoring, ingress-nginx)
#   - Namespace: same as the directory basename (auto-created via syncOptions)
#   - Sync:      automated with prune and self-heal
# ---------------------------------------------------------------------------

resource "kubernetes_manifest" "platform_applicationset" {
  # ArgoCD controller mutates ApplicationSet status and template fields after creation.
  computed_fields = [
    "metadata.annotations",
    "metadata.labels",
    "status",
  ]

  # bootstrap.sh uses kubectl patch to update repoURL to Onedev — force_conflicts
  # allows OpenTofu to re-take ownership of those fields on re-apply.
  field_manager {
    force_conflicts = true
  }

  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "ApplicationSet"
    metadata = {
      name      = "platform"
      namespace = var.argocd_namespace
      labels = {
        "app.kubernetes.io/managed-by" = "opentofu"
        "app.kubernetes.io/part-of"    = "platform-bootstrap"
      }
    }
    spec = {
      # Retry failed Application syncs automatically
      syncPolicy = {
        preserveResourcesOnDeletion = false
      }

      generators = [
        {
          git = {
            repoURL  = var.git_repo_url
            revision = var.git_revision
            directories = [
              {
                # Match any first-level subdirectory of kubernetes/
                path    = "${var.kubernetes_apps_path}/*"
                exclude = false
              }
            ]
          }
        }
      ]

      template = {
        metadata = {
          # Application name derived from the directory basename
          name = "{{path.basename}}"
          labels = {
            "app.kubernetes.io/managed-by" = "argocd-applicationset"
            "platform.infraweaver/cluster" = var.cluster_name
            "platform.infraweaver/env"     = var.environment
          }
        }
        spec = {
          project = var.cluster_name

          source = {
            repoURL        = var.git_repo_url
            targetRevision = var.git_revision
            path           = "{{path}}"
          }

          destination = {
            server    = "https://kubernetes.default.svc"
            namespace = "{{path.basename}}"
          }

          syncPolicy = {
            automated = {
              prune    = true
              selfHeal = true
            }
            syncOptions = [
              "CreateNamespace=true",
              "PrunePropagationPolicy=foreground",
              "PruneLast=true",
              "ServerSideApply=true",
            ]
            retry = {
              limit = 5
              backoff = {
                duration    = "5s"
                factor      = 2
                maxDuration = "3m"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [kubernetes_manifest.app_project]
}
