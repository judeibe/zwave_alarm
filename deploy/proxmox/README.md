# Proxmox VM deployment

1. In Proxmox, map the Z-Wave USB stick (Datacenter > Resource Mappings > USB) and note its name.
2. Create an Ubuntu cloud image VM on node `pve`, attach a cloud-init drive, and set `cicustom=user=<storage>:snippets/zwave-alarm-user.yaml`.
3. Add the USB mapping: `qm set <vmid> --usb0 mapping=<mapping-name>`.
4. Fill the placeholders in `user-data.yaml`; the controller's `/dev/serial/by-id/...` name is visible in the VM via `ls /dev/serial/by-id`.
