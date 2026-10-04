# Proxmox VM deployment

1. Map the Z-Wave USB stick in Proxmox (Datacenter > Resource Mappings > USB), e.g. `zwave`.
2. Clone an Ubuntu cloud-init template, give it a static IP (`qm set <vmid> --ipconfig0 ip=<ip>/24,gw=<gw>`) and add the stick: `qm set <vmid> --usb0 mapping=zwave`.
3. Enable `snippets` on a directory storage, fill `<YOUR_SSH_PUBLIC_KEY>` in `user-data.yaml`, copy it to `/var/lib/vz/snippets/zwave-alarm-user.yaml` on the node, then `qm set <vmid> --cicustom user=local:snippets/zwave-alarm-user.yaml`.
4. Start the VM. It installs Docker and the generic kernel (rebooting once if `cdc_acm` is missing), then runs `ghcr.io/judeibe/zwave_alarm:main` from `/opt/zwave-alarm`.

## Z-Wave security keys

The keys never go in git or in `user-data.yaml`. Add them to `/opt/zwave-alarm/.env` on the VM as `ZWAVE_KEY_S2_UNAUTHENTICATED`, `ZWAVE_KEY_S2_AUTHENTICATED`, `ZWAVE_KEY_S2_ACCESS_CONTROL`, `ZWAVE_KEY_S0_LEGACY`, `ZWAVE_LR_KEY_S2_AUTHENTICATED` and `ZWAVE_LR_KEY_S2_ACCESS_CONTROL` (32 hex characters each), either over SSH or through the guest agent (`cv4pve-cli api create /nodes/<node>/qemu/<vmid>/agent/exec --command /bin/sh --input-data "<script>"`). Then `cd /opt/zwave-alarm && docker compose pull && docker compose up -d`.

## Releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); pull requests fail CI if any commit does not. Every push to `main` is versioned from the commits since the last tag: `fix` gives a patch release, `feat` a minor one, and a `BREAKING CHANGE:` footer (or `!` after the type) a major one, whatever the type. Other types (`docs`, `chore`, `ci`, ...) do not release.

A release bumps `package.json`, `package-lock.json` and the Home Assistant manifest together, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, creates the GitHub release and pushes the `X.Y.Z`, `X.Y`, `X` and `latest` images. The first run, with no tag yet, releases the current `package.json` version (1.0.0). Actions > CI > Run workflow on `main` can force a bump. To run a fixed version, change the image tag in the VM's `docker-compose.yml`.
