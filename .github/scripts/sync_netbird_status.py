#!/usr/bin/env python3
"""
Sync sanitized NetBird status into repository memory file.
Reads /home/runner/.netbird_status.json (private runtime file) and updates
platform/.github/memories/netbird-external-vm-setup.md with non-sensitive
fields: management_url, routes (network + enabled), last_verified.

This script MUST NOT write secrets (api_pat, setup_key, tokens) into git.
"""
import json
from datetime import datetime
from pathlib import Path

STATUS_PATH = Path('/home/runner/.netbird_status.json')
MEMORY_PATH = Path('/home/runner/platform/.github/memories/netbird-external-vm-setup.md')

if not STATUS_PATH.exists():
    print('Status file not found:', STATUS_PATH)
    raise SystemExit(1)

data = json.loads(STATUS_PATH.read_text())
management_url = data.get('management_url')
routes = data.get('routes', [])
last_verified = data.get('last_verified') or datetime.utcnow().isoformat() + 'Z'

# Build sanitized block
lines = []
lines.append('## Live status file (sanitized)')
lines.append(f"- **Management URL:** {management_url}")
lines.append('- **Routes (sanitized, no secrets):**')
for r in routes:
    network = r.get('network')
    peer = r.get('peer')
    enabled = r.get('enabled')
    lines.append(f"  - {network} -> peer={peer} enabled={enabled}")
lines.append(f"- **Last verified:** {last_verified}")
lines.append('')
lines.append('Note: secrets (API PAT, setup keys, DB encryption keys) are intentionally omitted from this memory.\n')

# Replace section between marker and Related Files
if not MEMORY_PATH.exists():
    print('Memory file not found:', MEMORY_PATH)
    raise SystemExit(1)

text = MEMORY_PATH.read_text()
start_marker_variants = ['## Live status file (private)', '## Live status file (sanitized)']
end_marker = '## Related Files'
found = False
for sm in start_marker_variants:
    if sm in text and end_marker in text:
        start_marker = sm
        found = True
        break
if found:
    pre, rest = text.split(start_marker, 1)
    _, post = rest.split(end_marker, 1)
    new_text = pre + '\n'.join(['', *lines, end_marker]) + post
    MEMORY_PATH.write_text(new_text)
    print('Memory file updated (sanitized).')
else:
    print('Markers not found in memory file; aborting.')
    raise SystemExit(2)
