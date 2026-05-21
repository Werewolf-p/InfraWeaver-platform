#!/usr/bin/env python3
"""
InfraWeaver Init Server
Serves the configuration web UI and handles deploy/redeploy API calls.

Usage:
    python3 scripts/init/server.py [--port 8080] [--host 0.0.0.0]

Environment:
    IW_REPO_DIR   — path to the InfraWeaver repo (default: cwd or /opt/infraweaver)
    IW_PORT       — port to listen on (default: 8080)
"""
import http.server
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional
import socketserver
import ssl

mimetypes.init()
EXT_TYPES = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
}

# ── Config ──────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("IW_PORT", "8080"))
HOST = os.environ.get("IW_HOST", "0.0.0.0")

# Find repo dir: env override → parent of this script → /opt/infraweaver
_script_dir = Path(__file__).parent
REPO_DIR = Path(os.environ.get("IW_REPO_DIR", ""))
if not REPO_DIR or not REPO_DIR.exists():
    for candidate in [_script_dir.parent.parent, Path("/opt/infraweaver")]:
        if (candidate / "scripts").exists():
            REPO_DIR = candidate
            break
    else:
        REPO_DIR = _script_dir.parent.parent

TEMPLATE_DIR = _script_dir / "templates"
OUT_DIR = _script_dir / "out"
ENV_FILE = REPO_DIR / ".env"
DEPLOY_LOCK = threading.Lock()
CURRENT_DEPLOY: Optional[subprocess.Popen] = None
DEPLOY_STATE_COND = threading.Condition()
DEPLOY_STATE = {
    "deployment_id": 0,
    "running": False,
    "mode": None,
    "progress": 0,
    "step": "Waiting to deploy…",
    "summary": "",
    "error": "",
    "events": [],
    "next_seq": 1,
    "started_at": None,
    "completed_at": None,
}

IMPORT_REQUIRED_ENV_FIELDS = [
    "BASE_DOMAIN",
    "PROXMOX_HOST",
    "PROXMOX_API_TOKEN",
    "NODE_COUNT",
    "NODE_1_IP",
    "METALLB_VIP_RANGE",
]

REQUIRED_ENV_FIELDS = [
    "BASE_DOMAIN", "ADMIN_EMAIL", "GITHUB_REPO", "GIT_REPO_URL",
    "PROXMOX_API_TOKEN", "DEPLOYER_SSH_KEY",
    "DNS_PROVIDER", "SMTP_USERNAME", "SMTP_PASSWORD"
]

DNS_PROVIDER_FIELDS = {
    "cloudflare": ["CLOUDFLARE_API_TOKEN"],
    "route53": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    "azure": [
        "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID",
        "AZURE_TENANT_ID", "AZURE_RESOURCE_GROUP",
    ],
    "digitalocean": ["DIGITALOCEAN_TOKEN"],
    "hetzner": ["HETZNER_DNS_API_KEY"],
    "none": [],
}

DNS_ENV_FIELDS = [
    "CLOUDFLARE_API_TOKEN",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_HOSTED_ZONE_ID", "AWS_REGION",
    "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID",
    "AZURE_TENANT_ID", "AZURE_RESOURCE_GROUP",
    "DIGITALOCEAN_TOKEN", "HETZNER_DNS_API_KEY",
]

OPTIONAL_ENV_FIELDS = [
    "SMTP_TO", "NETBIRD_API_TOKEN", "GITHUB_PAT",
    "RUNNER_REGISTRATION_TOKEN", "ENV_NAME", "LETSENCRYPT_ENV"
]

GENERAL_DEFAULTS = {
    "ADMIN_EMAIL": "admin@yourdomain.com",
    "GITHUB_REPO": "your-org/your-repo",
    "GIT_REPO_URL": "https://github.com/your-org/your-repo",
}

CLUSTER_ENV_FIELDS = [
    "PROXMOX_HOST", "PROXMOX_NODE_NAME", "K8S_CLUSTER_NAME",
    "NODE_GATEWAY", "NODE_SUBNET_PREFIX", "TALOS_DATASTORE",
    "PVE_NODES", "NODE_COUNT",
    "NODE_1_IP", "NODE_1_VMID", "NODE_1_PVE_NODE", "NODE_1_DATASTORE", "NODE_1_CPU", "NODE_1_MEMORY", "NODE_1_DISK",
    "NODE_2_IP", "NODE_2_VMID", "NODE_2_PVE_NODE", "NODE_2_DATASTORE", "NODE_2_CPU", "NODE_2_MEMORY", "NODE_2_DISK",
    "NODE_3_IP", "NODE_3_VMID", "NODE_3_PVE_NODE", "NODE_3_DATASTORE", "NODE_3_CPU", "NODE_3_MEMORY", "NODE_3_DISK",
]

CLUSTER_DEFAULTS = {
    "PROXMOX_HOST": "192.168.1.100",
    "PROXMOX_NODE_NAME": "pve",
    "K8S_CLUSTER_NAME": "infraweaver-prod",
    "NODE_GATEWAY": "10.10.0.1",
    "NODE_SUBNET_PREFIX": "24",
    "TALOS_DATASTORE": "lvm-proxmox",
    "PVE_NODES": "",
    "NODE_COUNT": "3",
    "NODE_1_IP": "10.10.0.90",   "NODE_1_VMID": "9310",   "NODE_1_PVE_NODE": "", "NODE_1_DATASTORE": "", "NODE_1_CPU": "4", "NODE_1_MEMORY": "12288", "NODE_1_DISK": "100",
    "NODE_2_IP": "10.10.0.91",   "NODE_2_VMID": "9311",   "NODE_2_PVE_NODE": "", "NODE_2_DATASTORE": "", "NODE_2_CPU": "4", "NODE_2_MEMORY": "12288", "NODE_2_DISK": "100",
    "NODE_3_IP": "10.10.0.92",   "NODE_3_VMID": "9312",   "NODE_3_PVE_NODE": "", "NODE_3_DATASTORE": "", "NODE_3_CPU": "4", "NODE_3_MEMORY": "12288", "NODE_3_DISK": "100",
}

# Infrastructure VIP and admin fields
INFRA_ENV_FIELDS = [
    "METALLB_VIP_RANGE", "METALLB_TRAEFIK_VIP", "METALLB_COREDNS_VIP",
    "METALLB_NETBIRD_MGMT_VIP", "METALLB_NETBIRD_SIGNAL_VIP", "METALLB_NETBIRD_RELAY_VIP",
    "CLUSTER_LOCAL_DOMAIN", "ADMIN_USERNAME", "ADMIN_NAME",
]

