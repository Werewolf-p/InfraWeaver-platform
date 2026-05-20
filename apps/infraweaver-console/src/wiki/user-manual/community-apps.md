Community apps let InfraWeaver operators turn external application templates into GitOps-managed manifests that fit the platform’s catalog structure.

## What community apps are

The Community Apps area reads from the Unraid AppFeed and converts selected entries into Kubernetes manifests, catalog metadata, and ArgoCD application definitions.

This is useful when you want to:

- trial an app that is not already in the curated catalog
- bootstrap a self-hosted service quickly
- keep community deployments aligned with the same GitOps workflow used by the rest of the platform

## Browsing the catalog

The catalog supports:

- full-text search
- category filters
- complexity or tier filters
- pagination for large result sets

Open an app card to review the source repository, overview, categories, and expected configuration surface.

## Installing an app

1. Choose an app from the catalog.
2. Start the deploy flow.
3. Set the namespace and optional overrides such as storage class, PVC size, and ingress hostname.
4. Submit the deployment.

InfraWeaver commits generated files into the platform repo so ArgoCD can pick them up.

## Managing installed apps

The installed apps view reads back the bootstrap and catalog files that were generated for community deployments. Use it to verify:

- namespace
- tier
- image repository
- manifests path
- ingress hostname

## Environment variables and configuration

Community apps often expose environment variables, volume paths, port mappings, and ingress settings. Review these before deployment, especially for stateful workloads.

Good practice:

- keep credentials in External Secrets or platform secret stores
- avoid hardcoding private keys in generated manifests
- keep namespaces app-specific when testing

## Updating apps

Updating a community app is usually a GitOps change rather than an in-place manual patch.

Typical flow:

1. update the generated manifest or catalog metadata
2. commit the change to git
3. let ArgoCD reconcile the new desired state
4. confirm health and logs after rollout

> **Warning:** Treat community app updates as code deployments. Read changelogs, back up stateful data, and verify storage compatibility before you roll forward.
