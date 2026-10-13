import { closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, ftruncateSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';

// Decision 169: root helpers write status files into folders the harbor user owns (state dir, request
// folders, crypto/). The harbor user could put a symlink (or a hard link) where root is about to write, and
// root would then truncate, write or chown whatever it points at.
//
// O_NOFOLLOW only protects the LAST part of a path: a folder on the way that is swapped for a link after it
// was checked is still followed. So folders are opened one at a time (O_DIRECTORY | O_NOFOLLOW) and the next
// name is looked up through the open folder itself (/proc/self/fd/<fd>/<name> on Linux, which resolves to
// the folder the fd holds, whatever its path says now). Files are then opened O_NOFOLLOW below that folder,
// and everything else (truncate, chmod, chown) goes through the file's own fd.
//
// The root helpers only run on Linux. Elsewhere (the macOS dev loop) there is no /proc/self/fd and names
// fall back to plain paths: the same checks, but a folder swapped mid-way could still win the race there.

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0; // a FIFO planted in the way fails (ENXIO) instead of hanging root
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const FD_DIR = process.platform === 'linux' && existsSync('/proc/self/fd/') ? '/proc/self/fd' : null;

/** True where folders are reached through their fd (Linux): a folder swapped mid-way cannot redirect a write. */
export const FD_RELATIVE_PATHS = FD_DIR !== null;

export interface Owner {
  uid: number;
  gid: number;
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error(`invalid file name ${JSON.stringify(name)}`);
}

/**
 * An open folder. Names below it are reached through its fd, so the path that led here can change (a parent
 * renamed, a link put in its place) without redirecting anything done through this handle.
 */
export class DirHandle {
  private constructor(
    readonly fd: number,
    /** the path it was opened as: for messages (and the non-Linux fallback) only */
    readonly path: string,
  ) {}

  /** Open a folder root trusts (it comes from root's own config): a link here is followed. */
  static openTrusted(dir: string): DirHandle {
    return new DirHandle(openSync(dir, constants.O_RDONLY | DIRECTORY), dir);
  }

  /** Open a folder without following a link at its last part (the parts before it are trusted). */
  static openNoFollow(dir: string): DirHandle {
    return DirHandle.openAt(dir, dir);
  }

  private static openAt(target: string, shown: string): DirHandle {
    let fd: number;
    try {
      fd = openSync(target, constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK);
    } catch (e) {
      if (code(e) === 'ELOOP' || code(e) === 'ENOTDIR' || code(e) === 'EMLINK') throw new Error(`${shown} is not a plain directory; refusing to write below it`, { cause: e });
      throw e;
    }
    if (!fstatSync(fd).isDirectory()) {
      closeSync(fd);
      throw new Error(`${shown} is not a plain directory; refusing to write below it`);
    }
    return new DirHandle(fd, shown);
  }

  /** The path that reaches `name` inside this folder (through the fd on Linux). */
  child(name: string): string {
    checkName(name);
    return FD_DIR ? `${FD_DIR}/${this.fd}/${name}` : path.join(this.path, name);
  }

  /** The path that reaches this folder itself (through the fd on Linux). */
  self(): string {
    return FD_DIR ? `${FD_DIR}/${this.fd}` : this.path;
  }

  /** Open (and with `createMode`, first create) a sub-folder; a link or anything but a folder is refused. */
  openDir(name: string, createMode?: number): DirHandle {
    const target = this.child(name);
    if (createMode !== undefined) {
      try {
        mkdirSync(target, { mode: createMode });
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
      }
    }
    return DirHandle.openAt(target, path.join(this.path, name));
  }

  /** Write a whole file in this folder without following a link at its name (see writeFileNoFollow). */
  writeFile(name: string, data: string | Buffer, opts: { mode: number; owner?: Owner }): void {
    writeFileNoFollow(this.child(name), data, opts, path.join(this.path, name));
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Write a whole file without following a symlink at `file`: open O_WRONLY|O_CREAT|O_NOFOLLOW, refuse anything
 * but a plain file with one link, then truncate, chmod, chown (all through the fd) and write. Only the last
 * part of `file` is protected: below a harbor-owned folder use DirHandle.writeFile or writeStatusFile.
 */
export function writeFileNoFollow(file: string, data: string | Buffer, opts: { mode: number; owner?: Owner }, shown = file): void {
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | NONBLOCK, opts.mode);
  } catch (e) {
    if (code(e) === 'ELOOP' || code(e) === 'EMLINK') throw new Error(`${shown} is a symbolic link; refusing to write through it`, { cause: e });
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${shown} is not a plain file; refusing to write it`);
    if (st.nlink > 1) throw new Error(`${shown} has other hard links; refusing to write it`);
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

/** Read a small plain file without following a link at `file`; null when it does not exist. */
export function readFileNoFollow(file: string, maxBytes = 64 * 1024): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    if (code(e) === 'ELOOP' || code(e) === 'EMLINK') throw new Error(`${file} is a symbolic link; refusing to read through it`, { cause: e });
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a plain file`);
    if (st.size > maxBytes) throw new Error(`${file} is larger than expected`);
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function partsBelow(root: string, dir: string): string[] {
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${dir} is not inside ${root}`);
  return rel.split(path.sep).filter(Boolean);
}

/**
 * Open the folder `dir` below the trusted `root`, one part at a time without following links (creating
 * missing parts with `mode`; with `mode` null every part must exist). The caller closes the handle.
 */
export function openDirUnder(root: string, dir: string, mode: number | null = 0o700): DirHandle {
  const parts = partsBelow(root, dir);
  let cur = DirHandle.openTrusted(root);
  try {
    for (const part of parts) {
      const next = cur.openDir(part, mode ?? undefined);
      cur.close();
      cur = next;
    }
    return cur;
  } catch (e) {
    cur.close();
    throw e;
  }
}

/**
 * mkdir -p for the part of a path below `root`, refusing any component that exists as something other than a
 * real directory (a symlink to elsewhere, above all). `root` itself is trusted (it comes from root's config).
 */
export function ensurePlainDirUnder(root: string, dir: string, mode = 0o700): void {
  openDirUnder(root, dir, mode).close();
}

/**
 * A status file below a harbor-owned root: each folder is opened without following links and the file is
 * written through the last one, so no link anywhere below `root` is followed.
 */
export function writeStatusFile(root: string, file: string, data: string, opts: { mode: number; owner?: Owner; dirMode?: number }): void {
  const dir = openDirUnder(root, path.dirname(file), opts.dirMode ?? 0o700);
  try {
    dir.writeFile(path.basename(file), data, opts);
  } finally {
    dir.close();
  }
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
 * How chownTree changes an owner: `logical` is the path inside the tree (for messages and tests), `target`
 * is what is actually changed: an open folder's fd, or a path reached through the parent folder's fd whose
 * last part is never followed.
 */
export type ChownStep = (logical: string, target: number | string, uid: number, gid: number) => void;
const realChown: ChownStep = (_logical, target, uid, gid) => (typeof target === 'number' ? fchownSync(target, uid, gid) : lchownSync(target, uid, gid));

/**
 * Ownership fix for a tree root created itself (Harbor's state directory). Folders are opened O_NOFOLLOW and
 * chowned through their fd; their entries are reached through that fd (see DirHandle), so a folder renamed
 * or swapped for a link mid-walk cannot lead the walk out of the tree. Anything that is not a folder gets
 * lchown (the owner of a link itself, never its target). A link is never descended into.
 */
export function chownTree(dir: string, uid: number, gid: number, chown: ChownStep = realChown): void {
  const top = lstatSync(dir);
  if (top.isSymbolicLink() || !top.isDirectory()) {
    chown(dir, dir, uid, gid);
    return;
  }
  const walk = (d: DirHandle, logical: string, depth: number): void => {
    if (depth > 64) throw new Error(`${logical} is nested too deep; refusing to go on`);
    chown(logical, d.fd, uid, gid);
    for (const entry of readdirSync(d.self()).sort()) {
      const target = d.child(entry);
      const at = path.join(logical, entry);
      const st = lstatSync(target, { throwIfNoEntry: false });
      if (!st) continue; // removed meanwhile
      if (!st.isDirectory()) {
        chown(at, target, uid, gid);
        continue;
      }
      let sub: DirHandle;
      try {
        sub = d.openDir(entry);
      } catch {
        // swapped for a link (or something else) between lstat and open: change the link itself, never its target
        chown(at, target, uid, gid);
        continue;
      }
      try {
        walk(sub, at, depth + 1);
      } finally {
        sub.close();
      }
    }
  };
  const root = DirHandle.openNoFollow(dir);
  try {
    walk(root, dir, 0);
  } finally {
    root.close();
  }
}
