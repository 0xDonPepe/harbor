import { closeSync, constants, fchmodSync, fchownSync, fstatSync, ftruncateSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';

// Decision 169: root helpers write status files into folders the harbor user owns (state dir, request
// folders, crypto/). The harbor user could put a symlink (or a hard link) where root is about to write, and
// root would then truncate, write or chown whatever it points at. Everything here works on the file
// descriptor of the file actually opened, and never follows a link in the last path component.

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0; // a FIFO planted in the way fails (ENXIO) instead of hanging root

export interface Owner {
  uid: number;
  gid: number;
}

/**
 * Write a whole file without following a symlink at `file`: open O_WRONLY|O_CREAT|O_NOFOLLOW, refuse anything
 * but a plain file with one link, then truncate, chmod, chown (all through the fd) and write.
 */
export function writeFileNoFollow(file: string, data: string | Buffer, opts: { mode: number; owner?: Owner }): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | NONBLOCK, opts.mode);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a plain file; refusing to write it`);
    if (st.nlink > 1) throw new Error(`${file} has other hard links; refusing to write it`);
    ftruncateSync(fd, 0);
    fchmodSync(fd, opts.mode);
    if (opts.owner) fchownSync(fd, opts.owner.uid, opts.owner.gid);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  } finally {
    closeSync(fd);
  }
}

/**
 * mkdir -p for the part of a path below `root`, refusing any component that exists as something other than a
 * real directory (a symlink to elsewhere, above all). `root` itself is trusted (it comes from root's config).
 */
export function ensurePlainDirUnder(root: string, dir: string, mode = 0o700): void {
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${dir} is not inside ${root}`);
  let cur = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) {
      mkdirSync(cur, { mode });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a plain directory; refusing to write below it`);
  }
}

/** A status file below a harbor-owned root: the folders are checked, the file is written without following links. */
export function writeStatusFile(root: string, file: string, data: string, opts: { mode: number; owner?: Owner; dirMode?: number }): void {
  ensurePlainDirUnder(root, path.dirname(file), opts.dirMode ?? 0o700);
  writeFileNoFollow(file, data, opts);
}

/** chown an existing plain file through its fd, never through a symlink (no lstat-then-chown race). */
export function fchownFileNoFollow(file: string, owner: Owner, mode?: number): void {
  const fd = openSync(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a plain file`);
    fchownSync(fd, owner.uid, owner.gid);
    if (mode !== undefined) fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/**
 * Ownership fix for a tree root created itself (Harbor's state directory). lstat + lchown only: a symlink is
 * never descended into and never chowned through (lchown sets the owner of the link itself, never its
 * target). A folder that turns into something else while it is being listed (swapped for a link) stops the
 * walk there.
 */
export function chownTree(dir: string, uid: number, gid: number, lchown: (p: string, uid: number, gid: number) => void = lchownSync): void {
  const top = lstatSync(dir);
  lchown(dir, uid, gid);
  if (top.isSymbolicLink() || !top.isDirectory()) return;
  const entries = readdirSync(dir);
  const again = lstatSync(dir);
  if (again.isSymbolicLink() || again.ino !== top.ino || again.dev !== top.dev) throw new Error(`${dir} changed while Harbor was fixing its ownership; refusing to go on`);
  for (const entry of entries) chownTree(path.join(dir, entry), uid, gid, lchown);
}
