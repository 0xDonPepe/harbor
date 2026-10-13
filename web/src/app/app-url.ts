// The pure half of "where does Open take me" (no DOM, no relative imports, so unit tests can import it).
// An app opens with the same scheme as the console: from https the secure LAN address, from http the plain one.
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

export function appUrlFrom(urls: EndpointUrls, primary: string, here: { protocol: string; hostname: string }): string {
  const main = urls[primary];
  if (main && primary !== 'loopback') return main;
  const secure = here.protocol === 'https:';
  if (!isLoopbackHost(here.hostname)) {
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
