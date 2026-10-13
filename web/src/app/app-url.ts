// The pure half of "where does Open take me" (no DOM, no relative imports, so unit tests can import it).
// An app opens with the same scheme as the console: from https the secure LAN address, from http the plain one;
// from a tailnet or public console its address on that path (decision 166).
// On http the browser either does not trust Harbor's certificate (the console would have moved to https by itself)
// or the operator asked to stay there (?skiphttps), and an https app address would break either way.
export interface EndpointUrls {
  loopback: string;
  lan?: string;
  lanSecure?: string;
  [via: string]: string | undefined;
}

const isLoopbackHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';

function onHost(raw: string, host: string): string {
  try {
    const u = new URL(raw);
    u.hostname = host;
    return u.toString();
  } catch {
    return raw;
  }
}

// A name this machine answers on its own network: an mDNS name (.local), a bare host name or an IP literal. Only
// then may an app address borrow the console's host. A tailnet (*.ts.net) or public name is served by Tailscale
// or Caddy with that name's certificate on 443 only: the same name on an app's port reaches Harbor's LAN relay,
// whose certificate is for harbor.local (found live: ERR_CERT_COMMON_NAME_INVALID from the tailnet console).
export function isLanHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h.endsWith('.local') || !h.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
}

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export function appUrlFrom(urls: EndpointUrls, primary: string, here: { protocol: string; hostname: string }): string {
  const main = urls[primary];
  if (main && primary !== 'loopback') return main;
  const secure = here.protocol === 'https:';
  const host = here.hostname.toLowerCase();
  if (!isLoopbackHost(host) && !isLanHost(host)) {
    // Opened by a tailnet or public name: the app's own address on that same path, when it has one.
    for (const key of ['tailnet', 'public', 'proxy'] as const) if (hostOf(urls[key]) === host) return urls[key]!;
    if (host.endsWith('.ts.net') && urls.tailnet) return urls.tailnet;
    // No address there: the LAN address as Harbor names it (works on the home network), never the borrowed host.
    return (secure ? (urls.lanSecure ?? urls.lan) : (urls.lan ?? urls.lanSecure)) ?? urls.tailnet ?? urls.public ?? urls.loopback;
  }
  if (!isLoopbackHost(host)) {
    const order = secure ? (['lanSecure', 'lan'] as const) : (['lan', 'lanSecure'] as const);
    for (const key of order) {
      const raw = urls[key];
      if (raw) return onHost(raw, here.hostname);
    }
    return urls.loopback;
  }
  // Loopback console over https: still the secure app address (same host the browser used).
  if (secure && urls.lanSecure) return urls.lanSecure;
  return urls.loopback;
}
