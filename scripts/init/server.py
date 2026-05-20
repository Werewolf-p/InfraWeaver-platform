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
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Dict, Optional
import socketserver

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
    "NODE_1_IP", "NODE_1_VMID",
    "NODE_2_IP", "NODE_2_VMID",
    "NODE_3_IP", "NODE_3_VMID",
]

CLUSTER_DEFAULTS = {
    "PROXMOX_HOST": "192.168.1.100",
    "PROXMOX_NODE_NAME": "pve",
    "K8S_CLUSTER_NAME": "infraweaver-prod",
    "NODE_GATEWAY": "10.10.0.1",
    "NODE_SUBNET_PREFIX": "24",
    "TALOS_DATASTORE": "lvm-proxmox",
    "NODE_1_IP": "10.10.0.90",
    "NODE_1_VMID": "9310",
    "NODE_2_IP": "10.10.0.91",
    "NODE_2_VMID": "9311",
    "NODE_3_IP": "10.10.0.92",
    "NODE_3_VMID": "9312",
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
            "VM.Monitor", "VM.Audit", "VM.PowerMgmt", "VM.Console",
            "VM.Migrate", "VM.Snapshot", "VM.Snapshot.Rollback",
            "Datastore.AllocateSpace", "Datastore.AllocateTemplate", "Datastore.Audit",
            "Pool.Allocate", "SDN.Use", "Sys.Audit",
        ])
        try:
            pve_req("POST", "/access/roles",
                    {"roleid": "InfraWeaver", "privs": PRIVS}, ticket, csrf)
        except Exception:
            # Role already exists — update its privileges instead
            try:
                pve_req("PUT", "/access/roles/InfraWeaver",
                        {"privs": PRIVS}, ticket, csrf)
            except Exception:
                pass  # Ignore — role is fine as-is

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
        node_name = node_names[0] if node_names else "pve"

        # Get storage pools for the first node
        storages = pve_get(f"/nodes/{node_name}/storage")
        USABLE_TYPES = {"lvmthin", "lvm", "dir", "zfspool", "nfs", "cephfs"}
        datastores = [
            s["storage"] for s in storages
            if s.get("enabled", 1) and s.get("type") in USABLE_TYPES
        ]

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
            "node_name": node_name,
            "all_nodes": node_names,
            "datastores": datastores,
            "vmid_suggestions": vmids,
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
    return {
        "env_saved": ENV_FILE.exists() and bool(env),
        "ssh_key": bool(env.get("DEPLOYER_SSH_KEY")),
        "domain": bool(env.get("BASE_DOMAIN")),
        "dns_provider": provider,
        "dns_provider_configured": dns_provider_configured,
        "proxmox": False,  # checked via /api/validate-proxmox
        "deploy_running": CURRENT_DEPLOY is not None and CURRENT_DEPLOY.poll() is None,
    }


