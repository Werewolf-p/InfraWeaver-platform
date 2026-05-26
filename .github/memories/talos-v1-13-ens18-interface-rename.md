---
title: Talos v1.13+ renames eth0 → ens18; machineconfig must use deviceSelector
description: Talos v1.13.0 uses predictable NIC naming (ens18 for Proxmox slot 18); interface: eth0 in machineconfig causes missing default route, flannel failure, and all pods stuck ContainerCreating
---

# Talos v1.13+ Interface Rename: eth0 → ens18

## Memory

- **File paths:** `terraform/modules/talos-cluster/main.tf`, `envs/productie/cluster.yaml`
- **Decision:** Use `deviceSelector.hardwareAddr` instead of `interface: eth0` for all Talos network config patches
- **Why it matters:** Talos v1.13.0 switches from legacy interface names (`eth0`) to predictable names (`ens18` for Proxmox VMs with NIC in PCI slot 18). A machineconfig with `interface: eth0`:
  1. The RouteSpec binds the default gateway to `outLinkName: eth0` (which doesn't exist)
  2. The default route `0.0.0.0/0` is never installed in the kernel
  3. Flannel fails: `Unable to find default route`
  4. All pods get stuck `ContainerCreating` (no CNI = no pod networking)
  5. DNS resolution breaks on affected nodes (can't reach external registries)
- **Validation:** `talosctl get routespecs --nodes <IP> -o yaml | grep outLinkName` — must show `ens18`, NOT `eth0`
- **Related:** `cluster.yaml` node entries, `talos-upgrade.yml` workflow
- **Lesson learned:** After upgrading from v1.12.7 → v1.13.0, cp2 and cp3 had no default gateway for 9+ hours causing complete CNI failure. Fix required `apply-config --mode=reboot` (not `--mode=no-reboot`) to change the outLinkName in RouteSpec.

## Fix Applied

```yaml
# cluster.yaml - add mac_address to each node
nodes:
  talos-prod-cp1:
    mac_address: "bc:24:11:7c:7a:23"
  talos-prod-cp2:
    mac_address: "bc:24:11:21:bd:ba"
  talos-prod-cp3:
    mac_address: "bc:24:11:24:a9:c4"
```

```hcl
# main.tf - use deviceSelector when mac_address available
interfaces = [
  each.value.mac_address != null ? {
    deviceSelector = { hardwareAddr = each.value.mac_address }
    addresses      = ["${each.value.ip}/${var.subnet_prefix}"]
    dhcp           = false
    routes = [{ network = "0.0.0.0/0", gateway = var.gateway }]
  } : {
    interface = "eth0"
    ...
  }
]
```

Also add `--iface=ens18` to flannel DaemonSet args as belt-and-suspenders:
```bash
kubectl patch daemonset -n kube-system kube-flannel --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--iface=ens18"}]'
```

## Proxmox MAC pattern
Proxmox assigns MACs following `bc:24:11:xx:xx:xx`. Get MAC per VM:
```bash
talosctl get links --nodes <IP> | grep "up.*true"
```
