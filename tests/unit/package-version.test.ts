import { describe, expect, it } from 'vitest';
import { listCatalog, loadPackage } from '../../src/packages/catalog.js';
import { packageVersionOf } from '../../src/packages/version.js';
import { REPO_CATALOG } from './helpers.js';

// Decision 174: the Store shows the app's own version, not only Harbor's package revision.
describe('app version of a package', () => {
  const pkg = loadPackage(REPO_CATALOG, 'immich');
  it('takes the main endpoint service image version from release.json when the manifest names none', () => {
    expect(pkg.manifest.release.version).toBeUndefined();
    expect(packageVersionOf(pkg)).toBe('3.2.1'); // server (behind the web endpoint), not the database image
  });
  it('prefers the manifest release.version (the author\'s own words)', () => {
    expect(packageVersionOf({ ...pkg, manifest: { ...pkg.manifest, release: { ...pkg.manifest.release, version: '3.2.1-hotfix' } } })).toBe('3.2.1-hotfix');
  });
  it('falls back to the only image, and to null when nothing says', () => {
    const one = loadPackage(REPO_CATALOG, 'memos');
    expect(packageVersionOf({ ...one, manifest: { ...one.manifest, ui: { primaryEndpoint: 'missing' } } })).toBe('0.30.0');
    const excalidraw = loadPackage(REPO_CATALOG, 'excalidraw'); // its release.json records no appVersion
    expect(packageVersionOf(excalidraw)).toBeNull();
    expect(packageVersionOf({ ...pkg, manifest: { ...pkg.manifest, ui: { primaryEndpoint: 'missing' } } })).toBeNull(); // four images, none is "the" app
  });
  it('drops an image variant suffix, never a prerelease marker', () => {
    const at = (appVersion: string) => packageVersionOf({ ...pkg, release: { ...pkg.release, images: { ...pkg.release.images, server: { ...pkg.release.images['server']!, appVersion } } } });
    expect(at('8.1.3-bookworm')).toBe('8.1.3');
    expect(at('2.0.0-rc1')).toBe('2.0.0-rc1');
    expect(at('2.0.0-beta')).toBe('2.0.0-beta');
    expect(at('14-vectorchord0.4.3')).toBe('14-vectorchord0.4.3');
  });
  it('is what the catalog listing reports', () => {
    const items = listCatalog(REPO_CATALOG);
    expect(items.find((i) => i.id === 'immich')?.version).toBe('3.2.1');
    expect(items.find((i) => i.id === 'nextcloud')?.version).toBe('34.0.4'); // tag 34.0.4-apache: the variant is not the version
    expect(items.find((i) => i.id === 'excalidraw')?.version).toBeNull();
  });
});
