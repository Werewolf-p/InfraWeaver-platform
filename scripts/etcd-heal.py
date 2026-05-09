#!/usr/bin/env python3
"""etcd CORRUPT alarm healer — runs inside a privileged pod that has /host/proc."""
import subprocess, glob, sys, os, urllib.request, tarfile, io

E = "/tmp/etcdctl-healer"
ENDPOINTS = "https://10.10.0.90:2379,https://10.10.0.91:2379,https://10.10.0.92:2379"

def ensure_etcdctl():
    if os.path.exists(E):
        return
    print("Downloading etcdctl...", flush=True)
    url = "https://github.com/etcd-io/etcd/releases/download/v3.5.17/etcd-v3.5.17-linux-amd64.tar.gz"
    with urllib.request.urlopen(url, timeout=30) as r:
        data = r.read()
    t = tarfile.open(fileobj=io.BytesIO(data))
    m = t.getmember("etcd-v3.5.17-linux-amd64/etcdctl")
    with open(E, "wb") as f:
        f.write(t.extractfile(m).read())
    os.chmod(E, 0o755)

def find_certs():
    for f in glob.glob('/host/proc/*/comm'):
        try:
            if open(f).read().strip() == 'kube-apiserver':
                pid = f.split('/')[3]
                p = f'/host/proc/{pid}/root/system/secrets/kubernetes/kube-apiserver'
                if os.path.exists(p + '/etcd-client.crt'):
                    return p
        except Exception:
            pass
    return None

def run(cmd, timeout=60):
    r = subprocess.run([E] + cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return r.stdout.decode().strip(), r.stderr.decode().strip(), r.returncode

ensure_etcdctl()
certs = find_certs()
if not certs:
    print("ERROR: kube-apiserver certs not found", flush=True)
    sys.exit(1)

CA   = certs + '/etcd-client-ca.crt'
CERT = certs + '/etcd-client.crt'
KEY  = certs + '/etcd-client.key'
OPTS = ['--cacert', CA, '--cert', CERT, '--key', KEY]

out, err, _ = run(['--endpoints', ENDPOINTS] + OPTS + ['alarm', 'list'])
print(f"Alarms: {out or 'NONE'}", flush=True)

if 'CORRUPT' not in out:
    print("Cluster healthy.", flush=True)
    sys.exit(0)

print("CORRUPT alarm detected — defrag + disarm...", flush=True)
for ep in ENDPOINTS.split(','):
    out, err, rc = run(['--endpoints', ep.strip()] + OPTS + ['defrag'], timeout=120)
    print(f"Defrag {ep}: {out or err}", flush=True)

out, err, rc = run(['--endpoints', ENDPOINTS] + OPTS + ['alarm', 'disarm'])
print(f"Disarm: {out or err or 'ok'}", flush=True)

out, err, _ = run(['--endpoints', ENDPOINTS] + OPTS + ['alarm', 'list'])
if 'CORRUPT' in out:
    print(f"ERROR: Alarm still active: {out}", flush=True)
    sys.exit(1)
print("SUCCESS: etcd alarm cleared.", flush=True)
