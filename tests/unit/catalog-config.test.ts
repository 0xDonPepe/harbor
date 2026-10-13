import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/config.js';
import { OFFICIAL_CATALOG_URL } from '../../src/packages/catalog-bundle.js';

const base = { stateDir: '/tmp/s', catalogDir: '/tmp/c', docker: { mode: 'fake' } };
const cfg = (catalog?: unknown) => normalizeConfig(catalog === undefined ? base : { ...base, catalog }, '/tmp');

describe('config: the official catalog (decision 158)', () => {
  it('defaults to the harbor-apps releases', () => {
    expect(cfg().catalog).toEqual({ url: OFFICIAL_CATALOG_URL });
    expect(cfg({}).catalog).toEqual({ url: OFFICIAL_CATALOG_URL });
    expect(cfg().notices).toEqual([]);
  });
  it('url null turns updates off; https URLs are taken as given (trailing slash dropped)', () => {
    expect(cfg({ url: null }).catalog.url).toBeNull();
    expect(cfg({ url: 'https://example.test/releases/latest/download/' }).catalog).toEqual({ url: 'https://example.test/releases/latest/download' });
    expect(cfg({ url: 'http://127.0.0.1:18555/bundle' }).catalog.url).toBe('http://127.0.0.1:18555/bundle');
    expect(cfg({ url: 'http://localhost:9/x' }).catalog.url).toBe('http://localhost:9/x');
  });
  it('refuses plain http off loopback, junk URLs and unknown keys', () => {
    expect(() => cfg({ url: 'http://example.test/x' })).toThrow(/must be https/);
    expect(() => cfg({ url: 'ftp://example.test/x' })).toThrow(/must be https/);
    expect(() => cfg({ url: 'not a url' })).toThrow(/is not a URL/);
    expect(() => cfg({ url: 'https://u:p@example.test/x' })).toThrow(/credentials/);
    expect(() => cfg({ mirror: true })).toThrow(/invalid config/);
  });
  it('a config that still lists publicKeys (signing was removed) loads; the keys are ignored with a notice', () => {
    const c = cfg({ url: 'https://example.test/releases/latest/download', publicKeys: ['FIXTURE-KEY-NOT-USED'] });
    expect(c.catalog).toEqual({ url: 'https://example.test/releases/latest/download' });
    expect(c.notices).toEqual([expect.stringMatching(/catalog\.publicKeys is ignored: the app catalog is checked with the release keys built into Harbor/)]);
    expect(cfg({ publicKeys: [] }).catalog).toEqual({ url: OFFICIAL_CATALOG_URL });
  });
});
