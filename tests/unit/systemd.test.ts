import { describe, expect, it } from 'vitest';
import { cockpitSocketDropIn, deviceMountUnit, egressBootUnit, egressStepUnit, harborUnit, polkitPowerRule, vpnUnit } from '../../src/bootstrap/systemd.js';
import { egressUnit, parseEgressAction } from '../../src/egress/provider.js';

describe('systemd unit text', () => {
  it('runs as the harbor user with docker group, control-group kill, and does not stop when Docker stops', () => {
    const unit = harborUnit();
    expect(unit).toContain('User=harbor');
    expect(unit).toContain('SupplementaryGroups=docker');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Wants=network-online.target docker.service');
    expect(unit).not.toMatch(/^Requires=.*docker/m); // live A10 found Harbor being stopped along with Docker
    expect(unit).toContain('ReadWritePaths=/var/lib/harbor /srv/harbor /mnt /media'); // the data folder must be writable for the folder picker; /mnt + /media for drive-guard markers
    expect(unit).toContain('# managed-by: harbor-bootstrap');
  });
  it('restricts the Cockpit socket to loopback', () => {
    expect(cockpitSocketDropIn(9090)).toContain('ListenStream=\nListenStream=127.0.0.1:9090');
  });
  it('mounts removable media through a root oneshot the harbor user may start', () => {
    expect(deviceMountUnit()).toContain('harbor device-dispatch %i');
    expect(deviceMountUnit()).toContain('<name>:<mount|unmount|format>');
    expect(deviceMountUnit()).toContain('TimeoutStartSec=600');
    // FUSE mounts (ntfs-3g) fork a userspace daemon: control-group killing
    // would unmount the drive the moment the oneshot exits (live finding).
    expect(deviceMountUnit()).toContain('KillMode=none');
    expect(polkitPowerRule()).toContain('harbor-device-mount@');
  });
  // decision 184: VPN and offline apps
  it('loads the firewall before Docker with nft alone, and Docker requires it; never used = skipped', () => {
    const unit = egressBootUnit();
    expect(unit).toContain('Before=docker.service');
    expect(unit).toContain('RequiredBy=docker.service');
    expect(unit).toContain('ConditionPathExists=/etc/harbor/egress/rules.nft');
    // the kill switch needs only the OS's nft; Harbor's routing step after it may fail without a leak
    expect(unit).toContain('ExecStart=/usr/sbin/nft -f /etc/harbor/egress/rules.nft');
    expect(unit).toContain('ExecStart=-/opt/harbor/bin/harbor egress-boot');
    expect(unit.indexOf('ExecStart=/usr/sbin/nft')).toBeLessThan(unit.indexOf('egress-boot'));
    expect(unit).toContain('RemainAfterExit=yes');
  });
  it('brings the tunnel up after the network, retried forever', () => {
    const unit = vpnUnit();
    expect(unit).toContain('After=network-online.target harbor-egress.service');
    expect(unit).toContain('ConditionPathExists=/etc/harbor/egress/tunnel.conf');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StartLimitIntervalSec=0');
    expect(unit).toContain('harbor egress-tunnel-up');
  });
  it('runs one egress step per action, and the harbor user may start only that template', () => {
    expect(egressStepUnit()).toContain('ExecStart=/opt/harbor/bin/harbor egress-step %i');
    expect(egressUnit('tunnel-set')).toBe('harbor-egress@tunnel-set.service');
    expect(() => parseEgressAction('apply;reboot')).toThrow();
    expect(polkitPowerRule()).toContain('indexOf("harbor-egress@") === 0');
  });
});
