import type { LoadedPackage } from '../contracts/types.js';

// Decision 174: the app version people know ("Open WebUI 0.12.0"), next to Harbor's package revision.
// The manifest's free-text release.version wins (an author's own words); else the version recorded for the
// image of the service behind the main endpoint (release.json images.<svc>.appVersion, written by
// scripts/catalog-pin.mjs); else the only image's version. Null when none says (a git build, an old upload).
export function packageVersionOf(pkg: Pick<LoadedPackage, 'manifest' | 'release'>): string | null {
  const own = pkg.manifest.release.version?.trim();
  if (own) return own;
  const images = pkg.release.images ?? {};
  const primary = pkg.manifest.endpoints[pkg.manifest.ui.primaryEndpoint]?.service;
  const main = primary ? images[primary]?.appVersion?.trim() : undefined;
  if (main) return imageVersion(main);
  const all = Object.values(images);
  const only = all.length === 1 ? all[0]!.appVersion?.trim() : undefined;
  return only ? imageVersion(only) : null;
}

// An image tag's variant is not part of the app's version: "34.0.4-apache" is Nextcloud 34.0.4. A prerelease
// marker is ("2.0.0-rc1" stays). Only one trailing word is dropped; anything else stays as recorded.
const VARIANT = /^(v?\d+(?:\.\d+)+)-([a-z][a-z0-9]*)$/i;
const PRERELEASE = /^(rc|beta|alpha|pre|preview|dev|nightly)\d*$/i;
export function imageVersion(v: string): string {
  const m = VARIANT.exec(v);
  return m && !PRERELEASE.test(m[2]!) ? m[1]! : v;
}