INFRA_DEFAULTS = {
    "METALLB_VIP_RANGE": "10.10.0.200-10.10.0.210",
    "METALLB_TRAEFIK_VIP": "10.10.0.200",
    "METALLB_COREDNS_VIP": "10.10.0.201",
    "METALLB_NETBIRD_MGMT_VIP": "10.10.0.202",
    "METALLB_NETBIRD_SIGNAL_VIP": "10.10.0.203",
    "METALLB_NETBIRD_RELAY_VIP": "10.10.0.204",
    "CLUSTER_LOCAL_DOMAIN": "prod.local",
    "ADMIN_USERNAME": "admin",
    "ADMIN_NAME": "Platform Admin",
}

# Feature flag fields — written to .env and read by configure-platform.sh
FEATURE_ENV_FIELDS = [
    "ENABLE_NETBIRD", "ENABLE_MONITORING", "ENABLE_EXTERNAL_DNS", "BACKUP_PROVIDER",
    "LOCAL_IP_RANGES",
]

# Default values for feature flags
FEATURE_DEFAULTS = {
    "ENABLE_NETBIRD": "false",
    "ENABLE_MONITORING": "false",
    "ENABLE_EXTERNAL_DNS": "false",
    "BACKUP_PROVIDER": "longhorn",
    "LOCAL_IP_RANGES": "",
}

DNS_ENV_DEFAULTS = {
    "DNS_PROVIDER": "cloudflare",
    "AWS_REGION": "us-east-1",
}

ALL_ENV_FIELDS = (REQUIRED_ENV_FIELDS + DNS_ENV_FIELDS + OPTIONAL_ENV_FIELDS + CLUSTER_ENV_FIELDS
                  + INFRA_ENV_FIELDS + FEATURE_ENV_FIELDS)
ALL_ENV_DEFAULTS = {**GENERAL_DEFAULTS, **DNS_ENV_DEFAULTS, **CLUSTER_DEFAULTS, **INFRA_DEFAULTS, **FEATURE_DEFAULTS}


def _detect_local_subnets() -> list:
    """Detect local IPv4 subnets from system network interfaces.
    Returns list of {'cidr': '10.25.0.0/24', 'ip': '10.25.0.5'} dicts.
    """
    import socket
    import struct
    subnets = []
    try:
        result = subprocess.run(
            ["ip", "-4", "addr", "show"],
            capture_output=True, text=True, timeout=5
        )
        for match in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)/(\d+)", result.stdout):
            ip = match.group(1)
            prefix = int(match.group(2))
            # Skip loopback, link-local, Docker, K8s pod/node internals
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            if ip.startswith("10.244.") or ip.startswith("10.245."):
                continue  # K8s pod CIDR
            # Calculate network address
            ip_int = struct.unpack("!I", socket.inet_aton(ip))[0]
            mask_int = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
            net_int = ip_int & mask_int
            net_str = socket.inet_ntoa(struct.pack("!I", net_int))
            subnets.append({"cidr": f"{net_str}/{prefix}", "ip": ip})
    except Exception:
        pass
    return subnets


def _ip_to_int(ip: str) -> int:
    import socket, struct
    return struct.unpack("!I", socket.inet_aton(ip))[0]


def _int_to_ip(n: int) -> str:
    import socket, struct
    return socket.inet_ntoa(struct.pack("!I", n))


def _is_valid_ipv4(value: str) -> bool:
    try:
        parts = value.strip().split(".")
        if len(parts) != 4:
            return False
        return all(part.isdigit() and 0 <= int(part) <= 255 for part in parts)
    except Exception:
        return False


def _is_positive_integer(value: str) -> bool:
    return value.strip().isdigit() and int(value.strip()) > 0


def _is_valid_domain(value: str) -> bool:
    return bool(re.match(r"^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$", value.strip()))


def _is_valid_vip_range(value: str) -> bool:
    start, _, end = value.strip().partition("-")
    if not start or not end or not _is_valid_ipv4(start) or not _is_valid_ipv4(end):
        return False
    return _ip_to_int(start) <= _ip_to_int(end)


def _ping_host(ip: str, timeout_ms: int = 500) -> bool:
    """Return True if the host responds to ping (= IP is already in use)."""
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", str(max(1, timeout_ms // 1000 or 1)), "-q", ip],
            capture_output=True, timeout=2
        )
        return result.returncode == 0
    except Exception:
        return False


