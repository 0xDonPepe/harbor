import { describe, expect, it } from 'vitest';
import { dockerAptRepo } from '../../src/bootstrap/docker-install.js';
import { tailscaleAptRepo, tailscalePreview } from '../../src/bootstrap/tools.js';

// pkgs.tailscale.com publishes one signed apt suite per family + codename, the same key Docker's repo
// uses, so the Tailscale repo follows the host's dockerAptRepo instead of a hardcoded noble.
describe('tailscaleAptRepo', () => {
  it('keeps noble on Ubuntu 24.04', () => {
    const r = tailscaleAptRepo(dockerAptRepo({ ID: 'ubuntu', VERSION_ID: '24.04', ID_LIKE: 'debian', VERSION_CODENAME: 'noble', UBUNTU_CODENAME: 'noble' }));
    expect(r.keyUrl).toBe('https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg');
    expect(r.listUrl).toBe('https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list');
  });

  it('uses resolute on Ubuntu 26.04', () => {
    const r = tailscaleAptRepo(dockerAptRepo({ ID: 'ubuntu', VERSION_ID: '26.04', ID_LIKE: 'debian', VERSION_CODENAME: 'resolute', UBUNTU_CODENAME: 'resolute' }));
    expect(r.keyUrl).toBe('https://pkgs.tailscale.com/stable/ubuntu/resolute.noarmor.gpg');
    expect(r.listUrl).toBe('https://pkgs.tailscale.com/stable/ubuntu/resolute.tailscale-keyring.list');
  });

  it('uses the debian suite on Debian 13 and on a Debian derivative', () => {
    expect(tailscaleAptRepo(dockerAptRepo({ ID: 'debian', VERSION_ID: '13', VERSION_CODENAME: 'trixie' })).listUrl)
      .toBe('https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list');
    expect(tailscaleAptRepo(dockerAptRepo({ ID: 'raspbian', VERSION_ID: '12', VERSION_CODENAME: 'bookworm', ID_LIKE: 'debian' })).keyUrl)
      .toBe('https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg');
  });

  it('maps an Ubuntu derivative to its base codename (Linux Mint 22 -> noble)', () => {
    const r = tailscaleAptRepo(dockerAptRepo({ ID: 'linuxmint', VERSION_ID: '22', VERSION_CODENAME: 'xia', UBUNTU_CODENAME: 'noble', ID_LIKE: 'ubuntu debian' }));
    expect(r.listUrl).toBe('https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list');
  });
});

describe('tailscalePreview', () => {
  it('names the suite it will add', () => {
    const repo = dockerAptRepo({ ID: 'ubuntu', VERSION_ID: '26.04', VERSION_CODENAME: 'resolute', UBUNTU_CODENAME: 'resolute' });
    expect(tailscalePreview({ installed: false, backendState: null }, false, repo).join('\n')).toContain('ubuntu resolute');
  });
});
