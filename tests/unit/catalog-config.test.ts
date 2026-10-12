import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/config.js';
import { OFFICIAL_CATALOG_PUBLIC_KEY, OFFICIAL_CATALOG_URL } from '../../src/packages/catalog-bundle.js';
import { testSigner } from './bundle-helpers.js';

const base = { stateDir: '/tmp/s', catalogDir: '/tmp/c', docker: { mode: 'fake' } };
const cfg = (catalog?: unknown) => normalizeConfig(catalog === undefined ? base : { ...base, catalog }, '/tmp');

describe('config: the official catalog (decision 158)', () => {
  it('defaults to the harbor-apps releases and its pinned key', () => {
    expect(cfg().catalog).toEqual({ url: OFFICIAL_CATALOG_URL, publicKeys: [OFFICIAL_CATALOG_PUBLIC_KEY] });
    expect(cfg({}).catalog).toEqual({ url: OFFICIAL_CATALOG_URL, publicKeys: [OFFICIAL_CATALOG_PUBLIC_KEY] });
  });
  it('url null turns updates off; keys and https URLs are taken as given (trailing slash dropped)', () => {
    expect(cfg({ url: null }).catalog.url).toBeNull();
    const key = testSigner().publicKey;
    expect(cfg({ url: 'https://example.test/releases/latest/download/', publicKeys: [key] }).catalog).toEqual({ url: 'https://example.test/releases/latest/download', publicKeys: [key] });
    expect(cfg({ url: 'http://127.0.0.1:18555/bundle' }).catalog.url).toBe('http://127.0.0.1:18555/bundle');
    expect(cfg({ url: 'http://localhost:9/x' }).catalog.url).toBe('http://localhost:9/x');
  });
  it('refuses plain http off loopback, junk URLs and keys that are not ed25519', () => {
    expect(() => cfg({ url: 'http://example.test/x' })).toThrow(/must be https/);
    expect(() => cfg({ url: 'ftp://example.test/x' })).toThrow(/must be https/);
    expect(() => cfg({ url: 'not a url' })).toThrow(/is not a URL/);
    expect(() => cfg({ url: 'https://u:p@example.test/x' })).toThrow(/credentials/);
    expect(() => cfg({ publicKeys: ['not base64!'] })).toThrow(/invalid config/);
    expect(() => cfg({ publicKeys: [] })).toThrow(/invalid config/);
    expect(() => cfg({ publicKeys: ['QUJDREVGR0hJSktMTU5PUA=='] })).toThrow(/publicKeys\[0\] is not an ed25519 public key/);
    expect(() => cfg({ mirror: true })).toThrow(/invalid config/);
  });
});