def _validate_proxmox(env_data: Dict) -> Dict:
    token = env_data.get("PROXMOX_API_TOKEN", "")
    # Extract host from cluster.yaml
    env_name = env_data.get("ENV_NAME", "productie")
    cluster_yaml = REPO_DIR / "envs" / env_name / "cluster.yaml"
    host = env_data.get("PROXMOX_HOST", "").strip() or "192.168.1.100"
    if cluster_yaml.exists():
        for line in cluster_yaml.read_text().splitlines():
            if "proxmox_host:" in line:
                m = re.search(r'["\']?(\d+\.\d+\.\d+\.\d+)["\']?', line)
                if m:
                    host = m.group(1)
                    break

    import urllib.request
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    url = f"https://{host}:8006/api2/json/nodes"
    req = urllib.request.Request(url, headers={"Authorization": f"PVEAPIToken={token}"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            body = json.loads(resp.read())
            nodes = [n.get("node") for n in body.get("data", [])]
            return {"ok": True, "nodes": ", ".join(nodes)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _stream_deploy(mode: str):
    """Generator: runs deploy-local.sh or redeploy-local.sh, yields SSE lines."""
    global CURRENT_DEPLOY

    env = _parse_env_file(ENV_FILE)
    if not env and mode == "deploy":
        yield f"data: {json.dumps({'type':'error','text':'No .env file found. Save your configuration first.'})}\n\n"
        return

    if mode == "redeploy":
        script = REPO_DIR / "scripts" / "redeploy-local.sh"
    else:
        script = REPO_DIR / "scripts" / "deploy-local.sh"

    if not script.exists():
        yield f"data: {json.dumps({'type':'error','text':f'Script not found: {script}'})}\n\n"
        return

    proc_env = os.environ.copy()
    proc_env.update({
        "ENV_FILE": str(ENV_FILE),
        "IW_REPO_DIR": str(REPO_DIR),
        "PYTHONUNBUFFERED": "1",
    })
    # Export env vars directly so scripts can use them
    for k, v in env.items():
        proc_env[k] = v

    # Progress markers emitted when these strings appear in output
    PROGRESS = [
        ("Installing tools",           5,  "Installing tools"),
        ("Clearing state",             10, "Clearing old state"),
        ("tofu apply",                 20, "Provisioning VMs"),
        ("Stage 2a",                   35, "Deploying ArgoCD Helm"),
        ("Stage 2b",                   50, "Full platform bootstrap"),
        ("Deploy ArgoCD",              55, "Deploying ArgoCD"),
        ("Bootstrap OpenBao",          65, "Bootstrapping OpenBao"),
        ("Ensuring DNS records",      70, "Configuring DNS"),
        ("Apply MetalLB",              75, "Applying MetalLB"),
        ("Reconnect NetBird",          80, "NetBird reconnect"),
        ("Patch cluster CoreDNS",      82, "Patching CoreDNS"),
        ("Configure certificate",      85, "TLS certificates"),
        ("Set Authentik admin",        90, "Configuring Authentik"),
        ("Run post-deploy",            95, "Post-deploy tests"),
        ("Deployment complete",       100, "Complete!"),
    ]

    yield f"data: {json.dumps({'type':'progress','pct':0,'step':'Starting deploy...'})}\n\n"
    yield f"data: {json.dumps({'type':'log','text':f'==> Running {script.name} in {REPO_DIR}'})}\n\n"

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

        for line in proc.stdout:
            line = line.rstrip("\n")
            yield f"data: {json.dumps({'type':'log','text':line})}\n\n"

            # Emit progress events
            for marker, pct, step_text in PROGRESS:
                if marker.lower() in line.lower():
                    yield f"data: {json.dumps({'type':'progress','pct':pct,'step':step_text})}\n\n"
                    break

        proc.wait()
        CURRENT_DEPLOY = None

        if proc.returncode == 0:
            yield f"data: {json.dumps({'type':'progress','pct':100,'step':'Complete!'})}\n\n"
            yield f"data: {json.dumps({'type':'done','summary':'Platform deployed successfully! Check the log above for service URLs.'})}\n\n"
        else:
            yield f"data: {json.dumps({'type':'error','text':f'Deploy script exited with code {proc.returncode}. See log for details.'})}\n\n"

    except Exception as e:
        CURRENT_DEPLOY = None
        yield f"data: {json.dumps({'type':'error','text':str(e)})}\n\n"


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
                for k in ALL_ENV_FIELDS:
                    v = payload.get(k, "")
                    if v or k in FEATURE_ENV_FIELDS or k in DNS_ENV_FIELDS or k in CLUSTER_ENV_FIELDS or k in INFRA_ENV_FIELDS:
                        data[k] = v if v else ALL_ENV_DEFAULTS.get(k, "")
                _write_env_file(ENV_FILE, {k: v for k, v in data.items() if v})
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

        if path == "/api/deploy":
            mode = payload.get("mode", "deploy")

            if not DEPLOY_LOCK.acquire(blocking=False):
                self._send_json({"error": "A deploy is already running"}, 409)
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            try:
                for chunk in _stream_deploy(mode):
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                DEPLOY_LOCK.release()
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
