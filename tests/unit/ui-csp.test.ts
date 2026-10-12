import { describe, expect, it } from 'vitest';
import { uiCsp } from '../../src/api/server.js';

// Decision 164: images may load from the certificate's own names (the https probe), nothing wider.
describe('console CSP', () => {
  it('is unchanged while LAN HTTPS is off', () => {
    expect(uiCsp([])).toContain("img-src 'self' data:;");
  });
  it('adds exactly the certificate hosts to img-src', () => {
    const csp = uiCsp(['harbor.local', 'box.local', '192.168.1.20', 'fd00::5']);
    expect(csp).toContain("img-src 'self' data: https://harbor.local https://box.local https://192.168.1.20 https://[fd00::5];");
    expect(csp).toContain("connect-src 'self';");
  });
  it('drops a name that could smuggle a directive', () => {
    expect(uiCsp(["evil.local; script-src *"])).toContain("img-src 'self' data:;");
  });
});
