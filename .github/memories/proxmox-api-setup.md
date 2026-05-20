---
title: Proxmox API Auto-Setup — infraweaver@pve token creation
description: How the init wizard creates a Proxmox API user+token from root credentials without storing root password.
---

# Proxmox API Auto-Setup

## Memory

- **File:** `scripts/init/server.py` → `_setup_proxmox_user()` function
- **Purpose:** Takes root credentials once, creates `infraweaver@pve` user + API token, returns token — never stores root creds.

## Flow

1. User enters root credentials in wizard ProxmoxStep "Auto-setup" tab
2. POST `/api/setup-proxmox-user` with `{"host": "...", "username": "root@pam", "password": "..."}`
3. `_setup_proxmox_user()` in server.py:
   a. Authenticates as root, gets a ticket
   b. Creates role `InfraWeaver` with required privs (or updates existing)
   c. Creates user `infraweaver@pve` (or skips if exists)
   d. Creates API token `infraweaver@pve!infraweaver-init` (or reuses existing)
   e. Grants ACL at `/` for `infraweaver@pve` with role `InfraWeaver`
   f. Returns `{"token": "infraweaver@pve!infraweaver-init=<secret>"}`
4. Frontend auto-fills the token field and switches to "Manual" tab

## Role Privileges Required

```
Datastore.Allocate, Datastore.AllocateSpace, Datastore.AllocateTemplate,
VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt, VM.Console,
Sys.Audit, SDN.Use
```

## Bug Fixed: Role Creation 500 Error

**Original bug:** `except Exception: pass` silently swallowed ALL errors from both POST (create role) and PUT (update role privs), then tried to assign ACL for a non-existent role → Proxmox returned 500 "role does not exist".

**Fix:**
```python
try:
    _pve_req(ticket, "POST", "/access/roles", {"roleid": "InfraWeaver", "privs": PRIVS})
except urllib.error.HTTPError as err:
    body = err.read().decode()
    if "already exist" not in body.lower():
        return {"error": f"Failed to create role: {body}"}
    # Role exists — update it
    _pve_req(ticket, "PUT", "/access/roles/InfraWeaver", {"privs": PRIVS, "append": "0"})
```

**Why `append=0`:** Without `append=0`, PUT only appends privs — doesn't remove stale ones. `append=0` fully replaces.

## Creds Never Stored

Root credentials are only used in the current HTTP request context. They are never written to disk, stored in `.env`, or returned in any response. The only persistent output is the API token string.
