Monitoring in InfraWeaver is built to answer both platform-wide and per-service questions. Start with the high-level health views, then drill down into nodes, workloads, or uptime history.

## Cluster health overview

The health pages summarize:

- whether the control plane is responding
- whether core services are healthy
- whether pods are failing or restarting unexpectedly

Use this view before any maintenance window or large deployment.

## ArgoCD application status

ArgoCD is the GitOps source of truth for deployed manifests. The monitoring workflow typically checks:

- sync status
- health status
- out-of-sync resources
- repeated reconciliation failures

If the UI looks stale after a deployment, ArgoCD status is one of the first places to inspect.

## Node metrics

The node metrics pages show CPU and memory pressure per Kubernetes node. These values help you answer:

- which node is hottest right now
- whether a deployment would worsen imbalance
- whether request or limit tuning is needed

## Game server metrics

Game Hub detail pages surface live and historical resource usage for each server. This is particularly important for modded servers and games with bursty player activity.

## Prometheus integration

Prometheus supplies most of the historical time series used by InfraWeaver, including:

- cluster and node resource usage
- pod-level CPU and memory history
- game server usage charts
- alert inputs

> **Note:** Missing charts usually mean the metrics source is unavailable, the pod name changed, or the workload has not produced enough data yet.

## Alert configuration

Alert silence and test tools are available for controlled maintenance work. Use alert silences when you know a disruption is planned and temporary.

Good alert hygiene means:

- create a silence before planned disruptive work
- time-box the silence
- remove it as soon as the maintenance window ends

## Uptime monitoring with Gatus

Uptime history complements Prometheus metrics by checking service reachability from a user perspective. Gatus-style uptime monitoring is best for:

- HTTP dashboards
- ingress endpoints
- service availability tracking over time

InfraWeaver uses uptime data to show historical outages and recovery trends rather than only current state.
