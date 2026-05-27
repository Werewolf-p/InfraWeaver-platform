---
title: Talos nodes require iscsi-tools extension for Longhorn
description: Longhorn 1.7+ crashes on Talos without siderolabs/iscsi-tools system extension
---

# Talos iscsi-tools Extension for Longhorn

## Memory

- **File paths:**
  - `envs/productie/generated/talosconfig` — working talosctl config (NOT `envs/productie/talosconfig` which is empty)
  - `kubernetes/core/longhorn/application.yaml` — Longhorn helm app
  
- **Decision:** All 3 Talos nodes upgraded to schematic `c9078f9419961640c712a8bf2bb9174933dfcf1da383fd8ea2b7dc21493f8bac` (v1.13.0 + iscsi-tools)

- **Why it matters:** Longhorn 1.7+ checks for `iscsiadm` via `nsenter --mount=/host/proc/PID/ns/mnt iscsiadm --version` on every manager startup. If missing: immediate `fatal` crash, CrashLoopBackOff on all nodes.

- **Validation:** `talosctl get extensions --nodes <IP> --endpoints <IP>` → should show `iscsi-tools v0.2.0`

- **Upgrade procedure (rolling, one node at a time):**
  ```bash
  export TALOSCONFIG=envs/productie/generated/talosconfig
  SCHEMATIC=c9078f9419961640c712a8bf2bb9174933dfcf1da383fd8ea2b7dc21493f8bac
  IMAGE="factory.talos.dev/installer/${SCHEMATIC}:v1.13.0"
  
  kubectl cordon <node-name>
  # Run SYNCHRONOUSLY (not in background - context cancel kills image pull)
  talosctl upgrade --nodes <IP> --endpoints <IP> --image "$IMAGE" --preserve=true --wait=true --timeout=10m
  talosctl get extensions --nodes <IP> --endpoints <IP>   # verify
  kubectl uncordon <node-name>
  ```

- **Critical gotcha:** Running `talosctl upgrade` in a shell background process (`&`) causes the upgrade to fail with `context canceled` when the shell exits. The Talos node starts pulling the image but the connection drops immediately. Always run upgrade SYNCHRONOUSLY in foreground.

- **Adding extensions to future Talos versions:** POST new schematic to `https://factory.talos.dev/schematics` with the extension list, get new schematic ID, use `factory.talos.dev/installer/<new-id>:<version>` as upgrade image.

- **Schematic API:**
  ```bash
  curl -s -X POST https://factory.talos.dev/schematics \
    -H "Content-Type: application/yaml" \
    -d 'customization:
    systemExtensions:
      officialExtensions:
        - siderolabs/iscsi-tools'
  # Returns: {"id": "<schematic-id>", ...}
  ```

- **Lesson learned:** Vanilla Talos images don't include iscsiadm. The `siderolabs/iscsi-tools` extension must be baked into the installer image via factory.talos.dev schematics. There is no workaround — the binary must exist in the host mount namespace (not achievable via container tricks since `nsenter` enters host namespace).
