# App Template — Security Defaults Baked In

Use this template to add a new app to InfraWeaver. Every file here has security defaults applied out of the box.

## Quick Start

```bash
# Scaffold a new app (copies this template, substitutes APP_NAME):
bash scripts/new-app.sh my-app

# Or for a Helm chart app:
bash scripts/new-app.sh my-app --helm https://charts.example.com my-chart
```

---

## What You Get

| File | Purpose |
|------|---------|
| `manifests/namespace.yaml` | Namespace with Pod Security Admission (restricted) |
| `manifests/serviceaccount.yaml` | Dedicated SA — no default SA auto-mount |
| `manifests/networkpolicy.yaml` | Default-deny + allow only from Traefik |
| `manifests/deployment.yaml` | Secure pod template (non-root, read-only fs, drop ALL caps) |
| `manifests/service.yaml` | ClusterIP service |
| `manifests/resourcequota.yaml` | Namespace CPU/memory limits |
| `manifests/ingressroute-internal.yaml.example` | VPN-only route (rename to `.yaml` to activate) |
| `manifests/ingressroute-public.yaml.example` | Public internet route (rename to `.yaml` to activate) |

---

## Making Your App Accessible

### Internal only (default — accessed via NetBird VPN):
```bash
cp manifests/ingressroute-internal.yaml.example manifests/ingressroute-internal.yaml
# URL: https://APP_NAME.int.example.com  (only reachable on VPN)
```

### Public internet access (opt-in):
```bash
cp manifests/ingressroute-public.yaml.example manifests/ingressroute-public.yaml
# URL: https://APP_NAME.example.com  (⚠️ world-reachable!)
```

---

## Checklist Before Pushing

- [ ] Replace all `APP_NAME` placeholders
- [ ] Set correct container `image` in `deployment.yaml`
- [ ] Set correct `containerPort` to match your app
- [ ] Review resource requests/limits in `deployment.yaml` and `resourcequota.yaml`
- [ ] Choose internal vs public IngressRoute (rename `.example` → `.yaml`)
- [ ] If using Helm: fill in `application.yaml` and `values.yaml`
