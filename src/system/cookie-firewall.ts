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
// Everything here is pure except the key file. Values never reach logs.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';

export const COOKIE_KEY_FILE = 'cookie-firewall.key';
export const COOKIE_MAX_BYTES = 4096; // browsers keep name + value up to 4096 bytes
const SIG_BYTES = 16;
const TAGGED = /^(__Host-|__Secure-)?hb_([0-9a-f]{8})__(.+)$/;

export type CookieMode = 'isolated' | 'shared';

// Stable per instance (not per app name, which the operator can change).
export function cookieTag(instanceId: string): string {
  return createHash('sha256').update(`harbor-cookie-tag\n${instanceId}`).digest('hex').slice(0, 8);
}

// 32 random bytes, created once (O_EXCL, 0600). Replacing the file logs every browser out of every app once.
export function loadCookieKey(stateDir: string): Buffer {
  const file = path.join(stateDir, COOKIE_KEY_FILE);
  try {
    const key = readFileSync(file);
    if (key.length !== 32) throw new Error(`${COOKIE_KEY_FILE} must hold 32 bytes (found ${key.length}); delete it to make a new one`);
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  mkdirSync(stateDir, { recursive: true });
  const key = randomBytes(32);
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return loadCookieKey(stateDir); // another caller won the race
    throw e;
  }
  try {
    writeSync(fd, key);
  } finally {
    closeSync(fd);
  }
  return key;
}

function sign(key: Buffer, tag: string, name: string, value: string): string {
  // length-prefixed so a name/value split cannot be shifted ("a|b"+"c" vs "a"+"b|c")
  return createHmac('sha256', key).update(`${tag}\n${name.length}:${name}\n${value}`).digest().subarray(0, SIG_BYTES).toString('base64url');
}

export function taggedName(tag: string, name: string): string {
  const m = /^(__Host-|__Secure-)(.*)$/.exec(name);
  return m ? `${m[1]}hb_${tag}__${m[2]}` : `hb_${tag}__${name}`;
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
  refused: string[]; // non-HttpOnly cookies named like a tagged one (dropped)
}

// One app response's Set-Cookie headers -> what the browser gets.
export function rewriteSetCookies(input: string | string[] | undefined, opts: { tag: string; key: Buffer; now?: number }): RewriteResult {
  const list = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const out: RewriteResult = { headers: [], oversize: [], isolatedNames: [], plainNames: [], refused: [] };
  for (const header of list) {
    const c = parseSetCookie(header);
    if (!c) {
      out.headers.push(header);
      continue;
    }
    const httpOnly = c.attrs.some((a) => attrKey(a) === 'httponly');
    const deletion = isDeletion(c.attrs, opts.now);
    // An app's own response never sets a name that looks like Harbor's tag: it could only be an attempt to
    // overwrite (and so log out) another app's signed cookie. It cannot forge one, so dropping it costs nothing.
    if (!httpOnly && TAGGED.test(c.name)) {
      out.refused.push(c.name);
      continue;
    }
    if (!httpOnly && !deletion) {
      out.headers.push(header);
      out.plainNames.push(c.name);
      continue;
    }
    // A deletion also goes out unchanged: it clears an untagged cookie of that name (one set before 0.32.0, or a
    // script's own), and the tagged copy below clears the signed one even when the app forgot HttpOnly on it.
    if (deletion && !TAGGED.test(c.name)) out.headers.push(header);
    const name = taggedName(opts.tag, c.name);
    const value = `${c.value}.${sign(opts.key, opts.tag, c.name, c.value)}`;
    if (Buffer.byteLength(name) + 1 + Buffer.byteLength(value) > COOKIE_MAX_BYTES) {
      if (!deletion) out.headers.push(header);
      out.oversize.push(c.name);
      continue;
    }
    const attrs = c.attrs.filter((a) => attrKey(a) !== 'domain' && attrKey(a) !== 'secure');
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
}

// `tag` null = a `cookies: shared` endpoint: it keeps every untagged cookie but never sees an isolated app's.
// `isolatedNames`: names this app has set HttpOnly since the daemon started; an untagged cookie with such a name
// is a plant (the app's real one is always tagged), so it is dropped too.
export function filterCookieHeader(header: string | string[] | undefined, opts: { tag: string | null; key: Buffer; isolatedNames?: ReadonlySet<string> }): FilterResult {
  const raw = header === undefined ? '' : Array.isArray(header) ? header.join('; ') : header;
  if (!raw.trim()) return { cookie: undefined, dropped: 0 };
  const pairs = raw.split(';').map((p) => p.trim()).filter(Boolean);
  type Kept = { name: string; text: string; restored: boolean };
  const kept: Kept[] = [];
  const restored = new Set<string>();
  let dropped = 0;
  for (const p of pairs) {
    const eq = p.indexOf('=');
    const name = eq < 0 ? '' : p.slice(0, eq).trim();
    const m = TAGGED.exec(name);
    if (!m) {
      kept.push({ name, text: p, restored: false });
      continue;
    }
    const [, prefix = '', tag, rest] = m;
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
  return { cookie: out.length ? out.join('; ') : undefined, dropped };
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
export function isCrossAppRequest(req: { method?: string | undefined; origin?: string | undefined; host?: string | undefined; upgrade?: boolean }, ownTag: string, portTags: ReadonlyMap<number, string>): boolean {
  if (!req.upgrade && !UNSAFE.has((req.method ?? '').toUpperCase())) return false;
  if (!req.origin || req.origin === 'null' || !req.host) return false;
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
