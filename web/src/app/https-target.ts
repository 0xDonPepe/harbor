// Decision 164: the pure half of the https move (no DOM, so unit tests can import it).
export const SKIP_KEY = 'harbor.skiphttps';

export function skipHttpsRequested(search: string, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): boolean {
  const p = new URLSearchParams(search);
  try {
    if (p.has('skiphttps')) {
      const v = (p.get('skiphttps') ?? '').toLowerCase();
      if (v === 'false' || v === '0') store?.removeItem(SKIP_KEY);
      else store?.setItem(SKIP_KEY, '1');
    }
    return store?.getItem(SKIP_KEY) === '1';
  } catch {
    return p.has('skiphttps') && !['false', '0'].includes((p.get('skiphttps') ?? '').toLowerCase());
  }
}

// Where to go: the same name the browser used, only when the certificate covers it (an SSH tunnel to
// localhost, say, never moves).
export function httpsTarget(loc: { protocol: string; hostname: string; pathname: string; search: string; hash: string }, hosts: string[]): string | null {
  if (loc.protocol !== 'http:' || !hosts.includes(loc.hostname)) return null;
  const p = new URLSearchParams(loc.search);
  p.delete('skiphttps');
  const q = p.toString();
  const host = loc.hostname.includes(':') ? `[${loc.hostname}]` : loc.hostname;
  return `https://${host}${loc.pathname}${q ? `?${q}` : ''}${loc.hash}`;
}

