import type { SetupStatusDto } from '../../../src/contracts/api';
import { isMockUi } from '../mock/api';
import { httpsTarget, skipHttpsRequested } from './https-target';

// Decision 164: on plain http, when LAN HTTPS is on and this browser already trusts Harbor's certificate,
// the console moves to the https address by itself. Trust is tested, not assumed: a 1x1 image from
// https://<this host>/ only loads when the TLS handshake succeeds (the CSP allows exactly the certificate's
// names). Escape hatch: ?skiphttps (any value but false/0) keeps this tab on http; ?skiphttps=false undoes it.
function probe(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), timeoutMs);
    img.onload = () => (clearTimeout(t), resolve(true));
    img.onerror = () => (clearTimeout(t), resolve(false));
    img.src = `https://${host.includes(':') ? `[${host}]` : host}/v1/network/https/probe?t=${Date.now()}`;
  });
}

// true = the page is leaving for https (do not render).
export async function moveToHttpsIfTrusted(): Promise<boolean> {
  try {
    if (window.location.protocol !== 'http:' || isMockUi()) return false;
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      store = null;
    }
    if (skipHttpsRequested(window.location.search, store)) return false;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('/v1/setup', { signal: ctl.signal, headers: { accept: 'application/json' } }).finally(() => clearTimeout(t));
    if (!res.ok) return false;
    const st = (await res.json()) as Partial<SetupStatusDto>;
    if (!st.https?.enabled) return false;
    const target = httpsTarget(window.location, st.https.hosts);
    if (!target) return false;
    if (!(await probe(window.location.hostname, 2500))) return false;
    window.location.replace(target);
    return true;
  } catch {
    return false;
  }
}
