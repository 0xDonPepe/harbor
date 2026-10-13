import { linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chownTree, DirHandle, ensurePlainDirUnder, FD_RELATIVE_PATHS, fchownFileNoFollow, openDirUnder, writeFileNoFollow, writeStatusFile } from '../../src/bootstrap/safe-write.js';
import { readSetupCode, writeSetupCode } from '../../src/auth/setup.js';
import { tempDir } from './helpers.js';

// Decision 169: root helpers never write or chown through a link the harbor user planted.
const me = { uid: process.getuid!(), gid: process.getgid!() };

describe('writeFileNoFollow', () => {
  it('writes a fresh file with the mode, and replaces an existing one', () => {
    const dir = tempDir('harbor-safe-');
    const f = path.join(dir, 'status.json');
    writeFileNoFollow(f, '{"state":"working"}', { mode: 0o640, owner: me });
    expect(readFileSync(f, 'utf8')).toBe('{"state":"working"}');
    expect(statSync(f).mode & 0o777).toBe(0o640);
    writeFileNoFollow(f, '{}', { mode: 0o600 });
    expect(readFileSync(f, 'utf8')).toBe('{}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlink where the file should be and leaves its target alone', () => {
    const dir = tempDir('harbor-safe-');
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'precious', { mode: 0o600 });
    const f = path.join(dir, 'status.json');
    symlinkSync(victim, f);
    expect(() => writeFileNoFollow(f, 'x', { mode: 0o644 })).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(statSync(victim).mode & 0o777).toBe(0o600);
    // a dangling link is refused too (O_CREAT would otherwise create its target)
    const dangling = path.join(dir, 'progress.json');
    symlinkSync(path.join(dir, 'created-elsewhere'), dangling);
    expect(() => writeFileNoFollow(dangling, 'x', { mode: 0o644 })).toThrow();
    expect(() => lstatSync(path.join(dir, 'created-elsewhere'))).toThrow();
  });

  it('refuses a hard link to another file', () => {
    const dir = tempDir('harbor-safe-');
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'precious');
    const f = path.join(dir, 'status.json');
    linkSync(victim, f);
    expect(() => writeFileNoFollow(f, 'x', { mode: 0o644 })).toThrow(/hard links/);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });
});

describe('status files below a harbor-owned root', () => {
  it('creates missing folders and refuses a folder swapped for a symlink', () => {
    const root = tempDir('harbor-state-');
    writeStatusFile(root, path.join(root, 'devices', 'sdb', 'mount-status.json'), '{}', { mode: 0o600 });
    expect(readFileSync(path.join(root, 'devices', 'sdb', 'mount-status.json'), 'utf8')).toBe('{}');
    const elsewhere = tempDir('harbor-elsewhere-');
    symlinkSync(elsewhere, path.join(root, 'devices', 'sdc'));
    expect(() => writeStatusFile(root, path.join(root, 'devices', 'sdc', 'mount-status.json'), '{}', { mode: 0o600 })).toThrow(/not a plain directory/);
    expect(() => lstatSync(path.join(elsewhere, 'mount-status.json'))).toThrow();
    expect(() => ensurePlainDirUnder(root, '/etc')).toThrow(/not inside/);
  });
});

describe('fchownFileNoFollow', () => {
  it('re-owns and chmods a plain file through its fd, refuses a link', () => {
    const dir = tempDir('harbor-marker-');
    const f = path.join(dir, '.harbor-bind.json');
    writeFileSync(f, '{}', { mode: 0o600 });
    fchownFileNoFollow(f, me, 0o644);
    expect(statSync(f).mode & 0o777).toBe(0o644);
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'x', { mode: 0o600 });
    const link = path.join(dir, 'link.json');
    symlinkSync(victim, link);
    expect(() => fchownFileNoFollow(link, me, 0o644)).toThrow();
    expect(statSync(victim).mode & 0o777).toBe(0o600);
  });
});

describe('chownTree', () => {
  it('never descends into or chowns through a symlink', () => {
    const root = tempDir('harbor-state-');
    mkdirSync(path.join(root, 'instances', 'a'), { recursive: true });
    writeFileSync(path.join(root, 'harbor.db'), 'db');
    writeFileSync(path.join(root, 'instances', 'a', 'secret'), 's');
    const outside = tempDir('harbor-outside-');
    writeFileSync(path.join(outside, 'shadow'), 'root only');
    symlinkSync(outside, path.join(root, 'escape'));
    symlinkSync(path.join(outside, 'shadow'), path.join(root, 'instances', 'shadow-link'));
    const calls: string[] = [];
    chownTree(root, me.uid, me.gid, (p) => calls.push(path.relative(root, p) || '.'));
    expect(calls.sort()).toEqual(['.', 'escape', 'harbor.db', 'instances', 'instances/a', 'instances/a/secret', 'instances/shadow-link'].sort());
    expect(calls.some((c) => c.includes('shadow') && !c.endsWith('shadow-link'))).toBe(false);
    // the real lchown runs too (to our own uid: allowed without root)
    chownTree(root, me.uid, me.gid);
  });
});

