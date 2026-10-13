// Cookie firewall (decision 167). In LAN mode every app answers on harbor.local:<port>, and browsers scope cookies
// by host, not port: without this, one app's server would receive the session cookies of every other app the
// administrator uses. The LAN HTTPS relay (lan-https.ts) sits between the browser and each app, so it can:
//   - rename every HttpOnly cookie an app sets to hb_<tag>__<name> (tag = 8 hex chars derived from the instance
//     id, so a rename of the app keeps its cookies) and sign the value (<value>.<sig>, HMAC-SHA256 with a key only
//     the daemon holds), forcing Secure and dropping Domain;
//   - on the way in, give an app back only its own tagged cookies with a valid signature (under the original
//     name), drop every other app's tagged cookies and every forged one, and pass untagged cookies (non-HttpOnly
//     cookies the app's own scripts read) unchanged — except an untagged cookie whose name the app's own signed
//     cookie also carries (a cookie another app's script planted to shadow the real one).
// No app response may set a name shaped like a tagged cookie, and an older untagged copy of a name the app now
// holds signed is cleared. Everything here is pure except the key file. Values never reach logs.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export const COOKIE_KEY_FILE = 'cookie-firewall.key';
export const COOKIE_MAX_BYTES = 4096; // browsers keep name + value up to 4096 bytes
const SIG_BYTES = 16;
const TAGGED = /^hb_([0-9a-f]{8})__(.+)$/;

// Browsers match the __Host- / __Secure- prefixes case-insensitively, so the relay does too, and keeps the app's
// own spelling in front of the tag (the prefix must stay first for the browser to enforce its rules).
function splitPrefix(name: string): [prefix: string, rest: string] {
  const l = name.slice(0, 9).toLowerCase();
  const n = l.startsWith('__host-') ? 7 : l.startsWith('__secure-') ? 9 : 0;
  return [name.slice(0, n), name.slice(n)];
}
function taggedParts(name: string): { prefix: string; tag: string; rest: string } | null {
  const [prefix, body] = splitPrefix(name);
  const m = TAGGED.exec(body);
  return m ? { prefix, tag: m[1]!, rest: m[2]! } : null;
}
const looksTagged = (name: string) => taggedParts(name) !== null;

export type CookieMode = 'isolated' | 'shared';

// Stable per instance (not per app name, which the operator can change).
export function cookieTag(instanceId: string): string {
  return createHash('sha256').update(`harbor-cookie-tag\n${instanceId}`).digest('hex').slice(0, 8);
}

// 32 random bytes, created once (0600). Replacing the file logs every browser out of every app once.
// Written to a temp file, fsynced, then hard-linked into place (link fails if the name exists, like O_EXCL), so
// a crash never leaves a short key behind. An empty file (a write that never reached the disk, from a build
// without this) is replaced: no browser can hold a signature made with a key that was never written.
export function loadCookieKey(stateDir: string): Buffer {
  const file = path.join(stateDir, COOKIE_KEY_FILE);
  try {
    const key = readFileSync(file);
    if (key.length === 32) return key;
    if (key.length !== 0) throw new Error(`${COOKIE_KEY_FILE} must hold 32 bytes (found ${key.length}); delete it to make a new one`);
    unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  mkdirSync(stateDir, { recursive: true });
  const key = randomBytes(32);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return loadCookieKey(stateDir); // another caller won the race
      throw e;
    }
  } finally {
    unlinkSync(tmp);
  }
  const dfd = openSync(stateDir, 'r');
  try {
    fsyncSync(dfd);
  } catch {
    /* directory fsync unsupported on some platforms */
  } finally {
    closeSync(dfd);
  }
  return key;
}

function sign(key: Buffer, tag: string, name: string, value: string): string {
  // length-prefixed so a name/value split cannot be shifted ("a|b"+"c" vs "a"+"b|c")
  return createHmac('sha256', key).update(`${tag}\n${name.length}:${name}\n${value}`).digest().subarray(0, SIG_BYTES).toString('base64url');
}

export function taggedName(tag: string, name: string): string {
  const [prefix, rest] = splitPrefix(name);
  return `${prefix}hb_${tag}__${rest}`;
}

// ---- response side

interface ParsedSetCookie {
  name: string;
  value: string;
  attrs: string[]; // raw "Key=Value" / "Flag" parts, trimmed
}

