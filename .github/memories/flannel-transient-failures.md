# Flannel subnet.env Transient Failure Pattern

## What happens
When any control plane node's API server or flannel DaemonSet pod **restarts**, there is a brief window (~1-2 minutes) where `/run/flannel/subnet.env` does not exist on that node.

During this window, **ALL pod sandbox creations on that node fail** with:
```
FailedCreatePodSandBox: failed to create pod sandbox: ... 
flannel failed (add): failed to load flannel 'subnet.env' file
```

## This is self-healing
- Flannel rewrites `/run/flannel/subnet.env` as soon as it comes back up
- All affected pods retry sandbox creation and succeed within 1-2 minutes
- No manual intervention needed

## How to distinguish from real CNI failures
- Real Flannel failure: pods stuck in `ContainerCreating` for >5 minutes, flannel pod `CrashLoopBackOff`
- Transient restart: pods recover within 2 minutes, flannel pod Running after restart

## Monitoring
Prometheus alert `KubePodNotScheduled` fires after 10+ minutes — so transient failures don't trigger pages.
If you see a burst of `FailedCreatePodSandBox` events, check:
```bash
kubectl get pod -n kube-system -l app=flannel
kubectl describe node <node> | grep -A5 "Conditions:"
```

## Nodes and their roles
- cp1: ~18GB RAM, API server leader (highest memory usage ~1.9GB)
- cp2: ~18GB RAM, follower
- cp3: ~6.7GB RAM, small node (only 6.7GB total, 125% limit overcommit — monitor for OOM)