// Where a path really leads: an fd (Linux: through /proc/self/fd) or a path whose parents are resolved.
function whereItLeads(target: number | string): string {
  if (typeof target === 'number') return readlinkSync(`/proc/self/fd/${target}`);
  return path.join(realpathSync.native(path.dirname(target)), path.basename(target));
}

// O_NOFOLLOW only covers the last part of a path; these prove a folder swapped for a link mid-way is not
// followed either. They need /proc/self/fd (Linux, where the root helpers run); macOS falls back to paths.
describe.runIf(FD_RELATIVE_PATHS)('a folder swapped for a link mid-way (Linux)', () => {
  it('chownTree keeps walking the folder it opened, not the link put in its place', () => {
    const base = tempDir('harbor-ct-');
    const root = path.join(base, 'state');
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'sub', 'a'), 'a');
    writeFileSync(path.join(root, 'sub', 'shadow'), 'mine');
    mkdirSync(path.join(base, 'etc'));
    writeFileSync(path.join(base, 'etc', 'shadow'), 'root only');
    const touched: string[] = [];
    chownTree(root, me.uid, me.gid, (logical, target) => {
      touched.push(whereItLeads(target));
      if (logical === path.join(root, 'sub', 'a')) {
        renameSync(path.join(root, 'sub'), path.join(root, 'sub-old'));
        symlinkSync(path.join(base, 'etc'), path.join(root, 'sub'));
      }
    });
    const realRoot = realpathSync.native(root);
    expect(touched.length).toBe(4);
    expect(touched.every((t) => t === realRoot || t.startsWith(realRoot + path.sep))).toBe(true);
    expect(touched).toContain(path.join(realRoot, 'sub-old', 'shadow'));
  });

  it('a pinned folder keeps receiving the writes after its path is swapped for a link', () => {
    const base = tempDir('harbor-pin-');
    const root = path.join(base, 'state');
    mkdirSync(path.join(root, 'backup', 'requests', 'r1'), { recursive: true });
    mkdirSync(path.join(base, 'etc'));
    const dir = openDirUnder(root, path.join(root, 'backup', 'requests', 'r1'), null);
    try {
      dir.writeFile('status.json', '{"state":"working"}', { mode: 0o640, owner: me });
      // the harbor user swaps a folder above the request for a link while the step runs
      renameSync(path.join(root, 'backup'), path.join(root, 'backup-old'));
      symlinkSync(path.join(base, 'etc'), path.join(root, 'backup'));
      mkdirSync(path.join(base, 'etc', 'requests', 'r1'), { recursive: true });
      dir.writeFile('progress.json', '{"percent":50}', { mode: 0o640, owner: me });
    } finally {
      dir.close();
    }
    expect(readFileSync(path.join(root, 'backup-old', 'requests', 'r1', 'progress.json'), 'utf8')).toBe('{"percent":50}');
    expect(() => lstatSync(path.join(base, 'etc', 'requests', 'r1', 'progress.json'))).toThrow();
  });
});

describe('DirHandle', () => {
  it('opens existing folders only when asked to, and refuses a link or a file on the way', () => {
    const root = tempDir('harbor-dh-');
    expect(() => openDirUnder(root, path.join(root, 'backup', 'requests'), null)).toThrow();
    expect(() => lstatSync(path.join(root, 'backup'))).toThrow();
    mkdirSync(path.join(root, 'backup'));
    writeFileSync(path.join(root, 'backup', 'requests'), 'not a folder');
    expect(() => openDirUnder(root, path.join(root, 'backup', 'requests'))).toThrow(/not a plain directory/);
    const outside = tempDir('harbor-dh-out-');
    symlinkSync(outside, path.join(root, 'link'));
    expect(() => DirHandle.openNoFollow(path.join(root, 'link'))).toThrow(/not a plain directory/);
    const d = openDirUnder(root, path.join(root, 'backup'), null);
    try {
      expect(() => d.child('../x')).toThrow(/invalid file name/);
    } finally {
      d.close();
    }
  });
});

describe('setup code in the harbor-owned state dir', () => {
  it('a link planted at setup-code is neither read nor written through', () => {
    const dir = tempDir('harbor-setup-');
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'root:x:0:0\n', { mode: 0o600 });
    symlinkSync(victim, path.join(dir, 'setup-code'));
    expect(readSetupCode(dir)).toBeNull();
    expect(() => writeSetupCode(dir)).toThrow(/symbolic link/);
    expect(readFileSync(victim, 'utf8')).toBe('root:x:0:0\n');
    // a code that looks right behind a link is not taken either
    writeFileSync(victim, '123456\n');
    expect(readSetupCode(dir)).toBeNull();
  });
});
