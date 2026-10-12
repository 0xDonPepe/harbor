#!/usr/bin/env node
// Editorial helper: draft Harbor packages from an Umbrel app store checkout (docs/design/UMBREL_COMPAT.md §5).
//   node scripts/umbrel-import.mjs --umbrel <umbrel-apps dir> [--catalog <dir>] [--only a,b] [--dry-run]
//                                  [--report <file.json>] [--upstream-cache <file.json>]
// Every rule is fixed: an app is converted only when each part of its Umbrel package has an exact Harbor
// equivalent (or is something Umbrel needs and Harbor does not: app_proxy, Tor, restart policies, user ids).
// Anything else refuses the whole app with the reasons, so a draft is either 1:1 or not written at all.
// It never copies Umbrel's long descriptions, release notes, icons or screenshots (umbrel-apps has no license):
// only the app's name, tagline and links, plus the upstream GitHub description (gh api, cached).
// Existing packages in the catalog are never touched. New ones get release.json `pending`; run catalog-pin,
// catalog:hash and catalog:verify after, and qualify on a droplet before calling any of them passed.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { catalogArg } from './catalog-dir.mjs';
import { resolve as resolveImage } from './registry.mjs';

const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTERPOLATION_RE = /\$(?=[{A-Za-z_$])/;
// Umbrel app id -> Harbor id where the official Harbor package already exists under another name
const ALIASES = { 'anything-llm': 'anythingllm' };
// keys Harbor owns or that only matter on umbrelOS; dropping them keeps the app's behavior
const DROP_KEYS = new Set(['restart', 'container_name', 'logging', 'labels', 'expose', 'stop_signal', 'networks', 'pull_policy', 'platform', 'init', 'stdin_open', 'tty', 'user', 'stop_grace_period', 'mem_limit', 'mem_reservation', 'cpus', 'oom_score_adj', 'deploy', 'hostname']);
const INFRA_RE = /(^|\/)(postgres|postgis|pgvecto-rs|mariadb|mysql|redis|valkey|keydb|dragonfly|mongo|memcached|elasticsearch|opensearch|meilisearch|typesense|clickhouse|rabbitmq|minio|qdrant|chroma|couchdb|influxdb|immich-postgres)([:@-]|$)/;
const CATEGORY = { files: 'files', media: 'media', ai: 'ai', automation: 'automation', developer: 'developer', finance: 'finance', bitcoin: 'finance', crypto: 'finance', networking: 'network', social: 'other' };
const TOR_IMAGE_RE = /(^|\/)tor[:@]/;

function parseArgs(argv) {
  const out = { umbrel: null, only: null, dryRun: false, report: null, cache: null };
  const { rest, dir } = catalogArg(argv);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--umbrel') out.umbrel = rest[++i];
    else if (a === '--only') out.only = new Set(rest[++i].split(','));
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--report') out.report = rest[++i];
    else if (a === '--upstream-cache') out.cache = rest[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.umbrel) throw new Error('usage: umbrel-import.mjs --umbrel <umbrel-apps dir> [--catalog <dir>] [--only a,b] [--dry-run] [--report f] [--upstream-cache f]');
  const base = process.env.INIT_CWD ?? process.cwd();
  out.umbrel = path.resolve(base, out.umbrel);
  if (out.report) out.report = path.resolve(base, out.report);
  if (out.cache) out.cache = path.resolve(base, out.cache);
  out.catalog = dir;
  return out;
}

class Refuse extends Error {}
const refuse = (msg) => { throw new Refuse(msg); };

// `$VAR` and `${VAR}` names in a string (`$$` is Compose's literal dollar and is not a variable)
const varsIn = (s) => [...String(s).replace(/\$\$/g, '').matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]);
const varRe = (name) => new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, 'g');

// exports.sh: VAR -> { kind, value?, length? }
function readExports(dir) {
  const p = path.join(dir, 'exports.sh');
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*export\s+([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, name, raw] = m;
    const val = raw.trim();
    if (val.includes('derive_entropy')) {
      const head = /head -c ?(\d+)/.exec(val);
      out[name] = { kind: 'secret', length: head ? Number(head[1]) : 64 };
    } else if (/^["']?[0-9.]+["']?$/.test(val)) out[name] = { kind: 'literal', value: val.replace(/["']/g, '') };
    else out[name] = { kind: 'other' };
  }
  return out;
}

