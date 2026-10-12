import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CatalogStatusDto } from '../contracts/api.js';
import type { Fetcher } from '../appearance/fetcher.js';
import type { Logger } from '../lifecycle/context.js';
import { BUNDLE_FILES, MAX_BUNDLE_META_BYTES, openBundle, parseBundleMeta, verifyBundleMeta, type CatalogBundleMeta } from '../packages/catalog-bundle.js';
import { readCatalogIndex } from '../packages/catalog.js';
import { rfc3339, type Clock } from '../util.js';

// The official app catalog, kept current without a Harbor release (decision 158). Two places can hold it:
//   seed        config.catalogDir (/opt/harbor/catalog): the bundle the Harbor release shipped with. A release
//               build copies the bundle's catalog.json + catalog.json.sig next to it; without them (dev, tests)
//               the seed is serial 0.
//   downloaded  <stateDir>/catalog/<serial>/ (same layout), the active one named by <stateDir>/catalog/current.json.
// Whichever has the higher serial is the catalog; a missing or broken pointer or folder means the seed.
// A check downloads catalog.json + its signature first, and only fetches catalog.zip when the signed serial
// is newer than the active one: an equal or older bundle (a replay, a rollback) never replaces it.
// Never touches Docker: installed apps see a new revision as an ordinary update.

export const CATALOG_FIRST_CHECK_MS = 60_000;
export const CATALOG_CHECK_INTERVAL_MS = 6 * 3600_000;
const META_TIMEOUT_MS = 30_000;
const ZIP_TIMEOUT_MS = 5 * 60_000;
const MAX_SIG_BYTES = 1024;

export interface CatalogUpdateDeps {
  seedDir: string;
  stateDir: string;
  // release-asset base URL (…/releases/latest/download); null = updates off, never fetches
  url: string | null;
  publicKeys: readonly string[];
  fetcher: Fetcher;
  clock: Clock;
  log: Logger;
}

interface ActiveCatalog {
  dir: string;
  serial: number;
  origin: CatalogStatusDto['origin'];
}

function readMetaIn(dir: string): CatalogBundleMeta | null {
  const file = path.join(dir, BUNDLE_FILES.meta);
  try {
    if (!existsSync(file)) return null;
    return parseBundleMeta(readFileSync(file));
  } catch {
    return null;
  }
}