def _suggest_vips(gateway: str, prefix: int) -> Dict:
    """Given a gateway + subnet prefix, suggest 5 MetalLB VIPs and ping-check each.
    VIPs are placed at offset 200 from the network base (mirrors the .200-.210 convention).
    """
    import threading
    try:
        gw_int = _ip_to_int(gateway)
        mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
        network = gw_int & mask
        broadcast = network | (~mask & 0xFFFFFFFF)
        base_offset = 200

        vip_names = [
            ("METALLB_TRAEFIK_VIP",        "Traefik ingress"),
            ("METALLB_COREDNS_VIP",         "CoreDNS"),
            ("METALLB_NETBIRD_MGMT_VIP",    "NetBird management"),
            ("METALLB_NETBIRD_SIGNAL_VIP",  "NetBird signal"),
            ("METALLB_NETBIRD_RELAY_VIP",   "NetBird relay"),
        ]

        # Compute IPs; fall back to broadcast-N if they exceed broadcast
        ip_map = {}
        for i, (var, _) in enumerate(vip_names):
            ip_int = network + base_offset + i
            if ip_int >= broadcast:
                ip_int = broadcast - len(vip_names) + i - 1
            ip_map[var] = _int_to_ip(ip_int)

        # Parallel ping checks
        ping_results: Dict[str, bool] = {}

        def ping_one(var: str, ip: str):
            ping_results[var] = _ping_host(ip)

        threads = [threading.Thread(target=ping_one, args=(var, ip_map[var]))
                   for var, _ in vip_names]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=3)

        vips = []
        for var, name in vip_names:
            ip = ip_map[var]
            in_use = ping_results.get(var, False)
            vips.append({"var": var, "name": name, "ip": ip, "free": not in_use})

        range_start_int = network + base_offset
        range_end_int = min(range_start_int + 10, broadcast - 2)
        vip_range = f"{_int_to_ip(range_start_int)}-{_int_to_ip(range_end_int)}"

        return {"ok": True, "vips": vips, "range": vip_range}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _suggest_node_ips(gateway: str, prefix: int) -> Dict:
    """Suggest 3 node IPs at offsets .90/.91/.92 from the network base and ping-check."""
    import threading
    try:
        gw_int = _ip_to_int(gateway)
        mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
        network = gw_int & mask
        broadcast = network | (~mask & 0xFFFFFFFF)
        offsets = [90, 91, 92]

        ip_map = {o: _int_to_ip(network + o) for o in offsets}
        ping_results: Dict[int, bool] = {}

        def ping_one(offset: int, ip: str):
            ping_results[offset] = _ping_host(ip)

        threads = [threading.Thread(target=ping_one, args=(o, ip_map[o])) for o in offsets]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=3)

        suggestions = [
            {"ip": ip_map[o], "free": not ping_results.get(o, False)}
            for o in offsets
        ]
        return {"ok": True, "suggestions": suggestions}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _ping_check_single(ip: str) -> Dict:
    """Ping-check a single IP and return free/in_use status."""
    try:
        in_use = _ping_host(ip)
        return {"ok": True, "ip": ip, "free": not in_use, "in_use": in_use}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _ping_proxmox(host: str) -> Dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        f"https://{host}:8006/api2/json/version",
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            body = json.loads(resp.read())
            version_data = body.get("data", {})
            return {
                "ok": True,
                "version": str(version_data.get("version", "")),
                "release": str(version_data.get("release", "")),
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _proxmox_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _proxmox_json_request(host: str, token: str, path: str, method: str = "GET", data: Optional[Dict] = None):
    headers = {"Authorization": f"PVEAPIToken={token}"}
    body = None
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        f"https://{host}:8006/api2/json{path}",
        data=body,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(req, context=_proxmox_context(), timeout=15) as resp:
        payload = json.loads(resp.read())
        return payload.get("data")


def _find_proxmox_vm_node(host: str, token: str, vmid: int) -> Optional[str]:
    try:
        resources = _proxmox_json_request(host, token, "/cluster/resources?type=vm") or []
        for resource in resources:
            if int(resource.get("vmid", 0)) == vmid:
                return resource.get("node")
    except Exception:
        return None
    return None


def _setup_proxmox_user(host: str, username: str, password: str) -> Dict:
    """Log in with username/password (ticket auth), create a dedicated
    infraweaver@pve user + InfraWeaver role + API token.
    Credentials are NEVER stored — only the resulting token is returned."""
    import urllib.request, urllib.parse, urllib.error
    import ssl, secrets

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    base = f"https://{host}:8006/api2/json"

    def pve_req(method: str, path: str, data=None, ticket=None, csrf=None):
        url = f"{base}{path}"
        headers: Dict[str, str] = {}
        if ticket:
            headers["Cookie"] = f"PVEAuthCookie={ticket}"
        if csrf:
            headers["CSRFPreventionToken"] = csrf
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        with urllib.request.urlopen(req, context=ctx, timeout=12) as r:
            return json.loads(r.read())

    try:
        # ── 1. Authenticate (ticket) ──────────────────────────────────────────
        try:
            auth_resp = pve_req("POST", "/access/ticket",
                                {"username": username, "password": password})
        except urllib.error.HTTPError as e:
            if e.code == 401:
                return {"ok": False, "error": "Authentication failed — wrong username or password"}
            raise
        ticket = auth_resp["data"]["ticket"]
        csrf   = auth_resp["data"]["CSRFPreventionToken"]

        # ── 2. Verify admin-level access (can list users) ─────────────────────
        try:
            pve_req("GET", "/access/users", ticket=ticket)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return {"ok": False, "error":
                        "User authenticated but lacks admin privileges. "
                        "Use root@pam or a user with User.Modify + Sys.Modify permissions."}
            raise

        # ── 3. Create InfraWeaver role ────────────────────────────────────────
        PRIVS = ",".join([
            "VM.Allocate", "VM.Clone", "VM.Config.CDROM", "VM.Config.CPU",
            "VM.Config.Cloudinit", "VM.Config.Disk", "VM.Config.HWType",
            "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options",
            "VM.Audit", "VM.PowerMgmt", "VM.Console",
            "VM.Migrate", "VM.Snapshot", "VM.Snapshot.Rollback",
            "VM.GuestAgent.Audit",  # replaces VM.Monitor (removed in PVE 9.x)
            "Datastore.AllocateSpace", "Datastore.AllocateTemplate", "Datastore.Audit",
            "Pool.Allocate", "SDN.Use", "Sys.Audit",
        ])
        try:
            pve_req("POST", "/access/roles",
                    {"roleid": "InfraWeaver", "privs": PRIVS}, ticket, csrf)
        except urllib.error.HTTPError as _role_err:
            _role_body = _role_err.read().decode("utf-8", "replace")
            if "already exist" in _role_body.lower():
                # Role already exists — refresh its privilege set (best effort)
                try:
                    pve_req("PUT", "/access/roles/InfraWeaver",
                            {"privs": PRIVS, "append": 0}, ticket, csrf)
                except Exception:
                    pass  # PUT not critical — role exists and ACL will work
            else:
                return {"ok": False,
                        "error": f"Failed to create InfraWeaver role: {_role_body[:300]}"}

        # ── 4. Create infraweaver@pve user ────────────────────────────────────
        user_id = "infraweaver@pve"
        try:
            pve_req("POST", "/access/users", {
                "userid": user_id,
                "password": secrets.token_urlsafe(32),
                "comment": "InfraWeaver deployer — managed by InfraWeaver Platform",
                "enable": 1,
            }, ticket, csrf)
        except Exception:
            pass  # User already exists — that's fine

        # ── 5. Assign InfraWeaver role on / (root path, propagating) ─────────
        pve_req("PUT", "/access/acl", {
            "path": "/",
            "users": user_id,
            "roles": "InfraWeaver",
            "propagate": 1,
        }, ticket, csrf)

        # ── 6. Create (or recreate) API token ────────────────────────────────
        token_name = "infraweaver"
        try:
            tok = pve_req("POST", f"/access/users/{user_id}/token/{token_name}", {
                "privsep": 0,
                "comment": "InfraWeaver deployer token",
            }, ticket, csrf)
            token_uuid = tok["data"]["value"]
        except Exception:
            # Token already exists — delete it and regenerate
            try:
                pve_req("DELETE", f"/access/users/{user_id}/token/{token_name}",
                        None, ticket, csrf)
            except Exception:
                pass
            tok = pve_req("POST", f"/access/users/{user_id}/token/{token_name}", {
                "privsep": 0,
                "comment": "InfraWeaver deployer token",
            }, ticket, csrf)
            token_uuid = tok["data"]["value"]

        # Credentials are discarded here — only the token is returned
        return {
            "ok": True,
            "token": f"{user_id}!{token_name}={token_uuid}",
            "user": user_id,
        }

    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return {"ok": False, "error": f"Proxmox API error {e.code}: {body[:300]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _discover_proxmox(host: str, token: str) -> Dict:
    """Query Proxmox API to discover node name, datastores, and next free VMIDs."""
    import urllib.request
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    headers = {"Authorization": f"PVEAPIToken={token}"}
    base = f"https://{host}:8006/api2/json"

    def pve_get(path: str):
        req = urllib.request.Request(f"{base}{path}", headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
            return json.loads(r.read())["data"]

    try:
        nodes = pve_get("/nodes")
        node_names = [n["node"] for n in nodes]
        primary_node = node_names[0] if node_names else "pve"

        # Collect per-node SSH IPs, datastores, and resources — all nodes in parallel.
        import threading
        node_ips: Dict[str, str] = {}
        datastores_by_node: Dict[str, list] = {}
        node_resources: Dict[str, Dict] = {}
        lock = threading.Lock()

        # Storage types that can hold VM disk images.
        # Use type-based filter (permissive) OR explicit "images" content config.
        # This avoids breaking setups where `local` (dir) isn't content-configured
        # for images but is still the only/primary image store on a node.
        IMAGE_CAPABLE_TYPES = {
            "lvmthin", "lvm", "dir", "zfspool", "zfs",
            "nfs", "cifs", "cephfs", "btrfs", "rbd", "glusterfs",
        }

        def fetch_node(node_name: str) -> None:
            ip_found = ""
            usable: list = []
            resources: Dict = {}
            try:
                # ── SSH/management IP ────────────────────────────────────────────
                try:
                    ifaces = pve_get(f"/nodes/{node_name}/network")
                    sorted_ifaces = sorted(
                        ifaces,
                        key=lambda i: (
                            0 if i.get("type") in ("bridge", "bond") else 1,
                            i.get("iface", "")
                        )
                    )
                    for iface in sorted_ifaces:
                        addr = iface.get("address", "").strip()
                        if (addr
                                and not addr.startswith("127.")
                                and not addr.startswith("169.254.")
                                and not addr.startswith("172.17.")
                                and not addr.startswith("172.18.")):
                            ip_found = addr
                            break
                except Exception:
                    pass

                # ── Datastores WITH free space ────────────────────────────────
                try:
                    storages = pve_get(f"/nodes/{node_name}/storage")
                    for s in storages:
                        if not s.get("enabled", 1):
                            continue
                        # Skip storages that are not currently active/mounted
                        # (they would show 0 free/total which misleads the UI)
                        if not s.get("active", 1):
                            continue
                        stype = s.get("type", "")
                        content = s.get("content", "")
                        # Include if type is known-image-capable OR explicitly configured for images
                        if stype not in IMAGE_CAPABLE_TYPES and "images" not in content:
                            continue
                        avail_bytes = int(s.get("avail", 0))
                        total_bytes = int(s.get("total", 0))
                        usable.append({
                            "name": s["storage"],
                            "type": stype,
                            "free_gb": avail_bytes // (1024 ** 3),
                            "total_gb": total_bytes // (1024 ** 3),
                        })
                except Exception:
                    pass

                # ── Node resources (CPU cores + RAM) ─────────────────────────
                try:
                    ns = pve_get(f"/nodes/{node_name}/status")
                    mem = ns.get("memory", {})
                    cpuinfo = ns.get("cpuinfo", {})
                    resources = {
                        "cpu_cores": int(cpuinfo.get("cpus", 0)),
                        "mem_total_mb": int(mem.get("total", 0)) // (1024 * 1024),
                        "mem_free_mb": (
                            int(mem.get("free", 0))
                            + int(mem.get("buffers", 0))
                            + int(mem.get("cached", 0))
                        ) // (1024 * 1024),
                    }
                except Exception:
                    pass
            except Exception:
                pass
            finally:
                # Always write results so every node_name key is present in all dicts
                with lock:
                    node_ips[node_name] = ip_found or host
                    datastores_by_node[node_name] = usable
                    node_resources[node_name] = resources

        threads = [threading.Thread(target=fetch_node, args=(n,), daemon=True) for n in node_names]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=12)

        # Build PVE_NODES string  (name1:ip1,name2:ip2)
        pve_nodes_str = ",".join(f"{n}:{ip}" for n, ip in node_ips.items())

        # resource_info for primary node (backward compat)
        primary_res = node_resources.get(primary_node, {})
        resource_info: Dict[str, int] = {
            "node_memory_total_mb": primary_res.get("mem_total_mb", 0),
            "node_memory_free_mb": primary_res.get("mem_free_mb", 0),
        }

        # Find 3 consecutive free VMIDs starting from 9300
        resources = pve_get("/cluster/resources?type=vm")
        used_vmids = {int(r["vmid"]) for r in resources if "vmid" in r}
        vmids = []
        candidate = 9300
        while len(vmids) < 3 and candidate <= 9999:
            if candidate not in used_vmids:
                vmids.append(candidate)
            candidate += 1

        return {
            "ok": True,
            "node_name": primary_node,
            "all_nodes": node_names,
            "datastores": [ds["name"] for ds in datastores_by_node.get(primary_node, [])],
            "datastores_by_node": datastores_by_node,
            "node_resources_by_node": node_resources,
            "node_ips": node_ips,
            "pve_nodes_str": pve_nodes_str,
            "vmid_suggestions": vmids,
            **resource_info,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _generate_ssh_key() -> Dict:
    """Generate a fresh ed25519 keypair. Returns private + public key strings."""
    import tempfile
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            key_path = os.path.join(tmpdir, "id_ed25519")
            result = subprocess.run(
                ["ssh-keygen", "-t", "ed25519", "-f", key_path,
                 "-N", "", "-C", "infraweaver-deployer"],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                return {"ok": False, "error": result.stderr.strip()}
            private_key = Path(key_path).read_text()
            public_key = Path(key_path + ".pub").read_text().strip()
            return {"ok": True, "private_key": private_key, "public_key": public_key}
    except FileNotFoundError:
        return {"ok": False, "error": "ssh-keygen not found — install openssh-client"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _normalize_dns_provider(provider: str) -> str:
    provider = (provider or "cloudflare").strip().lower()
    return provider if provider in DNS_PROVIDER_FIELDS else "cloudflare"


def _check_dns_provider(provider: str, credentials: Dict[str, str]) -> Dict:
    """Validate DNS provider credentials or token connectivity."""
    import urllib.request

    provider = _normalize_dns_provider(provider)

    if provider == "none":
        return {"ok": True, "status": "skipped", "provider": provider}

    if provider == "cloudflare":
        token = credentials.get("CLOUDFLARE_API_TOKEN", "").strip()
        try:
            req = urllib.request.Request(
                "https://api.cloudflare.com/client/v4/user/tokens/verify",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                body = json.loads(r.read())
                if body.get("success"):
                    status = body.get("result", {}).get("status", "active")
                    return {"ok": True, "status": status, "provider": provider}
                errors = body.get("errors", [])
                msg = errors[0].get("message", "Invalid token") if errors else "Invalid token"
                return {"ok": False, "error": msg, "provider": provider}
        except Exception as e:
            return {"ok": False, "error": str(e), "provider": provider}

    if provider == "route53":
        access_key = credentials.get("AWS_ACCESS_KEY_ID", "").strip()
        secret_key = credentials.get("AWS_SECRET_ACCESS_KEY", "").strip()
        if not re.match(r"^[A-Z0-9]{16,32}$", access_key):
            return {"ok": False, "error": "AWS_ACCESS_KEY_ID format looks invalid", "provider": provider}
        if len(secret_key) < 16:
            return {"ok": False, "error": "AWS_SECRET_ACCESS_KEY format looks invalid", "provider": provider}
        return {"ok": True, "status": "format valid", "provider": provider}

    if provider == "azure":
        guid_re = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        for key in ("AZURE_CLIENT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_TENANT_ID"):
            if not guid_re.match(credentials.get(key, "").strip()):
                return {"ok": False, "error": f"{key} must be a GUID", "provider": provider}
        if not credentials.get("AZURE_CLIENT_SECRET", "").strip():
            return {"ok": False, "error": "AZURE_CLIENT_SECRET is required", "provider": provider}
        if not credentials.get("AZURE_RESOURCE_GROUP", "").strip():
            return {"ok": False, "error": "AZURE_RESOURCE_GROUP is required", "provider": provider}
        return {"ok": True, "status": "format valid", "provider": provider}

    if provider == "digitalocean":
        token = credentials.get("DIGITALOCEAN_TOKEN", "").strip()
        try:
            req = urllib.request.Request(
                "https://api.digitalocean.com/v2/account",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                body = json.loads(r.read())
                account_email = body.get("account", {}).get("email")
                status = f"verified{f' ({account_email})' if account_email else ''}"
                return {"ok": True, "status": status, "provider": provider}
        except Exception as e:
            return {"ok": False, "error": str(e), "provider": provider}

    if provider == "hetzner":
        token = credentials.get("HETZNER_DNS_API_KEY", "").strip()
        try:
            req = urllib.request.Request(
                "https://dns.hetzner.com/api/v1/zones",
                headers={"Auth-API-Token": token, "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                body = json.loads(r.read())
                zone_count = len(body.get("zones", []))
                return {"ok": True, "status": f"verified ({zone_count} zones visible)", "provider": provider}
        except Exception as e:
            return {"ok": False, "error": str(e), "provider": provider}

    return {"ok": False, "error": f"Unsupported DNS provider: {provider}", "provider": provider}


def _parse_env_file(path: Path) -> Dict[str, str]:
    data = {}
    if not path.exists():
        return data
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            # Strip surrounding quotes
            v = v.strip()
            if (v.startswith('"') and v.endswith('"')) or \
               (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            data[k.strip()] = v
    return data


def _write_env_file(path: Path, data: Dict[str, str]) -> None:
    lines = ["# InfraWeaver Platform .env — generated by init wizard\n"]
    for k, v in data.items():
        if "\n" in v:
            # Multi-line value (e.g., SSH private key): use heredoc-style quoting
            lines.append(f'{k}="{v}"\n')
        elif any(c in v for c in [' ', '#', '$', '"', "'"]):
            lines.append(f"{k}='{v}'\n")
        else:
            lines.append(f"{k}={v}\n")
    path.write_text("".join(lines))


def _get_status() -> Dict:
    env = _parse_env_file(ENV_FILE)
    provider = _normalize_dns_provider(env.get("DNS_PROVIDER", "cloudflare"))
    required_fields = DNS_PROVIDER_FIELDS.get(provider, [])
    dns_provider_configured = provider == "none" or all(env.get(field, "").strip() for field in required_fields)
    with DEPLOY_STATE_COND:
        deployment_id = DEPLOY_STATE.get("deployment_id") or None
        deploy_running = bool(DEPLOY_STATE.get("running")) or (CURRENT_DEPLOY is not None and CURRENT_DEPLOY.poll() is None)
    return {
        "env_saved": ENV_FILE.exists() and bool(env),
        "ssh_key": bool(env.get("DEPLOYER_SSH_KEY")),
        "domain": bool(env.get("BASE_DOMAIN")),
        "dns_provider": provider,
        "dns_provider_configured": dns_provider_configured,
        "proxmox": False,  # checked via /api/validate-proxmox
        "deploy_running": deploy_running,
        "deploy_id": deployment_id,
    }


def _validate_proxmox(env_data: Dict) -> Dict:
    token = str(env_data.get("PROXMOX_API_TOKEN", "")).strip()
    env_name = env_data.get("ENV_NAME", "productie")
    cluster_yaml = REPO_DIR / "envs" / env_name / "cluster.yaml"
    host = str(env_data.get("PROXMOX_HOST", "")).strip() or "192.168.1.100"
    if cluster_yaml.exists():
        for line in cluster_yaml.read_text().splitlines():
            if "proxmox_host:" in line:
                m = re.search(r'["\']?(\d+\.\d+\.\d+\.\d+)["\']?', line)
                if m:
                    host = m.group(1)
                    break

    try:
        nodes = _proxmox_json_request(host, token, "/nodes") or []
        return {"ok": True, "nodes": ", ".join(str(node.get("node", "")) for node in nodes if node.get("node"))}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _validate_import_env(payload: Dict) -> Dict:
    env_payload = payload.get("env", payload)
    env = {str(k): "" if v is None else str(v) for k, v in dict(env_payload or {}).items()}
    errors: List[Dict[str, str]] = []
    warnings: List[Dict[str, str]] = []

    def add_error(field: str, message: str):
        errors.append({"field": field, "message": message})

    def add_warning(field: str, message: str):
        warnings.append({"field": field, "message": message})

    for field in IMPORT_REQUIRED_ENV_FIELDS:
        if not env.get(field, "").strip():
            add_error(field, "Missing required field.")

    if env.get("BASE_DOMAIN", "").strip() and not _is_valid_domain(env["BASE_DOMAIN"]):
        add_error("BASE_DOMAIN", "Expected a valid domain name.")

    if env.get("PROXMOX_HOST", "").strip() and not _is_valid_ipv4(env["PROXMOX_HOST"]):
        add_error("PROXMOX_HOST", "Expected a valid IPv4 address.")

    node_count_raw = env.get("NODE_COUNT", "").strip()
    node_count = 0
    if node_count_raw:
        if not _is_positive_integer(node_count_raw):
            add_error("NODE_COUNT", "Expected a positive integer.")
        else:
            node_count = int(node_count_raw)

    vip_range = env.get("METALLB_VIP_RANGE", "").strip()
    if vip_range and not _is_valid_vip_range(vip_range):
        add_error("METALLB_VIP_RANGE", "Expected x.x.x.x-x.x.x.x.")

    if node_count > 0:
        for index in range(1, node_count + 1):
            ip_field = f"NODE_{index}_IP"
            ip_value = env.get(ip_field, "").strip()
            if not ip_value:
                add_error(ip_field, f"Node {index} IP is required when NODE_COUNT={node_count}.")
            elif not _is_valid_ipv4(ip_value):
                add_error(ip_field, "Expected a valid IPv4 address.")

            vmid_field = f"NODE_{index}_VMID"
            vmid_value = env.get(vmid_field, "").strip()
            if vmid_value and not _is_positive_integer(vmid_value):
                add_error(vmid_field, "VMID must be numeric.")
            elif not vmid_value:
                add_warning(vmid_field, "Missing VMID; the wizard will use its default sequence.")

    if not any(issue["field"] in {"PROXMOX_HOST", "PROXMOX_API_TOKEN"} for issue in errors):
        proxmox_check = _validate_proxmox({
            "PROXMOX_HOST": env.get("PROXMOX_HOST", ""),
            "PROXMOX_API_TOKEN": env.get("PROXMOX_API_TOKEN", ""),
            "ENV_NAME": env.get("ENV_NAME", "productie"),
        })
        if not proxmox_check.get("ok"):
            add_error("PROXMOX_API_TOKEN", proxmox_check.get("error", "Unable to reach the Proxmox API."))

    return {"valid": not errors, "errors": errors, "warnings": warnings}


def _detect_init_vm_id() -> Optional[int]:
    env_value = os.environ.get("IW_VM_ID", "").strip()
    if _is_positive_integer(env_value):
        return int(env_value)

    product_name_path = Path("/sys/class/dmi/id/product_name")
    if product_name_path.exists():
        try:
            product_name = product_name_path.read_text(errors="ignore").strip()
            match = re.search(r"(\d{3,6})", product_name)
            if match:
                return int(match.group(1))
        except Exception:
            pass
    return None


def _self_update() -> Dict:
    """git pull the repo and return output. Caller schedules process restart."""
    try:
        result = subprocess.run(
            ["git", "pull", "--ff-only", "origin", "main"],
            cwd=str(REPO_DIR),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return {"ok": False, "error": (result.stderr.strip() or result.stdout.strip()) or "git pull failed"}
        return {"ok": True, "output": result.stdout.strip()}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}



    env = _parse_env_file(ENV_FILE)
    vm_id = _detect_init_vm_id()

    try:
        for candidate in Path("/tmp").glob("iw-*"):
            if candidate.is_dir():
                shutil.rmtree(candidate, ignore_errors=True)
            else:
                try:
                    candidate.unlink()
                except FileNotFoundError:
                    pass
    except Exception as e:
        return {"ok": False, "error": f"Failed to remove temporary files: {e}"}

    if vm_id is not None:
        host = env.get("PROXMOX_HOST", "").strip()
        token = env.get("PROXMOX_API_TOKEN", "").strip()
        if not host or not token:
            return {"ok": False, "error": "Detected the init VM but PROXMOX_HOST or PROXMOX_API_TOKEN is missing from .env"}

        node_name = env.get("PROXMOX_NODE_NAME", "").strip() or _find_proxmox_vm_node(host, token, vm_id)
        if not node_name:
            return {"ok": False, "error": f"Unable to determine the Proxmox node for VM {vm_id}"}

        try:
            try:
                _proxmox_json_request(host, token, f"/nodes/{node_name}/qemu/{vm_id}/status/stop", method="POST")
            except Exception:
                pass

            for _ in range(15):
                status = _proxmox_json_request(host, token, f"/nodes/{node_name}/qemu/{vm_id}/status/current") or {}
                if status.get("status") != "running":
                    break
                time.sleep(2)

            _proxmox_json_request(host, token, f"/nodes/{node_name}/qemu/{vm_id}?purge=1", method="DELETE")
        except Exception as e:
            return {"ok": False, "error": f"Failed to remove init VM {vm_id}: {e}"}

    return {"ok": True, "vmId": vm_id, "stopServer": stop_server}


def _sse_json(payload: Dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _record_deploy_event(deployment_id: int, event_type: str, **payload):
    with DEPLOY_STATE_COND:
        if DEPLOY_STATE["deployment_id"] != deployment_id:
            return None
        seq = DEPLOY_STATE["next_seq"]
        DEPLOY_STATE["next_seq"] += 1
        event = {"type": event_type, "seq": seq, "deploymentId": deployment_id, **payload}
        DEPLOY_STATE["events"].append(event)

        if event_type == "progress":
            DEPLOY_STATE["progress"] = int(payload.get("pct", DEPLOY_STATE["progress"]))
            DEPLOY_STATE["step"] = str(payload.get("step", DEPLOY_STATE["step"]))
        elif event_type == "done":
            DEPLOY_STATE["running"] = False
            DEPLOY_STATE["progress"] = 100
            DEPLOY_STATE["step"] = "Complete!"
            DEPLOY_STATE["summary"] = str(payload.get("summary", ""))
            DEPLOY_STATE["error"] = ""
            DEPLOY_STATE["completed_at"] = time.time()
        elif event_type == "error":
            DEPLOY_STATE["running"] = False
            DEPLOY_STATE["error"] = str(payload.get("text", ""))
            DEPLOY_STATE["completed_at"] = time.time()

        DEPLOY_STATE_COND.notify_all()
        return event


def _run_deploy(mode: str, deployment_id: int):
    global CURRENT_DEPLOY

    env = _parse_env_file(ENV_FILE)
    if not env and mode == "deploy":
        _record_deploy_event(deployment_id, "error", text="No .env file found. Save your configuration first.")
        if DEPLOY_LOCK.locked():
            DEPLOY_LOCK.release()
        return

    script = REPO_DIR / "scripts" / ("redeploy-local.sh" if mode == "redeploy" else "deploy-local.sh")
    if not script.exists():
        _record_deploy_event(deployment_id, "error", text=f"Script not found: {script}")
        if DEPLOY_LOCK.locked():
            DEPLOY_LOCK.release()
        return

    proc_env = os.environ.copy()
    proc_env.update({
        "ENV_FILE": str(ENV_FILE),
        "IW_REPO_DIR": str(REPO_DIR),
        "PYTHONUNBUFFERED": "1",
    })
    for k, v in env.items():
        proc_env[k] = v

    progress_markers = [
        ("Installing tools", 5, "Installing tools"),
        ("Clearing state", 10, "Clearing old state"),
        ("tofu apply", 20, "Provisioning VMs"),
        ("Stage 2a", 35, "Deploying ArgoCD Helm"),
        ("Stage 2b", 50, "Full platform bootstrap"),
        ("Deploy ArgoCD", 55, "Deploying ArgoCD"),
        ("Bootstrap OpenBao", 65, "Bootstrapping OpenBao"),
        ("Ensuring DNS records", 70, "Configuring DNS"),
        ("Apply MetalLB", 75, "Applying MetalLB"),
        ("Reconnect NetBird", 80, "NetBird reconnect"),
        ("Patch cluster CoreDNS", 82, "Patching CoreDNS"),
        ("Configure certificate", 85, "TLS certificates"),
        ("Set Authentik admin", 90, "Configuring Authentik"),
        ("Run post-deploy", 95, "Post-deploy tests"),
        ("Deployment complete", 100, "Complete!"),
    ]

    _record_deploy_event(deployment_id, "progress", pct=0, step="Starting deploy...")
    _record_deploy_event(deployment_id, "log", text=f"==> Running {script.name} in {REPO_DIR}")

    try:
        proc = subprocess.Popen(
            ["bash", str(script)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(REPO_DIR),
            env=proc_env,
            bufsize=1,
            universal_newlines=True,
        )
        CURRENT_DEPLOY = proc

        for line in proc.stdout or []:
            line = line.rstrip("\n")
            _record_deploy_event(deployment_id, "log", text=line)
            for marker, pct, step_text in progress_markers:
                if marker.lower() in line.lower():
                    _record_deploy_event(deployment_id, "progress", pct=pct, step=step_text)
                    break

        proc.wait()
        CURRENT_DEPLOY = None

        if proc.returncode == 0:
            _record_deploy_event(deployment_id, "progress", pct=100, step="Complete!")
            _record_deploy_event(deployment_id, "done", summary="Platform deployed successfully! Check the log above for service URLs.")
        else:
            _record_deploy_event(deployment_id, "error", text=f"Deploy script exited with code {proc.returncode}. See log for details.")
    except Exception as e:
        CURRENT_DEPLOY = None
        _record_deploy_event(deployment_id, "error", text=str(e))
    finally:
        with DEPLOY_STATE_COND:
            if DEPLOY_STATE["deployment_id"] == deployment_id and DEPLOY_STATE["completed_at"] is None and not DEPLOY_STATE["running"]:
                DEPLOY_STATE["completed_at"] = time.time()
            DEPLOY_STATE_COND.notify_all()
        if DEPLOY_LOCK.locked():
            DEPLOY_LOCK.release()


def _start_deploy(mode: str) -> int:
    with DEPLOY_STATE_COND:
        deployment_id = int(DEPLOY_STATE["deployment_id"]) + 1
        DEPLOY_STATE.update({
            "deployment_id": deployment_id,
            "running": True,
            "mode": mode,
            "progress": 0,
            "step": "Starting deploy...",
            "summary": "",
            "error": "",
            "events": [],
            "next_seq": 1,
            "started_at": time.time(),
            "completed_at": None,
        })
        DEPLOY_STATE_COND.notify_all()
    threading.Thread(target=_run_deploy, args=(mode, deployment_id), daemon=True).start()
    return deployment_id


def _iter_deploy_events(deployment_id: Optional[int] = None, since_seq: int = 0):
    last_seq = since_seq
    target_id = deployment_id
    while True:
        heartbeat = False
        with DEPLOY_STATE_COND:
            current_id = int(DEPLOY_STATE.get("deployment_id") or 0)
            if target_id is None:
                target_id = current_id or None
            events = []
            running = False
            if target_id is not None and current_id == target_id:
                events = [event for event in DEPLOY_STATE["events"] if int(event.get("seq", 0)) > last_seq]
                running = bool(DEPLOY_STATE["running"])
            if not events and running:
                DEPLOY_STATE_COND.wait(timeout=15)
                current_id = int(DEPLOY_STATE.get("deployment_id") or 0)
                if current_id == target_id:
                    events = [event for event in DEPLOY_STATE["events"] if int(event.get("seq", 0)) > last_seq]
                    running = bool(DEPLOY_STATE["running"])
                else:
                    events = []
                    running = False
                heartbeat = not events and running
            if not events and not running:
                break

        for event in events:
            last_seq = max(last_seq, int(event.get("seq", 0)))
            yield _sse_json(event)
        if heartbeat:
            yield ": keep-alive\n\n"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Suppress access log spam
        if "/api/" not in self.path:
            pass  # suppress static file logs
        else:
            super().log_message(fmt, *args)

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, path: Path):
        content = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_static_file(self, path: Path):
        content = path.read_bytes()
        mime_type = EXT_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if mime_type.startswith("text/"):
            mime_type = f"{mime_type}; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path in ("/", "/index.html"):
            static_index = OUT_DIR / "index.html"
            if static_index.exists():
                self._send_static_file(static_index)
            else:
                html = TEMPLATE_DIR / "index.html"
                if html.exists():
                    self._send_html(html)
                else:
                    self._send_json({"error": "UI not found"}, 404)
            return

        if path == "/api/status":
            self._send_json(_get_status())
            return

        if path == "/api/load-env":
            try:
                data = _parse_env_file(ENV_FILE)
                # Don't send private key in cleartext over GET — send masked version
                if "DEPLOYER_SSH_KEY" in data and data["DEPLOYER_SSH_KEY"]:
                    data["DEPLOYER_SSH_KEY"] = data["DEPLOYER_SSH_KEY"]  # send full for editing
                self._send_json({"ok": True, "data": data})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)})
            return

        if path == "/api/health":
            self._send_json({"ok": True, "repo": str(REPO_DIR)})
            return

        if path == "/api/detect-subnet":
            subnets = _detect_local_subnets()
            self._send_json({"ok": True, "subnets": subnets})
            return

        if path == "/api/ping-check":
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            ip = params.get("ip", [""])[0].strip()
            if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip):
                self._send_json({"ok": False, "error": "invalid IP"}, 400)
                return
            self._send_json(_ping_check_single(ip))
            return

        if path == "/api/ping-proxmox":
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            host = params.get("host", [""])[0].strip()
            if not host:
                self._send_json({"ok": False, "error": "host required"}, 400)
                return
            self._send_json(_ping_proxmox(host))
            return

        if path == "/api/catalog-items":
            catalog = []
            catalog_dir = REPO_DIR / "kubernetes" / "catalog"
            if catalog_dir.exists():
                for item_dir in sorted(catalog_dir.iterdir()):
                    if not item_dir.is_dir() or item_dir.name.startswith("_"):
                        continue
                    meta = {"slug": item_dir.name}
                    yaml_file = item_dir / "catalog.yaml"
                    if yaml_file.exists():
                        try:
                            content = yaml_file.read_text()
                            for field in ["name", "description", "categories", "tier"]:
                                m = re.search(rf"^{field}:\s*(.+)$", content, re.MULTILINE)
                                if m:
                                    meta[field] = m.group(1).strip().strip('"\'')
                        except Exception:
                            pass
                    catalog.append(meta)
            self._send_json({"ok": True, "items": catalog})
            return

        if path == "/api/get-kubeconfig":
            env_name = _parse_env_file(ENV_FILE).get("ENV_NAME", "productie")
            candidates = [
                REPO_DIR / "generated" / "kubeconfig",
                REPO_DIR / "envs" / env_name / "generated" / "kubeconfig",
                Path.home() / ".kube" / f"config-platform-{env_name}",
            ]
            for kube in candidates:
                if kube.exists():
                    self._send_json({"ok": True, "kubeconfig": kube.read_text()})
                    return
            self._send_json({"ok": False, "error": "kubeconfig not found at generated/kubeconfig"})
            return

        if path == "/api/deploy-events":
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            deployment_id_raw = params.get("deploymentId", [""])[0].strip()
            since_raw = params.get("since", ["0"])[0].strip()
            deployment_id = int(deployment_id_raw) if deployment_id_raw.isdigit() else None
            since_seq = int(since_raw) if since_raw.isdigit() else 0

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            try:
                for chunk in _iter_deploy_events(deployment_id=deployment_id, since_seq=since_seq):
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if OUT_DIR.exists():
            relative_path = path.lstrip("/")
            candidate = (OUT_DIR / relative_path).resolve()
            try:
                candidate.relative_to(OUT_DIR.resolve())
            except ValueError:
                candidate = None
            if candidate and candidate.is_file():
                self._send_static_file(candidate)
                return

        self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len else b"{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        if path == "/api/save-env":
            try:
                data = {}
                for k, v in payload.items():
                    if isinstance(v, bool):
                        data[k] = "true" if v else "false"
                    elif v is None:
                        data[k] = ""
                    else:
                        data[k] = str(v)
                for k in ALL_ENV_FIELDS:
                    data.setdefault(k, ALL_ENV_DEFAULTS.get(k, ""))

                def keep_empty(key: str) -> bool:
                    return key in FEATURE_ENV_FIELDS or key in DNS_ENV_FIELDS or key in OPTIONAL_ENV_FIELDS or key in CLUSTER_ENV_FIELDS or key in INFRA_ENV_FIELDS or key in {"LOCAL_IP_RANGES", "NODE_COUNT"} or bool(re.match(r"^NODE_\d+_(IP|VMID|PVE_NODE|DATASTORE|CPU|MEMORY|DISK|ROLE)$", key))

                _write_env_file(ENV_FILE, {k: v for k, v in data.items() if v != "" or keep_empty(k)})
                self._send_json({"ok": True})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)})
            return

        if path == "/api/setup-proxmox-user":
            host     = payload.get("host", "").strip()
            username = payload.get("username", "").strip()
            password = payload.get("password", "")
            if not host or not username or not password:
                self._send_json({"ok": False, "error": "host, username and password are required"}, 400)
                return
            self._send_json(_setup_proxmox_user(host, username, password))
            return

        if path == "/api/validate-proxmox":
            result = _validate_proxmox(payload)
            self._send_json(result)
            return

        if path == "/api/validate-env":
            env_payload = payload.get("env") if isinstance(payload, dict) else None
            if not isinstance(env_payload, dict):
                self._send_json({"valid": False, "errors": [{"field": "env", "message": "env object is required"}], "warnings": []}, 400)
                return
            self._send_json(_validate_import_env(payload))
            return

        if path == "/api/self-update":
            result = _self_update()
            self._send_json(result)
            if result.get("ok"):
                # Replace the running process with a fresh copy of itself after the response flushes
                threading.Timer(0.8, lambda: os.execv(sys.executable, [sys.executable] + sys.argv)).start()
            return

        if path == "/api/cleanup-init":
            result = _cleanup_init_server(bool(payload.get("stopServer")))
            if result.get("ok") and payload.get("stopServer"):
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            self._send_json(result)
            return

        if path == "/api/discover-proxmox":
            host = payload.get("host", "").strip()
            token = payload.get("token", "").strip()
            if not host or not token:
                self._send_json({"ok": False, "error": "host and token required"}, 400)
                return
            self._send_json(_discover_proxmox(host, token))
            return

        if path == "/api/suggest-vips":
            gateway = payload.get("gateway", "").strip()
            prefix = int(payload.get("prefix", 24))
            if not gateway:
                self._send_json({"ok": False, "error": "gateway required"}, 400)
                return
            self._send_json(_suggest_vips(gateway, prefix))
            return

        if path == "/api/suggest-node-ips":
            gateway = payload.get("gateway", "").strip()
            prefix = int(payload.get("prefix", 24))
            if not gateway:
                self._send_json({"ok": False, "error": "gateway required"}, 400)
                return
            self._send_json(_suggest_node_ips(gateway, prefix))
            return

        if path == "/api/generate-ssh-key":
            self._send_json(_generate_ssh_key())
            return

        if path in ("/api/check-dns-provider", "/api/check-cloudflare"):
            provider = _normalize_dns_provider(payload.get("provider", "cloudflare" if path.endswith("cloudflare") else payload.get("provider", "cloudflare")))
            credentials = payload.get("credentials", payload)
            if path.endswith("cloudflare"):
                credentials = {"CLOUDFLARE_API_TOKEN": payload.get("token", "").strip()}
                provider = "cloudflare"
            required_fields = DNS_PROVIDER_FIELDS.get(provider, [])
            missing = [field for field in required_fields if not str(credentials.get(field, "")).strip()]
            if provider != "none" and missing:
                self._send_json({"ok": False, "error": f"Missing required fields: {', '.join(missing)}"}, 400)
                return
            self._send_json(_check_dns_provider(provider, credentials))
            return

        if path in ("/api/deploy", "/api/redeploy"):
            mode = payload.get("mode", "redeploy" if path == "/api/redeploy" else "deploy")

            if not DEPLOY_LOCK.acquire(blocking=False):
                self._send_json({"error": "A deploy is already running"}, 409)
                return

            deployment_id = _start_deploy(mode)

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            try:
                for chunk in _iter_deploy_events(deployment_id=deployment_id, since_seq=0):
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        self._send_json({"error": "Not found"}, 404)


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--host", default=HOST)
    args = p.parse_args()

    print(f"""
╔══════════════════════════════════════════════════════╗
║    InfraWeaver Init Server                           ║
╚══════════════════════════════════════════════════════╝
  Repo   : {REPO_DIR}
  UI     : http://{args.host}:{args.port}
  Press Ctrl+C to stop
""", flush=True)

    server = ThreadedServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
