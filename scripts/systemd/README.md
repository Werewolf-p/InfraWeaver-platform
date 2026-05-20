Place the unit files under /etc/systemd/system/ or use systemd --user.

To enable (system-level):
  sudo cp netbird-sync.service /etc/systemd/system/
  sudo cp netbird-sync.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now netbird-sync.timer

To enable for a user (systemd --user):
  mkdir -p ~/.config/systemd/user
  cp netbird-sync.service ~/.config/systemd/user/
  cp netbird-sync.timer ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now netbird-sync.timer

The service runs the sync script which updates platform/.github/memories/netbird-external-vm-setup.md with sanitized runtime data. Secrets are not written to git.
