# Proxmox VM deployment

1. Map the Z-Wave USB stick in Proxmox (Datacenter > Resource Mappings > USB), e.g. `zwave`.
2. Clone an Ubuntu cloud-init template, give it a static IP (`qm set <vmid> --ipconfig0 ip=<ip>/24,gw=<gw>`) and add the stick: `qm set <vmid> --usb0 mapping=zwave`.
3. Enable `snippets` on a directory storage, fill `<YOUR_SSH_PUBLIC_KEY>` in `user-data.yaml`, copy it to `/var/lib/vz/snippets/zwave-alarm-user.yaml` on the node, then `qm set <vmid> --cicustom user=local:snippets/zwave-alarm-user.yaml`.
4. Start the VM. It installs Docker and the generic kernel (rebooting once if `cdc_acm` is missing), then runs `ghcr.io/judeibe/zwave_alarm:main` from `/opt/zwave-alarm`.

## Z-Wave stick not available to the service

The service stays up when it cannot open the stick: `/healthz` returns 200, but `GET /api/v1/panel` reports `"driver": {"status": "failed", "lastError": "...", ...}` and sensor discovery returns 503 ("The zwave-js driver is not ready yet"). The service retries the stick itself with a backoff (2 s doubling to 60 s), which covers a stick that is briefly busy but not a device that was never passed into the container. It also retries when the stick opens but stops answering during startup.

1. `ls -l /dev/serial/by-id/` on the VM must list the stick. If it does not, check the Proxmox USB mapping and that `cdc_acm` is loaded (`lsmod | grep cdc_acm`; the first boot reboots to load it).
2. `grep devices -A2 /opt/zwave-alarm/docker-compose.yml` must show a real by-id name. If it still shows `__ZWAVE_BY_ID__` (or `your-controller` in the repository's `docker-compose.yml`), the stick was not found at first boot and nothing was started: cloud-init writes this to `/etc/motd` and `/var/log/zwave-alarm-setup.log`. Replace the placeholder with the name from step 1.
3. `cd /opt/zwave-alarm && docker compose up -d --force-recreate`. A container only gets its devices when it is created, so a restart is not enough after changing them.
4. `docker exec zwave-alarm ls -l /dev/zwave` must exist, and `docker logs zwave-alarm --tail 100` should show `zwave-js driver ready`. An `EBUSY` error means another program (Z-Wave JS UI, a Home Assistant add-on) holds the stick; only one process may own it. `The Serial API did not respond after soft-reset (ZW0100)` means the stick went silent after the soft-reset, which happens with some sticks under USB passthrough: add `ZWAVE_SOFT_RESET=false` to `/opt/zwave-alarm/.env`, replug the stick if it stays silent, and recreate the container as above. Check `dmesg | grep -i -E "ttyACM|cdc_acm|usb"` on the VM; a disconnect/re-enumeration at the time of the failure confirms it.

Compose runs a health check against `/healthz` (`docker ps` shows `healthy`). It reports that the service answers, not that the Z-Wave driver works; read `driver.status` from `GET /api/v1/panel` for that.

## Z-Wave security keys

The keys never go in git or in `user-data.yaml`. Add them to `/opt/zwave-alarm/.env` on the VM as `ZWAVE_KEY_S2_UNAUTHENTICATED`, `ZWAVE_KEY_S2_AUTHENTICATED`, `ZWAVE_KEY_S2_ACCESS_CONTROL`, `ZWAVE_KEY_S0_LEGACY`, `ZWAVE_LR_KEY_S2_AUTHENTICATED` and `ZWAVE_LR_KEY_S2_ACCESS_CONTROL` (32 hex characters each), either over SSH or through the guest agent (`cv4pve-cli api create /nodes/<node>/qemu/<vmid>/agent/exec --command /bin/sh --input-data "<script>"`). Then `cd /opt/zwave-alarm && docker compose pull && docker compose up -d`.

## Releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); pull requests fail CI if any commit does not. Every push to `main` is versioned from the commits since the last tag: `fix` gives a patch release, `feat` a minor one, and a `BREAKING CHANGE:` footer (or `!` after the type) a major one, whatever the type. Other types (`docs`, `chore`, `ci`, ...) do not release.

Versions are computed by [semantic-release](https://semantic-release.org) (`release.config.mjs`); nobody picks or edits a version by hand. A release bumps `package.json` and `package-lock.json` together, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, creates the GitHub release and pushes the `X.Y.Z`, `X.Y`, `X` and `latest` images. Actions > CI > Run workflow on `main` re-runs the release for commits that have not shipped yet. To run a fixed version, change the image tag in the VM's `docker-compose.yml`.