function hasRealFiles(p) {
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) { if (hasRealFiles(path.join(p, e.name))) return true; }
    else if (!['.gitkeep', '.keep', '.gitignore'].includes(e.name)) return true;
  }
  return false;
}

// Umbrel hooks run on the host as root. Only ones that just prepare bind folders (chown/mkdir/rm, version
// markers) are droppable: Harbor uses named volumes, so there is nothing to prepare.
function hookVerdict(dir) {
  const hd = path.join(dir, 'hooks');
  if (!existsSync(hd)) return null;
  const body = readdirSync(hd).map((f) => readFileSync(path.join(hd, f), 'utf8')).join('\n').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  if (/scripts\/app"? compose|docker (exec|run|compose)/.test(body)) refuse('hook starts or execs containers (needs init jobs)');
  if (/\b(openssl|envsubst|jq|yq|python3?)\b|sed -i|>\s*"?\$\{?APP_DATA_DIR|cat\s*>|tee /.test(body)) refuse('hook writes config files (needs init jobs or package files)');
  return `dropped host hooks (${readdirSync(hd).sort().join(', ')}): they only prepare Umbrel bind folders`;
}

// "1m30s" -> "90s"; Harbor's pattern takes one unit
function duration(v, where, notes, [min, max]) {
  const s = String(v);
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m; let consumed = '';
  while ((m = re.exec(s))) { ms += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]; consumed += m[0]; }
  if (!consumed || consumed !== s) refuse(`${where}: unreadable duration ${s}`);
  const clamped = Math.min(Math.max(ms, min), max);
  if (clamped !== ms) notes.push(`${where} ${s} clamped to Harbor's range`);
  return clamped % 1000 === 0 ? `${clamped / 1000}s` : `${Math.round(clamped)}ms`;
}

// command string -> argument array with POSIX quoting, like Compose (shlex): single quotes are literal, a backslash
// escapes the next character outside quotes and \ " $ ` inside double quotes. Refuses shell syntax outside quotes
// (that needs a shell the image may not have).
function splitCommand(s, where) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '\\' && '\\"$`\n'.includes(s[i + 1] ?? '')) { if (s[i + 1] !== '\n') cur += s[i + 1]; i++; continue; }
      if (ch === '"') q = null; else cur += ch;
      continue;
    }
    if (ch === '\\') { if (i + 1 < s.length && s[i + 1] !== '\n') cur += s[i + 1]; i++; any = true; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/[|&;<>`]/.test(ch)) refuse(`${where}: command uses shell syntax`);
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (q) refuse(`${where}: unbalanced quote in command`);
  if (cur || any) out.push(cur);
  return out;
}

function imageRef(img, where) {
  const s = String(img).replace(/^docker\.io\//, '').replace(/^library\//, '');
  const m = /^([^@\s]+?)(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/.exec(s);
  if (!m) refuse(`${where}: unreadable image ${img}`);
  const [, repo, tag, digest] = m;
  if (repo !== repo.toLowerCase()) refuse(`${where}: image repository has upper case`);
  if (!tag) refuse(`${where}: image ${img} has no tag (catalog-pin needs one)`);
  return { repo, tag, digest: digest ?? null };
}

function convert(umbrelDir, appId, ctx) {
  const dir = path.join(umbrelDir, appId);
  const notes = [];
  const man = YAML.parse(readFileSync(path.join(dir, 'umbrel-app.yml'), 'utf8')) ?? {};
  const comp = YAML.parse(readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), { merge: true }) ?? {};
  const exp = readExports(dir);
  if (!ID_RE.test(appId)) refuse(`app id ${appId} is not a valid Harbor id`);
  for (const dep of man.dependencies ?? []) refuse(`depends on the Umbrel app ${dep}`);
  if (man.torOnly) refuse('Tor-only app');
  for (const k of Object.keys(comp)) if (!['version', 'services'].includes(k) && !k.startsWith('x-')) refuse(`top-level compose key ${k}`);
  const hook = hookVerdict(dir);
  if (hook) notes.push(hook);
  for (const p of man.permissions ?? []) {
    if (p === 'GPU') notes.push('GPU access dropped: runs on the CPU');
    else if (p !== 'STORAGE_DOWNLOADS') refuse(`permission ${p}`);
  }

  const src = { ...(comp.services ?? {}) };
  const proxy = src.app_proxy; delete src.app_proxy;
  if (!proxy) refuse('no app_proxy (no proxied web UI)');
  for (const [name, svc] of Object.entries(src)) {
    if (TOR_IMAGE_RE.test(String(svc?.image ?? ''))) { delete src[name]; notes.push(`dropped Tor sidecar ${name}: Harbor offers Tailscale and HTTPS for remote access`); }
  }
  const names = Object.keys(src);
  if (!names.length) refuse('no services');
  if (names.length > 16) refuse('more than 16 services');
  for (const n of names) if (!ID_RE.test(n)) refuse(`service name ${n} is not a valid Harbor id`);

  // static IPs (exports literal assigned as ipv4_address) -> service names
  const ipToService = {};
  for (const [n, s] of Object.entries(src)) {
    const ip = s?.networks?.default?.ipv4_address;
    if (ip) {
      const v = varsIn(ip)[0];
      const lit = v ? exp[v]?.value : String(ip);
      if (lit) ipToService[lit] = n;
    }
  }
  const containerDns = new RegExp(`\\b${appId.replace(/[-]/g, '[-_]')}_([a-z0-9-]+?)_1\\b`, 'g');
  const rewriteHosts = (s) => s.replace(containerDns, (all, svc) => (names.includes(svc) ? svc : all));
  const resolveLiteralVars = (s) => s.replace(/\$\{?([A-Z][A-Z0-9_]*)\}?/g, (all, v) => {
    const e = exp[v];
    if (e?.kind === 'literal') return ipToService[e.value] ?? e.value;
    if (v === 'APP_ID') return appId;
    return all;
  });

  // endpoint
  const pe = Object.fromEntries(Object.entries(proxy.environment ?? {}).map(([k, v]) => [k, String(v)]));
  let host = resolveLiteralVars(pe.APP_HOST ?? '');
  host = rewriteHosts(host);
  if (!names.includes(host)) refuse(`app_proxy APP_HOST ${pe.APP_HOST} is not one of the services`);
  const port = Number(resolveLiteralVars(pe.APP_PORT ?? ''));
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse(`app_proxy APP_PORT ${pe.APP_PORT} is not a port`);

  const umbrelDisabled = new Set();
  const secrets = new Map(); // var -> { id, bindings: [] }
  const configuration = [];
  const volumes = new Map(); // source key -> { name, external?, readOnly }
  const services = {};
  let usesPassword = 0;

  const secretFor = (v) => {
    if (!secrets.has(v)) {
      let id;
      if (v === 'APP_SEED') id = 'app-seed';
      else if (v === 'APP_PASSWORD') id = 'app-password';
      else {
        const e = exp[v];
        if (e.length !== 64) refuse(`secret ${v} is ${e.length} characters; Harbor generates 64 hex characters`);
        id = v.replace(new RegExp(`^APP_${appId.toUpperCase().replace(/-/g, '_')}_`), '').replace(/^APP_/, '').toLowerCase().replace(/_/g, '-');
      }
      if (!ID_RE.test(id)) id = `s-${id}`.slice(0, 63);
      secrets.set(v, { id, bindings: [] });
    }
    return secrets.get(v);
  };

  const DOMAIN = '(?:\\$\\{(?:DEVICE_DOMAIN_NAME|DEVICE_HOSTNAME)\\}|\\$(?:DEVICE_DOMAIN_NAME|DEVICE_HOSTNAME))';
  const PORT = '(?::(?:\\$\\{APP_PROXY_PORT\\}|\\$APP_PROXY_PORT|\\d+))?';
  const configFormat = (val) => {
    if (new RegExp(`^https?://${DOMAIN}${PORT}$`).test(val)) return 'origin';
    if (new RegExp(`^https?://${DOMAIN}${PORT}/$`).test(val)) return 'url';
    if (new RegExp(`^${DOMAIN}$`).test(val)) return 'host';
    if (new RegExp(`^${DOMAIN}${PORT}$`).test(val)) return 'authority';
    return null;
  };

  for (const [name, svc0] of Object.entries(src)) {
    const svc = svc0 ?? {};
    const out = {};
    const where = `service ${name}`;
    for (const k of Object.keys(svc)) {
      if (['image', 'command', 'environment', 'depends_on', 'healthcheck', 'volumes'].includes(k)) continue;
      if (k === 'security_opt' && svc[k].every((o) => String(o).includes('no-new-privileges'))) { notes.push(`${where}: security_opt no-new-privileges dropped`); continue; }
      if (k === 'cap_drop') { notes.push(`${where}: cap_drop dropped`); continue; }
      if (k === 'ports') {
        const all = svc.ports.every((p) => Number(String(p).split(':').pop().split('/')[0]) === port && name === host);
        if (!all) refuse(`${where}: publishes raw ports ${JSON.stringify(svc.ports)}`);
        notes.push(`${where}: ports dropped (Harbor publishes the web endpoint itself)`);
        continue;
      }
      if (DROP_KEYS.has(k)) {
        if (k === 'deploy' && JSON.stringify(svc.deploy).includes('gpu')) notes.push(`${where}: GPU reservation dropped`);
        else if (k === 'user') notes.push(`${where}: user ${svc.user} dropped (named volumes keep the image's ownership)`);
        else if (k === 'stop_grace_period') notes.push(`${where}: stop_grace_period ${svc[k]} dropped (Docker's default applies)`);
        else if (k === 'hostname') notes.push(`${where}: hostname dropped`);
        continue;
      }
      refuse(`${where}: compose key ${k} has no Harbor equivalent`);
    }
    if (svc.build) refuse(`${where}: builds from source`);
    const img = imageRef(svc.image, where);
    out.image = img.digest ? `${img.repo}@${img.digest}` : `${img.repo}:${img.tag}`;
    out.__tag = img.tag;

    if (svc.command !== undefined && svc.command !== null) {
      let cmd = Array.isArray(svc.command) ? svc.command.map(String) : splitCommand(String(svc.command), where);
      cmd = cmd.map((c) => rewriteHosts(resolveLiteralVars(c)));
      for (const c of cmd) if (varsIn(c).length) refuse(`${where}: command uses Umbrel variables`);
      cmd = cmd.map((c) => c.replace(/\$\$/g, '$')); // Compose's escaped dollar; Harbor escapes on render
      if (!cmd.length || !cmd[0]) refuse(`${where}: empty command`);
      out.command = cmd;
    }

    // environment
    let envEntries = [];
    if (Array.isArray(svc.environment)) {
      for (const e of svc.environment) {
        const s = String(e); const i = s.indexOf('=');
        if (i < 0) refuse(`${where}: environment ${s} passes a host variable through`);
        envEntries.push([s.slice(0, i), s.slice(i + 1)]);
      }
    } else envEntries = Object.entries(svc.environment ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]);
    const env = {};
    for (let [k, v] of envEntries) {
      if (!ENV_KEY_RE.test(k)) refuse(`${where}: environment key ${k}`);
      v = rewriteHosts(resolveLiteralVars(v));
      v = v.replace(/\$\{TZ(:-[^}]*)?\}|\$TZ\b/g, 'UTC');
      const cf = configFormat(v);
      if (cf) { configuration.push({ service: name, environment: k, endpoint: 'web', format: cf }); continue; }
      const vs = [...new Set(varsIn(v))];
      if (vs.length) {
        if (vs.length > 1) refuse(`${where}: ${k} combines several Umbrel variables`);
        const [vn] = vs;
        if (!(vn === 'APP_SEED' || vn === 'APP_PASSWORD' || exp[vn]?.kind === 'secret')) refuse(`${where}: ${k} uses Umbrel variable ${vn}`);
        const parts = v.split(varRe(vn));
        if (parts.length !== 2) refuse(`${where}: ${k} uses ${vn} more than once`);
        const sec = secretFor(vn);
        if (vn === 'APP_PASSWORD') usesPassword++;
        const binding = { service: name, environment: k };
        if (parts[0] || parts[1]) {
          const template = `${parts[0]}{{value}}${parts[1]}`;
          if (template.includes('$') || template.length < 9 || template.length > 500) refuse(`${where}: ${k} embeds a secret in a form Harbor templates cannot hold`);
          binding.template = template;
        }
        sec.bindings.push(binding);
        continue;
      }
      if (INTERPOLATION_RE.test(v) || v.includes('$')) refuse(`${where}: environment ${k} contains a literal $`);
      env[k] = v;
    }
    if (Object.keys(env).length > 64) refuse(`${where}: more than 64 environment variables`);
    if (Object.keys(env).length) out.environment = env;

    // volumes
    const mounts = [];
    for (const vol of svc.volumes ?? []) {
      let source; let target; let ro;
      if (typeof vol === 'object') {
        if (vol.type === 'volume') refuse(`${where}: Umbrel named volume ${vol.source}`);
        source = String(vol.source); target = String(vol.target); ro = !!vol.read_only;
      } else {
        const parts = String(vol).split(':');
        [source, target] = parts; ro = parts.slice(2).join(',').split(',').includes('ro');
      }
      if (!target) refuse(`${where}: volume ${vol} has no target`);
      target = target.replace(/\/+$/, '');
      if (['/etc/localtime', '/etc/timezone'].includes(source)) { notes.push(`${where}: ${source} mount dropped (TZ is UTC)`); continue; }
      let key; let ext = null; let base;
      const dataRel = /^\$\{?APP_DATA_DIR\}?\/?(.*)$/.exec(source);
      const storageRel = /^\$\{?UMBREL_ROOT\}?\/(data\/storage|home)(\/.*)?$/.exec(source);
      if (dataRel) {
        const rel = dataRel[1].replace(/\/+$/, '');
        const local = path.join(dir, rel);
        if (existsSync(local) && statSync(local).isFile()) refuse(`${where}: mounts the package file ${rel} (needs package config files)`);
        if (existsSync(local) && statSync(local).isDirectory() && hasRealFiles(local)) refuse(`${where}: mounts the package folder ${rel} with files in it (needs package config files)`);
        key = `data:${rel}`;
        base = rel.replace(/^data(\/|$)/, '') || 'data';
      } else if (storageRel) {
        key = `storage:${storageRel[1]}${storageRel[2] ?? ''}`;
        base = (storageRel[2] ?? '').replace(/^\//, '') || (storageRel[1] === 'home' ? 'files' : 'storage');
        ext = { hint: `Optional: a folder on this machine to use for ${target}, such as a folder on a large drive`, required: false, ...(ro ? { readOnly: true } : {}) };
      } else refuse(`${where}: mounts ${source} from the host`);
      if (!volumes.has(key)) {
        let vname = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'data';
        if (!/^[a-z]/.test(vname)) vname = `v-${vname}`;
        vname = vname.slice(0, 63).replace(/-+$/, '');
        let n = vname; let i = 2;
        const taken = new Set([...volumes.values()].map((x) => x.name));
        while (taken.has(n)) n = `${vname.slice(0, 60)}-${i++}`;
        volumes.set(key, { name: n, external: ext, firstUse: `${name} ${target}` });
      }
      // nested binds (data and data/sub) behave differently as separate volumes
      for (const other of volumes.keys()) {
        if (other !== key && (key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) refuse(`${where}: nested data folders ${other} and ${key}`);
      }
      mounts.push({ type: 'volume', source: volumes.get(key).name, target, ...(ro ? { read_only: true } : {}) });
    }
    if (mounts.length) out.volumes = mounts;

    // depends_on
    if (svc.depends_on) {
      const deps = {};
      const list = Array.isArray(svc.depends_on) ? svc.depends_on.map((d) => [d, { condition: 'service_started' }]) : Object.entries(svc.depends_on);
      for (const [d, spec] of list) {
        if (!names.includes(d)) { if (!(d in (comp.services ?? {}))) refuse(`${where}: depends on unknown ${d}`); continue; }
        const cond = spec?.condition ?? 'service_started';
        if (!['service_started', 'service_healthy'].includes(cond)) refuse(`${where}: depends_on condition ${cond}`);
        deps[d] = { condition: cond };
      }
      if (Object.keys(deps).length) out.depends_on = deps;
    }

    // healthcheck (Umbrel never acts on Docker health except depends_on service_healthy: see the rule after this loop)
    const hc = svc.healthcheck;
    if (hc?.disable) umbrelDisabled.add(name);
    if (hc && !hc.disable) {
      let test = hc.test;
      if (typeof test === 'string' || test?.[0] === 'CMD-SHELL') refuse(`${where}: shell healthcheck (needs a shell in the image)`);
      if (!Array.isArray(test) || test[0] !== 'CMD' || test.length < 2) refuse(`${where}: unreadable healthcheck`);
      test = test.map((t) => rewriteHosts(resolveLiteralVars(String(t))));
      if (test.some((t) => INTERPOLATION_RE.test(t))) refuse(`${where}: healthcheck uses variables`);
      const h = { test };
      if (hc.interval) h.interval = duration(hc.interval, `${where} healthcheck interval`, notes, [1000, 300000]);
      if (hc.timeout) h.timeout = duration(hc.timeout, `${where} healthcheck timeout`, notes, [1000, 120000]);
      if (hc.retries) h.retries = Math.min(Math.max(Number(hc.retries), 1), 100);
      if (hc.start_period) h.start_period = duration(hc.start_period, `${where} healthcheck start_period`, notes, [0, 600000]);
      out.healthcheck = h;
    }
    services[name] = out;
  }
  for (const [n, s] of Object.entries(services)) {
    for (const d of Object.keys(s.depends_on ?? {})) {
      if (s.depends_on[d].condition === 'service_healthy' && !services[d].healthcheck) refuse(`service ${n} waits for ${d} to be healthy, which has no healthcheck`);
    }
  }
  // Umbrel starts apps without waiting on Docker health, so its checks are informational (some cannot pass: a curl the
  // image lacks, `localhost` resolving to IPv6). Harbor waits for healthy (`compose up --wait`). 1:1 therefore keeps a
  // check only where another service waits for it, and switches off every other one, including one the image carries
  // (decided in main once the image config is read). Harbor's own HTTP health check is the readiness signal.
  const waited = new Set(Object.values(services).flatMap((s) => Object.entries(s.depends_on ?? {}).filter(([, v]) => v.condition === 'service_healthy').map(([d]) => d)));
  const imageChecks = [];
  for (const [n, s] of Object.entries(services)) {
    if (waited.has(n)) { if (umbrelDisabled.has(n)) refuse(`service ${n}: Umbrel disables its healthcheck but another service waits for it`); continue; }
    if (s.healthcheck || umbrelDisabled.has(n)) { s.healthcheck = { disable: true }; notes.push(`service ${n}: healthcheck switched off (nothing waits for it; Umbrel never acts on it)`); }
    else imageChecks.push(n);
  }

  // credentials
  let defaultCredentials = null; let provisioned = null;
  const pw = man.defaultPassword ? String(man.defaultPassword) : '';
  const user = man.defaultUsername ? String(man.defaultUsername) : '';
  const pwSecret = secrets.get('APP_PASSWORD');
  if (man.deterministicPassword || pw.includes('APP_PASSWORD')) {
    if (!pwSecret) refuse('Umbrel shows a generated password the compose file never uses');
    if (usesPassword === 1 && !pwSecret.bindings[0].template && user) {
      provisioned = { service: pwSecret.bindings[0].service, passwordEnv: pwSecret.bindings[0].environment, username: user };
      secrets.delete('APP_PASSWORD');
    } else pwSecret.showOnce = `${man.name} password${user ? ` (user ${user})` : ''}`.slice(0, 80);
  } else if (pw) {
    defaultCredentials = { username: user || '(none)', password: pw, note: 'Change it after the first login.' };
  }

  const appName = String(man.name ?? appId).slice(0, 64);
  const tagline = man.tagline ? String(man.tagline).slice(0, 80) : null;
  const upstream = ctx.upstream(man.repo);
  // package text refuses control characters (manifest plainText)
  const description = [...(upstream || tagline || appName)].filter((ch) => ch === '\t' || ch === '\n' || ch === '\r' || ch.charCodeAt(0) > 0x1f).join('').trim().slice(0, 280);

  const svcRoles = Object.fromEntries(Object.entries(services).map(([n, s]) => [n, n !== host && INFRA_RE.test(s.image) ? 'infrastructure' : 'application']));
  const manifest = {
    apiVersion: 'harbor/v1alpha1',
    kind: 'Application',
    metadata: { id: ALIASES[appId] ?? appId, name: appName, description },
    ...(defaultCredentials ? { defaultCredentials } : {}),
    ...(provisioned ? { provisionedCredentials: provisioned } : {}),
    release: { revision: '1', ...(man.version ? { version: String(man.version).replace(/^v(?=\d)/, '').slice(0, 64) } : {}) },
    deployment: { compose: 'compose.yaml', multiInstance: true, services: svcRoles },
    endpoints: { web: { service: host, containerPort: port, scheme: 'http', exposure: 'direct', browserContext: 'ordinary' } },
    // Umbrel packages carry no health path: "/" with any answer a web app gives before login; qualification replaces it
    health: { endpoint: 'web', path: '/', expectedStatus: [200, 301, 302, 303, 307, 308, 401], timeoutSeconds: 5, deadlineSeconds: 300 },
    ui: { primaryEndpoint: 'web' },
    ...(volumes.size ? {
      storage: [...volumes.values()].map((v) => ({
        id: v.name, composeVolume: v.name, purpose: `Data at ${v.firstUse.split(' ').slice(1).join(' ')} (${v.firstUse.split(' ')[0]})`.slice(0, 120), retention: 'retain',
        ...(v.external ? { external: v.external } : {}),
      })),
    } : {}),
    ...(secrets.size ? {
      secrets: [...secrets.values()].map((s) => ({ id: s.id, bytes: 32, encoding: 'hex', retention: 'retain', ...(s.showOnce ? { showOnce: s.showOnce } : {}), bindings: s.bindings })),
    } : {}),
    ...(configuration.length ? { configuration } : {}),
    presentation: {
      ...(tagline ? { tagline } : {}),
      ...(CATEGORY[man.category] ? { category: CATEGORY[man.category] } : {}),
      ...(man.developer ? { developer: String(man.developer).slice(0, 80) } : {}),
      ...(/^https:\/\/[^\s<>"]{1,200}$/.test(String(man.website ?? '')) ? { website: String(man.website) } : {}),
    },
  };
  if (!Object.keys(manifest.presentation).length) delete manifest.presentation;

  const composeOut = { services: {} };
  const tags = {};
  for (const [n, s] of Object.entries(services)) { tags[n] = s.__tag; delete s.__tag; composeOut.services[n] = s; }
  if (volumes.size) composeOut.volumes = Object.fromEntries([...volumes.values()].map((v) => [v.name, {}]));

  return { manifest, compose: composeOut, tags, notes, man, upstream, imageChecks };
}

function emitCompose(compose, tags) {
  let text = YAML.stringify(compose, { aliasDuplicateObjects: false, lineWidth: 0 });
  // volume entries in flow style like the hand-written packages; pinned images carry their tag for catalog-pin
  text = text.replace(/^( {6})- type: volume\n {8}source: (\S+)\n {8}target: (.+)\n(?: {8}read_only: true\n)?/gm, (all, ind, s, t) => `${ind}- {type: volume, source: ${s}, target: ${JSON.stringify(YAML.parse(t))}${all.includes('read_only') ? ', read_only: true' : ''}}\n`);
  const lines = text.split('\n'); let svc = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(lines[i]); if (m) svc = m[1];
    if (/^ {4}image: \S+@sha256:/.test(lines[i]) && svc && tags[svc]) lines[i] += ` # tag: ${tags[svc]}`;
  }
  return lines.join('\n');
}

function readme({ manifest, man }) {
  const lines = [`# ${manifest.metadata.name}`, '', manifest.metadata.description, ''];
  if (man.website) lines.push(`- Website: ${man.website}`);
  if (man.repo) lines.push(`- Source code: ${man.repo}`);
  if (man.support) lines.push(`- Help: ${man.support}`);
  lines.push('');
  if (manifest.provisionedCredentials) lines.push(`Harbor creates the \`${manifest.provisionedCredentials.username}\` login at install and shows its password once.`, '');
  else if (manifest.defaultCredentials) lines.push(`First login: \`${manifest.defaultCredentials.username}\` / \`${manifest.defaultCredentials.password}\`. Change the password after you sign in.`, '');
  else if (manifest.secrets?.some((s) => s.showOnce)) lines.push('Harbor generates the password at install and shows it once.', '');
  return lines.join('\n');
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const cache = opts.cache && existsSync(opts.cache) ? JSON.parse(readFileSync(opts.cache, 'utf8')) : {};
  const upstream = (repo) => {
    const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/.exec(String(repo ?? ''));
    if (!m) return null;
    const key = `${m[1]}/${m[2]}`;
    if (!(key in cache)) {
      try { cache[key] = execFileSync('gh', ['api', `repos/${key}`, '--jq', '.description // ""'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { cache[key] = null; }
    }
    return cache[key];
  };
  const indexPath = path.join(opts.catalog, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const apps = readdirSync(opts.umbrel).filter((a) => existsSync(path.join(opts.umbrel, a, 'umbrel-app.yml'))).filter((a) => !opts.only || opts.only.has(a)).sort();
  const report = { umbrelCommit: null, converted: [], refused: [], skipped: [] };
  try { report.umbrelCommit = execFileSync('git', ['-C', opts.umbrel, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
  const today = new Date().toISOString().slice(0, 10);
  const imageConfigs = {};
  for (const appId of apps) {
    const harborId = ALIASES[appId] ?? appId;
    if (index.packages[harborId] || existsSync(path.join(opts.catalog, harborId))) { report.skipped.push({ id: appId, reason: 'already in the catalog' }); continue; }
    let r;
    try { r = convert(opts.umbrel, appId, { upstream }); } catch (e) {
      if (e instanceof Refuse) { report.refused.push({ id: appId, reason: e.message }); continue; }
      report.refused.push({ id: appId, reason: `converter error: ${e.message}` }); continue;
    }
    // switch off a healthcheck the image carries, on services nothing waits for (see convert)
    try {
      for (const n of r.imageChecks) {
        const ref = r.compose.services[n].image;
        const cfg = imageConfigs[ref] ??= (await resolveImage(ref)).config;
        const test = cfg.Healthcheck?.Test;
        if (test?.length && test[0] !== 'NONE') { r.compose.services[n].healthcheck = { disable: true }; r.notes.push(`service ${n}: the image's own healthcheck switched off (nothing waits for it; Umbrel never acts on it)`); }
      }
    } catch (e) { report.refused.push({ id: appId, reason: `could not read an image config: ${e.message.slice(0, 160)}` }); continue; }
    // decision 162: healthcheck disable is new in 0.28.4
    if (Object.values(r.compose.services).some((s) => s.healthcheck?.disable)) r.manifest.release.minHarbor = '0.28.4';
    report.converted.push({ id: harborId, notes: r.notes });
    if (opts.dryRun) continue;
    const out = path.join(opts.catalog, harborId);
    mkdirSync(out, { recursive: true });
    // expectedStatus inline like the hand-written packages (qualify-catalog reads that form)
    const manifestText = YAML.stringify(r.manifest, { aliasDuplicateObjects: false, lineWidth: 0 }).replace(/^( +)expectedStatus:\n((?:\1 {2}- \d+\n)+)/m, (all, ind, items) => `${ind}expectedStatus: [${items.match(/\d+/g).join(', ')}]\n`);
    writeFileSync(path.join(out, 'manifest.yaml'), manifestText);
    writeFileSync(path.join(out, 'compose.yaml'), emitCompose(r.compose, r.tags));
    writeFileSync(path.join(out, 'README.md'), readme(r));
    const release = {
      schemaVersion: 1, package: { id: harborId, revision: '1' }, files: {}, images: {},
      qualification: { status: 'pending', date: today, notes: [`Drafted by scripts/umbrel-import.mjs from the Umbrel package ${appId}${report.umbrelCommit ? ` (umbrel-apps ${report.umbrelCommit.slice(0, 7)})` : ''}; not yet run on a real Harbor host.`, ...r.notes] },
    };
    writeFileSync(path.join(out, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    index.packages[harborId] = { revision: '1', dir: harborId };
  }
  if (!opts.dryRun) {
    index.packages = Object.fromEntries(Object.entries(index.packages).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  }
  if (opts.cache) writeFileSync(opts.cache, JSON.stringify(cache, null, 1) + '\n');
  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 1) + '\n');
  console.log(`converted ${report.converted.length}, refused ${report.refused.length}, skipped ${report.skipped.length} (already in the catalog)`);
}

await main();
