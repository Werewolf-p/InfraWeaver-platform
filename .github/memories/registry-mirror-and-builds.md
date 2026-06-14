# Registry Mirror Issues & Manual Build Process

## Registry Mirror at 10.25.0.3:5000 (Proxmox)

**Service**: `docker-registry.service` (systemd, not Docker container)
**Data dir**: `/var/lib/docker-registry/docker/registry/v2/`
**Config**: `/etc/registry/config.yml` (rootdirectory: `/var/lib/registry`, actual data at `/var/lib/docker-registry`)
**Upstream**: `https://registry-1.docker.io` (Docker Hub pull-through proxy)

### Known Bug: Corrupted Blob Serving
The mirror inconsistently serves wrong blob data for some Docker Hub images.
Symptom: `failed commit on ref "layer-sha256:...": unexpected commit digest`
Root cause: Blob file stored with wrong path/content in mirror storage.

**Fix procedure**:
1. SSH to Proxmox: `ssh -i ~/.ssh/deployer_ed25519 root@10.25.0.3`
2. Stop registry: `systemctl stop docker-registry`
3. Delete corrupted repo cache: `rm -rf /var/lib/docker-registry/docker/registry/v2/repositories/<org>/<image>/`
4. Download correct blob from Docker Hub to init VM with auth token
5. Copy correct blob to `/var/lib/docker-registry/docker/registry/v2/blobs/sha256/<2char>/<fullhash>/data`
6. Start registry: `systemctl start docker-registry`
7. When registry is DOWN, Talos nodes fall back to `registry-1.docker.io` (public Docker Hub)

**Workaround for stuck nodes**: Stop the registry mirror temporarily so nodes fall back to Docker Hub.

## Buildah as Manual CI (No CI Agents Registered in Onedev)

All Docker builds must be done manually on the init VM (10.10.0.50):

```bash
# Login
buildah login --username admin --password <ONEDEV_PASSWORD> onedev.example.com

# Build
cd /opt/infraweaver/apps/<appname>
buildah build --memory 2g \
  --tag onedev.example.com/infraweaver-platform/<appname>:main-<sha> .

# Push (413 if image > ~500MB — need to increase Traefik body size limit)
buildah push --tls-verify=false \
  onedev.example.com/infraweaver-platform/<appname>:main-<sha>
```

**Note**: 413 "Payload Too Large" for images >500MB. Traefik default body limit applies.
To push large images: use buildah on init VM directly (it can reach Onedev internally).

## Onedev Git Push via Port-Forward

Onedev git port is 6610 (not 80 or 22):
```bash
kubectl port-forward -n onedev pod/onedev-<id> 19311:6610 --address=127.0.0.1 &
git remote set-url origin http://admin:<password>@127.0.0.1:19311/InfraWeaver-platform
git push origin main
```

Service maps port 80 → container port 6610 (so `svc/onedev:80` port-forward works too).

## Longhorn Instance Managers and Registry Issues

If Longhorn instance managers get `ImagePullBackOff`:
1. Check kubelet logs: `talosctl logs kubelet -n <node-ip> | grep instance-manager`
2. If "unexpected commit digest" → registry mirror blob corruption (see above)
3. Fix: stop registry, delete pod (it falls back to Docker Hub), restart registry with correct blob
4. Or: push image to Onedev, create imagePullSecret in longhorn-system, patch longhorn-service-account

## Wazuh OpenSearch Indexer Memory

The wazuh-indexer requires:
- `OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m -XX:MaxDirectMemorySize=536870912"` (512MB direct buffer)
- Container memory limit: 1500Mi (heap 512 + direct 512 + overhead ~400)
- Without sufficient direct buffer, security plugin fails with OOM on startup

## Kubeconfig Note

API server for productie cluster: use `10.10.0.93:6443` (cp2) as primary — cp1 (10.10.0.92) sometimes has connection refused. Update kubeconfig:
```bash
kubectl config set-cluster productie --server=https://10.10.0.93:6443
```