function parseSetCookie(header: string): ParsedSetCookie | null {
  const parts = header.split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null; // nameless cookie: left alone
  const name = first.slice(0, eq).trim();
  if (!name) return null;
  return { name, value: first.slice(eq + 1).trim(), attrs: parts.map((p) => p.trim()).filter(Boolean) };
}

const attrKey = (a: string) => a.split('=')[0]!.trim().toLowerCase();
const attrVal = (a: string) => (a.includes('=') ? a.slice(a.indexOf('=') + 1).trim() : '');

export function isDeletion(attrs: string[], now = Date.now()): boolean {
  for (const a of attrs) {
    const k = attrKey(a);
    if (k === 'max-age') {
      const n = Number(attrVal(a));
      if (Number.isFinite(n) && n <= 0) return true;
    }
    if (k === 'expires') {
      const t = Date.parse(attrVal(a));
      if (Number.isFinite(t) && t <= now) return true;
    }
  }
  return false;
}

export interface RewriteResult {
  headers: string[];
  oversize: string[]; // cookie names left untagged because the tagged one would not fit (names only, never values)
  isolatedNames: string[]; // original names the app now holds as signed cookies
  plainNames: string[]; // original names set without HttpOnly (passed unchanged)
  refused: string[]; // cookies named like a tagged one (dropped)
}

const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';

// An app's own response never sets a name that looks like Harbor's tag, HttpOnly or not, whatever its size or the
// endpoint's mode: it could only be an attempt to overwrite (and so log out) another app's signed cookie. It cannot
// forge one, so dropping it costs nothing.
export function sharedSetCookies(input: string | string[] | undefined): { headers: string[]; refused: string[] } {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const out = { headers: [] as string[], refused: [] as string[] };
  for (const header of list) {
    const c = parseSetCookie(header);
    if (c && looksTagged(c.name)) out.refused.push(c.name);
    else out.headers.push(header);
  }
  return out;
}

// One app response's Set-Cookie headers -> what the browser gets. `untaggedInRequest`: the untagged cookie names
// the request carried; when the app now sets one of them HttpOnly, that older untagged copy (set before 0.32.0, or
// over plain http) is cleared too, or it would keep reaching every other app.
export function rewriteSetCookies(input: string | string[] | undefined, opts: { tag: string; key: Buffer; now?: number; untaggedInRequest?: ReadonlySet<string> }): RewriteResult {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const out: RewriteResult = { headers: [], oversize: [], isolatedNames: [], plainNames: [], refused: [] };
  for (const header of list) {
    const c = parseSetCookie(header);
    if (!c) {
      out.headers.push(header);
      continue;
    }
    if (looksTagged(c.name)) {
      out.refused.push(c.name);
      continue;
    }
    const httpOnly = c.attrs.some((a) => attrKey(a) === 'httponly');
    const deletion = isDeletion(c.attrs, opts.now);
    if (!httpOnly && !deletion) {
      out.headers.push(header);
      out.plainNames.push(c.name);
      continue;
    }
    // A deletion also goes out unchanged: it clears an untagged cookie of that name (one set before 0.32.0, or a
    // script's own), and the tagged copy below clears the signed one even when the app forgot HttpOnly on it.
    if (deletion) out.headers.push(header);
    const name = taggedName(opts.tag, c.name);
    const value = `${c.value}.${sign(opts.key, opts.tag, c.name, c.value)}`;
    if (Buffer.byteLength(name) + 1 + Buffer.byteLength(value) > COOKIE_MAX_BYTES) {
      if (!deletion) out.headers.push(header);
      out.oversize.push(c.name);
      continue;
    }
    const attrs = c.attrs.filter((a) => attrKey(a) !== 'domain' && attrKey(a) !== 'secure');
    if (!deletion && opts.untaggedInRequest?.has(c.name)) {
      const keep = c.attrs.filter((a) => ['path', 'domain', 'partitioned'].includes(attrKey(a)));
      out.headers.push([`${c.name}=`, ...keep.filter((a) => attrKey(a) !== 'partitioned'), 'Max-Age=0', `Expires=${EPOCH}`, 'Secure', ...keep.filter((a) => attrKey(a) === 'partitioned')].join('; '));
    }
    out.headers.push([`${name}=${value}`, ...attrs, 'Secure'].join('; '));
    if (!deletion && httpOnly) out.isolatedNames.push(c.name);
    if (!httpOnly) out.plainNames.push(c.name);
  }
  return out;
}

