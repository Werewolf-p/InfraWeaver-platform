#!/usr/bin/env python3
"""
list-recovery-users.py — Print usernames that have send_recovery_email: true
in users.yaml. Used by the apply-changes workflow to know which users need
recovery links generated.

Usage:
  python3 .github/scripts/list-recovery-users.py
"""
import yaml

with open("users.yaml") as f:
    config = yaml.safe_load(f)

for username, udata in config.get("users", {}).items():
    if udata.get("send_recovery_email", False):
        print(username)
