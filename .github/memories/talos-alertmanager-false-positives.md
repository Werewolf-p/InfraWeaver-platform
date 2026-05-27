---
title: Talos false-positive alerts — silence both component-down AND TargetDown
description: Talos localhost-bound components trigger two separate alert families; both must be null-routed.
---

# Talos Alertmanager False Positives

## Memory

- **File path:** `kubernetes/monitoring/kube-prometheus-stack/values.yaml` — `alertmanager.config.route.routes`

- **Decision:** Two separate Alertmanager null-routes are required for Talos localhost-bound components:
  1. `alertname =~ "KubeControllerManagerDown|KubeProxyDown|KubeSchedulerDown"` → null
  2. `alertname = "TargetDown", job =~ "kube-proxy|kube-controller-manager|kube-scheduler"` → null

- **Why it matters:** Talos binds kube-controller-manager, kube-scheduler, and kube-proxy to 127.0.0.1. Prometheus can never scrape them. This fires TWO separate alert families:
  - The component-down alert (e.g. `KubeControllerManagerDown`) — a single alert per component
  - `TargetDown{job="kube-proxy", ...}` — fires when 100% of a job's targets are unreachable
  Only silencing the first family leaves `TargetDown` leaking to Discord on every node reboot.

- **Validation:** After adding the second null-route, confirm with:
  ```bash
  kubectl exec -n monitoring <prometheus-pod> -- wget -qO- \
    'http://localhost:9090/api/v1/alerts' | python3 -c "
  import json,sys; [print(a['labels']) for a in json.load(sys.stdin)['data']['alerts']
  if a['labels'].get('alertname')=='TargetDown']"
  ```
  Alerts still appear in Prometheus (that's normal) but Alertmanager routes them to null so no Discord message fires.

- **Related:** `kubernetes/monitoring/alerts/manifests/prometheus-rules.yaml`

- **Lesson learned:** Discovered during stability audit — `TargetDown` fired at every node reboot since cp2 reboot (08:50 UTC) but `KubeProxyDown` etc. were already silenced. The companion `TargetDown` with `job=` label is a separate Alertmanager route requirement.
