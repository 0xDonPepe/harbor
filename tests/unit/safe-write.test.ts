import { linkSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chownTree, ensurePlainDirUnder, fchownFileNoFollow, writeFileNoFollow, writeStatusFile } from '../../src/bootstrap/safe-write.js';
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
