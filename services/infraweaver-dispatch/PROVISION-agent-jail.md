# /approve coding-agent OS jail — host provisioning (CRITICAL-1)

`SECURITY-SCAN-2026-07-08` CRITICAL-1: the `/approve` coding agent runs the Bash
tool on attacker-influenced feedback text. The env-scrub (`agent-sandbox.js`)
removed credential env vars, but the agent still ran as the dispatch Unix user
(`runner`) — passwordless sudo, docker group, and on-disk kube/ssh/docker creds
reachable through `HOME`. This closes that by running the agent as a dedicated
low-privilege UID inside a mount-namespace jail.

## Components

- **`iw-agent-jail`** (vendored here; installed to `/usr/local/sbin/iw-agent-jail`,
  root:root 0755) — root helper invoked as `sudo -n iw-agent-jail --workdir <dir>
  -- <cmd> …`. It enters a private mount+pid namespace, tmpfs-mounts over
  `/home/runner` (hiding every operator credential), binds back ONLY the repo
  (rw), the claude ELF (ro) and a private copy of the model auth, then drops to
  `iw-agent` with `setpriv --init-groups --no-new-privs --inh-caps=-all` and a
  clean `env -i`.
- **`agent-sandbox.js:buildJailLaunch()`** — composes the `sudo … iw-agent-jail`
  argv. Enabled when `AGENT_JAIL_SCRIPT` is set.
- **`server.js:runAgent()`** — env-scrub → `buildJailLaunch` → optional
  `buildAgentLaunch` network jail.

## One-time host setup (NOT in git — re-run on a rebuilt host)

```bash
# 1. Dedicated low-priv user + shared repo group (runner + iw-agent).
sudo groupadd --system iwrepo
sudo useradd  --system --create-home --home-dir /home/iw-agent \
      --shell /usr/sbin/nologin --gid iwrepo \
      --comment "InfraWeaver /approve coding-agent jail" iw-agent
sudo usermod -aG iwrepo runner
# iw-agent is in NO other group — not sudo, not docker.

# 2. Repo access for iw-agent via the shared group (setgid so new files inherit).
sudo chgrp -R iwrepo /home/runner/InfraWeaver-platform
sudo chmod -R g+rwX  /home/runner/InfraWeaver-platform
sudo find /home/runner/InfraWeaver-platform -type d -exec chmod g+s {} +

# 3. Jail helper + its namespace-private scratch dir.
sudo install -d -m 0700 -o root -g root /var/lib/iw-agent-jail
sudo install -m 0755 -o root -g root \
      /home/runner/infraweaver-dispatch/iw-agent-jail /usr/local/sbin/iw-agent-jail

# 4. Enable it in the dispatch systemd unit, then reload+restart.
#    Environment=AGENT_JAIL_SCRIPT=/usr/local/sbin/iw-agent-jail
sudo systemctl daemon-reload && sudo systemctl restart infraweaver-dispatch.service
```

No new sudoers rule is needed: `runner` already has `NOPASSWD:ALL`, and the jail
runs the agent DOWN at `iw-agent` (which itself has no sudo). Startup logs
`[SECURITY] agent OS jail ACTIVE (CRITICAL-1)` when wired.

## Environment constraints that shaped this design

- Unprivileged user namespaces are AppArmor-restricted
  (`kernel.apparmor_restrict_unprivileged_userns=1`), so `bwrap`/`unshare --user`
  fail — the jail uses **real root via sudo** (`unshare --mount` + `setpriv`),
  not userns.
- `claude` is a standalone ELF under `~/.local/share/claude` (0700 parent); the
  jail rebuilds a minimal install in the tmpfs and binds just the ELF.
- `~/.claude` is 3.6 G (projects/history); the jail copies ONLY the ~500 B
  `.credentials.json` + `.claude.json`. The tmpfs HOME is size-capped (1 G) so a
  runaway agent write cannot exhaust host RAM (no swap on this box).

## Verify

```bash
sudo -n /usr/local/sbin/iw-agent-jail --workdir /home/runner/InfraWeaver-platform -- \
  /bin/bash -c 'id; ls /home/runner/.kube 2>&1; sudo -n true && echo BAD || echo BLOCKED'
# expect: uid=…(iw-agent) gid=…(iwrepo); .kube "No such file or directory"; BLOCKED
```
