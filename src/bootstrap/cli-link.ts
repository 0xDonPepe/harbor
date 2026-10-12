import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PRODUCT } from '../naming.js';

// `harbor` on the PATH: a symlink /usr/local/bin/harbor -> /opt/harbor/bin/harbor, so the CLI works without
// its full path. Harbor only ever creates, replaces or removes ITS OWN link (a symlink pointing into
// /opt/harbor); a file or a foreign symlink someone else put there is left alone.
export const CLI_LINK = '/usr/local/bin/harbor';
export const CLI_TARGET = `${PRODUCT.paths.opt}/bin/harbor`;

export type CliLinkState = { kind: 'none' } | { kind: 'symlink'; target: string } | { kind: 'other' };

export function readCliLink(link = CLI_LINK): CliLinkState {
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) return { kind: 'other' };
    return { kind: 'symlink', target: readlinkSync(link) };
  } catch {
    return { kind: 'none' };
  }
}

function isOurs(state: CliLinkState, linkDir: string, optDir: string): boolean {
  if (state.kind !== 'symlink') return false;
  const rel = path.relative(optDir, path.resolve(linkDir, state.target));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function cliLinkAction(state: CliLinkState, target = CLI_TARGET, link = CLI_LINK, optDir: string = PRODUCT.paths.opt): 'create' | 'keep' | 'replace' | 'foreign' {
  if (state.kind === 'none') return 'create';
  if (!isOurs(state, path.dirname(link), optDir)) return 'foreign';
  return path.resolve(path.dirname(link), (state as { target: string }).target) === path.resolve(target) ? 'keep' : 'replace';
}

// Bootstrap: returns what happened, for the log.
export function ensureCliLink(link = CLI_LINK, target = CLI_TARGET, optDir: string = PRODUCT.paths.opt): string {
  const action = cliLinkAction(readCliLink(link), target, link, optDir);
  if (action === 'keep') return `${link} already points at ${target}`;
  if (action === 'foreign') return `left ${link} alone (not Harbor's); use ${target}`;
  if (action === 'replace') unlinkSync(link); // unlink, not rm: rm follows a dangling link and skips it
  symlinkSync(target, link);
  return `linked ${link} -> ${target}`;
}

// Uninstall: remove the link only when it is ours.
export function removeCliLink(link = CLI_LINK, optDir: string = PRODUCT.paths.opt): boolean {
  const state = readCliLink(link);
  if (!isOurs(state, path.dirname(link), optDir)) return false;
  unlinkSync(link);
  return true;
}