// ---- request side

export interface FilterResult {
  cookie: string | undefined; // the Cookie header the app gets (undefined = none)
  dropped: number; // other apps' cookies, forgeries, shadows (counted, never named)
  untagged: string[]; // names of the untagged cookies the request carried (for rewriteSetCookies; never values)
}

// `tag` null = a `cookies: shared` endpoint: it keeps every untagged cookie but never sees an isolated app's.
// `isolatedNames`: names this app has set HttpOnly since the daemon started; an untagged cookie with such a name
// is a plant (the app's real one is always tagged), so it is dropped too.
export function filterCookieHeader(header: string | string[] | undefined, opts: { tag: string | null; key: Buffer; isolatedNames?: ReadonlySet<string> }): FilterResult {
  const raw = header === undefined ? '' : Array.isArray(header) ? header.join('; ') : header;
  if (!raw.trim()) return { cookie: undefined, dropped: 0, untagged: [] };
  const pairs = raw.split(';').map((p) => p.trim()).filter(Boolean);
  type Kept = { name: string; text: string; restored: boolean };
  const kept: Kept[] = [];
  const restored = new Set<string>();
  let dropped = 0;
  for (const p of pairs) {
    const eq = p.indexOf('=');
    const name = eq < 0 ? '' : p.slice(0, eq).trim();
    const m = taggedParts(name);
    if (!m) {
      kept.push({ name, text: p, restored: false });
      continue;
    }
    const { prefix, tag, rest } = m;
    const original = prefix + rest;
    const value = p.slice(eq + 1).trim();
    const dot = value.lastIndexOf('.');
    if (opts.tag === null || tag !== opts.tag || dot < 0) {
      dropped++;
      continue;
    }
    const inner = value.slice(0, dot);
    const want = Buffer.from(sign(opts.key, tag, original, inner));
    const got = Buffer.from(value.slice(dot + 1));
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      dropped++;
      continue;
    }
    restored.add(original);
    kept.push({ name: original, text: `${original}=${inner}`, restored: true });
  }
  const out: string[] = [];
  for (const k of kept) {
    if (!k.restored && k.name && (restored.has(k.name) || opts.isolatedNames?.has(k.name))) {
      dropped++;
      continue;
    }
    out.push(k.text);
  }
  const untagged = [...new Set(kept.filter((k) => !k.restored && k.name).map((k) => k.name))];
  return { cookie: out.length ? out.join('; ') : undefined, dropped, untagged };
}

// ---- cross-app requests

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostnameOf(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith('[')) return a.slice(0, a.indexOf(']') + 1);
  const colon = a.lastIndexOf(':');
  return colon >= 0 && a.indexOf(':') === colon ? a.slice(0, colon) : a;
}

// True when `origin` is another Harbor app on this machine: same host name as the request, an explicit port that
// belongs to a different instance's endpoint (its plain port or its +20000 secure twin). `upgrade` = a WebSocket
// handshake (a GET, but it carries the cookies the same way).
// `Origin: null` (or none) on a request the browser calls same-site (`Sec-Fetch-Site`) is refused too: same site but
// not same origin means another port on this host, and a redirect hop through another app's second endpoint is
// how a page hides its origin while keeping SameSite cookies. Cross-site null origins (sandboxed frames, other
// websites) carry no SameSite=Lax/Strict cookies and are left to the app as before.
export function isCrossAppRequest(req: { method?: string | undefined; origin?: string | undefined; host?: string | undefined; upgrade?: boolean; secFetchSite?: string | undefined }, ownTag: string, portTags: ReadonlyMap<number, string>): boolean {
  if (!req.upgrade && !UNSAFE.has((req.method ?? '').toUpperCase())) return false;
  if (!req.origin || req.origin === 'null') return (req.secFetchSite ?? '').trim().toLowerCase() === 'same-site';
  if (!req.host) return false;
  let u: URL;
  try {
    u = new URL(req.origin);
  } catch {
    return false;
  }
  if (!u.port) return false; // the console (80/443) is not an app
  if (u.hostname.toLowerCase() !== hostnameOf(req.host)) return false;
  const other = portTags.get(Number(u.port));
  return other !== undefined && other !== ownTag;
}
