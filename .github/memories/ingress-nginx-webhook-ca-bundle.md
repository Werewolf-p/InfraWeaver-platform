---
title: ingress-nginx admission webhook caBundle empty on fresh deploys
description: On fresh cluster deploys the nginx ValidatingWebhookConfiguration has an empty caBundle causing all Ingress applies to fail with x509 unknown authority.
---

# ingress-nginx Admission Webhook CA Bundle

## Memory

- **File paths:**
  - `.github/workflows/full-redeploy.yml` — "Fix ingress-nginx admission webhook CA bundle" step (runs after ArgoCD app-of-apps deploy)
  - `kubernetes/core/ingress-nginx/` — Helm chart for nginx

## Problem

On fresh cluster deploys, the `ingress-nginx-admission` ValidatingWebhookConfiguration has an **empty `caBundle`**. This causes any attempt to create or update an `Ingress` resource to fail with:

```
Internal error occurred: failed calling webhook "validate.nginx.ingress.kubernetes.io":
failed to call webhook: ... tls: failed to verify certificate: x509: certificate signed by unknown authority
```

## Root Cause

The Helm chart includes `admission-create` and `admission-patch` Jobs (pre-install/post-install hooks) that:
1. Create the TLS cert for the webhook server → stored in `ingress-nginx-admission` secret
2. Patch the `caBundle` into the `ValidatingWebhookConfiguration`

On the **first install**, these jobs run and everything works. On a **destroy + recreate** (full redeploy), Kubernetes doesn't re-run completed Jobs. ArgoCD applies the Helm resources but the Jobs already have `status.succeeded: 1` — they're not re-triggered. The nginx controller creates a new `ingress-nginx-admission` secret with a **new CA**, but the `ValidatingWebhookConfiguration.webhooks[0].clientConfig.caBundle` is still empty (or stale).

## Fix

Patch the `caBundle` from the new secret into the webhook configuration:

```bash
CA_BUNDLE=$(kubectl get secret ingress-nginx-admission -n ingress-nginx \
  -o jsonpath='{.data.ca}')
kubectl patch validatingwebhookconfiguration ingress-nginx-admission \
  --type json \
  -p "[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"$CA_BUNDLE\"}]"
```

This is done automatically in `full-redeploy.yml` as the "Fix ingress-nginx admission webhook CA bundle" step.

## Validation

After patching, ArgoCD sync of any app with Ingress resources will succeed without the x509 error.
Check: `kubectl describe validatingwebhookconfiguration ingress-nginx-admission` — `caBundle` should be non-empty.

## Lesson Learned

Helm Jobs with `helm.sh/hook: pre-install,post-install` + `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded` only run on **install**, not on **upgrade**. On a destroy+recreate redeploy, ArgoCD treats it as an upgrade and skips the hook jobs. Always patch the caBundle explicitly in the post-deploy workflow.