export class CatalogUpdateService {
  private readonly seedSerial: number;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private inflight: Promise<CatalogStatusDto> | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly deps: CatalogUpdateDeps) {
    // The seed only changes with a Harbor upgrade, which restarts the daemon: read it once.
    const seed = readMetaIn(deps.seedDir);
    if (!seed && existsSync(path.join(deps.seedDir, BUNDLE_FILES.meta))) deps.log.warn(`the bundled app catalog's ${BUNDLE_FILES.meta} is unreadable; treating it as the oldest catalog`);
    this.seedSerial = seed?.serial ?? 0;
  }

  private get root(): string {
    return path.join(this.deps.stateDir, 'catalog');
  }
  private get pointerFile(): string {
    return path.join(this.root, 'current.json');
  }

  // The downloaded serial current.json names, when it parses and its folder still has an index.
  private pointer(): number | null {
    try {
      const v = JSON.parse(readFileSync(this.pointerFile, 'utf8')) as { serial?: unknown };
      const serial = v?.serial;
      if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial < 1) return null;
      return existsSync(path.join(this.root, String(serial), 'index.json')) ? serial : null;
    } catch {
      return null;
    }
  }

  private active(): ActiveCatalog {
    const p = this.pointer();
    if (p !== null && p > this.seedSerial) return { dir: path.join(this.root, String(p)), serial: p, origin: 'downloaded' };
    return { dir: this.deps.seedDir, serial: this.seedSerial, origin: 'bundled' };
  }

  // Called on every catalog read (PackageStore): two small reads, no parsing beyond current.json.
  activeDir(): string {
    return this.active().dir;
  }

  status(): CatalogStatusDto {
    const a = this.active();
    const meta = readMetaIn(a.dir);
    let packages: number;
    try {
      packages = Object.keys(readCatalogIndex(a.dir).packages).length;
    } catch {
      packages = 0;
    }
    return { source: this.deps.url, serial: a.serial, commit: meta?.commit ?? null, createdAt: meta?.createdAt ?? null, origin: a.origin, packages, checkedAt: this.checkedAt, error: this.error };
  }

  // Single-flight: a click during the timer's check joins it. Never throws; the outcome is in status().
  refresh(): Promise<CatalogStatusDto> {
    if (!this.deps.url) return Promise.resolve(this.status());
    if (!this.inflight) {
      this.inflight = this.check(this.deps.url).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async get(url: string, name: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
    let r;
    try {
      r = await this.deps.fetcher.fetch(`${url}/${name}`, { maxBytes, timeoutMs, headers: { accept: 'application/octet-stream' } });
    } catch (e) {
      throw new Error(`could not download ${name} from the catalog server (${e instanceof Error ? e.message : String(e)})`, { cause: e });
    }
    if (r.status !== 200) throw new Error(`the catalog server answered HTTP ${r.status} for ${name}`);
    if (r.body.length > maxBytes) throw new Error(`${name} is larger than ${maxBytes} bytes`);
    return r.body;
  }

  private async check(url: string): Promise<CatalogStatusDto> {
    try {
      await this.download(url);
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.deps.log.warn(`app catalog check failed: ${this.error}`);
    }
    this.checkedAt = rfc3339(this.deps.clock.now());
    return this.status();
  }

  private async download(url: string): Promise<void> {
    const metaBytes = await this.get(url, BUNDLE_FILES.meta, MAX_BUNDLE_META_BYTES, META_TIMEOUT_MS);
    const sigBytes = await this.get(url, BUNDLE_FILES.sig, MAX_SIG_BYTES, META_TIMEOUT_MS);
    const sig = sigBytes.toString('utf8');
    const meta = verifyBundleMeta(metaBytes, sig, this.deps.publicKeys);
    const before = this.active();
    if (meta.serial <= before.serial) {
      this.deps.log.info('app catalog is up to date', { serial: before.serial, offered: meta.serial });
      return;
    }
    let partial: string | null = null;
    try {
      const zip = await this.get(url, BUNDLE_FILES.zip, meta.zip.bytes, ZIP_TIMEOUT_MS);
      const { files } = openBundle({ meta: metaBytes, sig, zip }, this.deps.publicKeys);

      // Stage next to the live folders, validate the way the store reads it, then swap in two renames.
      mkdirSync(this.root, { recursive: true, mode: 0o755 });
      partial = path.join(this.root, `.partial-${meta.serial}`);
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { mode: 0o755 });
      for (const [name, bytes] of files) {
        const file = path.resolve(partial, name);
        if (!file.startsWith(partial + path.sep)) throw new Error(`the app catalog archive has an unsafe path ${JSON.stringify(name)}`);
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
        writeFileSync(file, bytes, { mode: 0o644 });
      }
      writeFileSync(path.join(partial, BUNDLE_FILES.meta), metaBytes, { mode: 0o644 });
      writeFileSync(path.join(partial, BUNDLE_FILES.sig), sigBytes, { mode: 0o644 });
      const index = readCatalogIndex(partial);
      for (const [id, entry] of Object.entries(index.packages)) {
        const st = statSync(path.join(partial, entry.dir), { throwIfNoEntry: false });
        if (!st?.isDirectory()) throw new Error(`the app catalog lists ${id} but has no ${entry.dir}/ folder`);
      }
      const target = path.join(this.root, String(meta.serial));
      rmSync(target, { recursive: true, force: true });
      renameSync(partial, target);
      partial = null;
      const tmp = `${this.pointerFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ serial: meta.serial }) + '\n', { mode: 0o644 });
      renameSync(tmp, this.pointerFile);
      // Keep the new catalog and the one it replaced (a read that started before the swap may still be in it).
      this.prune(new Set([meta.serial, ...(before.origin === 'downloaded' ? [before.serial] : [])]));
      this.deps.log.info('app catalog updated', { serial: meta.serial, commit: meta.commit, packages: Object.keys(index.packages).length, from: before.serial });
    } catch (e) {
      if (partial) rmSync(partial, { recursive: true, force: true });
      throw e;
    }
  }

  private prune(keep: Set<number>): void {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const n of names) {
      const stale = (/^\d+$/.test(n) && !keep.has(Number(n))) || n.startsWith('.partial-');
      if (!stale) continue;
      try {
        rmSync(path.join(this.root, n), { recursive: true, force: true });
      } catch (e) {
        this.deps.log.warn(`could not remove the old app catalog ${n}: ${(e as Error).message}`);
      }
    }
  }

  // First check a minute after start (the daemon settles first), then every six hours. Off: no timer.
  start(firstDelayMs = CATALOG_FIRST_CHECK_MS, intervalMs = CATALOG_CHECK_INTERVAL_MS): void {
    this.stop();
    if (!this.deps.url) return;
    const tick = () => void this.refresh().catch(() => undefined);
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      tick();
      this.timer = setInterval(tick, intervalMs);
      this.timer.unref?.();
    }, firstDelayMs);
    this.firstTimer.unref?.();
  }
  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }
}
