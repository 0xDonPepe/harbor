import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliLinkAction, ensureCliLink, removeCliLink } from '../../src/bootstrap/cli-link.js';

function layout() {
  const root = mkdtempSync(path.join(tmpdir(), 'harbor-cli-link-'));
  const opt = path.join(root, 'opt', 'harbor');
  const bin = path.join(root, 'usr', 'local', 'bin');
  mkdirSync(path.join(opt, 'bin'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(opt, 'bin', 'harbor'), '#!/bin/sh\n');
  return { opt, link: path.join(bin, 'harbor'), target: path.join(opt, 'bin', 'harbor') };
}

describe('harbor on the PATH (/usr/local/bin/harbor)', () => {
  it('creates the link, then keeps it on the next bootstrap', () => {
    const { opt, link, target } = layout();
    expect(ensureCliLink(link, target, opt)).toMatch(/^linked /);
    expect(readlinkSync(link)).toBe(target);
    expect(ensureCliLink(link, target, opt)).toMatch(/already points/);
  });

  it('replaces its own stale link but never a foreign file or symlink', () => {
    const { opt, link, target } = layout();
    symlinkSync(path.join(opt, 'old', 'harbor'), link);
    expect(ensureCliLink(link, target, opt)).toMatch(/^linked /);
    expect(readlinkSync(link)).toBe(target);

    const other = layout();
    writeFileSync(other.link, 'someone else\n');
    expect(ensureCliLink(other.link, other.target, other.opt)).toMatch(/left .* alone/);
    expect(lstatSync(other.link).isSymbolicLink()).toBe(false);

    const foreign = layout();
    symlinkSync('/usr/bin/true', foreign.link);
    expect(cliLinkAction({ kind: 'symlink', target: '/usr/bin/true' }, foreign.target, foreign.link, foreign.opt)).toBe('foreign');
    expect(ensureCliLink(foreign.link, foreign.target, foreign.opt)).toMatch(/left .* alone/);
    expect(readlinkSync(foreign.link)).toBe('/usr/bin/true');
  });

  it('a relative link that escapes /opt/harbor is not ours', () => {
    const { opt, link, target } = layout();
    expect(cliLinkAction({ kind: 'symlink', target: '../../opt/harbor-evil/bin/harbor' }, target, link, opt)).toBe('foreign');
  });

  it('uninstall removes only its own link', () => {
    const { opt, link, target } = layout();
    ensureCliLink(link, target, opt);
    expect(removeCliLink(link, opt)).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(removeCliLink(link, opt)).toBe(false);
    const other = layout();
    writeFileSync(other.link, 'keep me\n');
    expect(removeCliLink(other.link, other.opt)).toBe(false);
    expect(existsSync(other.link)).toBe(true);
  });
});
