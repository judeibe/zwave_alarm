# Proxmox VM deployment

1. Map the Z-Wave USB stick in Proxmox (Datacenter > Resource Mappings > USB), e.g. `zwave`.
2. Clone an Ubuntu cloud-init template, give it a static IP (`qm set <vmid> --ipconfig0 ip=<ip>/24,gw=<gw>`) and add the stick: `qm set <vmid> --usb0 mapping=zwave`.
3. Enable `snippets` on a directory storage, fill `<YOUR_SSH_PUBLIC_KEY>` in `user-data.yaml`, copy it to `/var/lib/vz/snippets/zwave-alarm-user.yaml` on the node, then `qm set <vmid> --cicustom user=local:snippets/zwave-alarm-user.yaml`.
4. Start the VM. It installs Docker and the generic kernel (rebooting once if `cdc_acm` is missing), then runs `ghcr.io/judeibe/zwave_alarm:main` from `/opt/zwave-alarm`.

Known gaps: the app has no S2/S0 key settings, and the zwave-js-server can fail to start if the driver is not ready yet.
