// The only piece of the wallpaper rotation that talks to the internet. One interface, a real
// implementation on Node's fetch with a descriptive User-Agent, size and time limits, and a fake for tests.
import { assertPublicHttpsUrl, systemResolver, type Resolver } from './url-guard.js';

export interface FetchResult {
  status: number;
  contentType: string | null;
  body: Buffer;
}
export interface Fetcher {
  fetch(url: string, opts?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string; maxBytes?: number; timeoutMs?: number }): Promise<FetchResult>;
}

export const USER_AGENT = 'harbor-wallpapers/0.5 (self-hosted app manager; +https://github.com/carlosalaniz/harbor)';

// Decision 169: redirects are followed by hand (at most MAX_REDIRECTS hops) so every hop's URL is checked
// before it is requested: https only, never a local or private address (see url-guard.ts).
export const MAX_REDIRECTS = 5;

export class RealFetcher implements Fetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly resolve: Resolver;
  constructor(opts: { fetchImpl?: typeof fetch; resolve?: Resolver } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resolve = opts.resolve ?? systemResolver;
  }

  async fetch(url: string, opts: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchResult> {
    const max = opts.maxBytes ?? 16 * 1024 * 1024;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    try {
      let current = url;
      let method: 'GET' | 'POST' = opts.method ?? 'GET';
      let body = opts.body;
      let headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*', ...(opts.headers ?? {}) };
      let res: Response;
      for (let hop = 0; ; hop++) {
        const target = await assertPublicHttpsUrl(current, this.resolve);
        res = await this.fetchImpl(target.href, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: ctl.signal });
        const location = res.status >= 300 && res.status <= 399 && res.status !== 304 ? res.headers.get('location') : null;
        if (!location) break;
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
        const next = new URL(location, target);
        // A redirect to another host never carries the credentials meant for the first one.
        if (next.host !== target.host) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())));
        // 301/302/303 turn a POST into a GET (as browsers do); 307/308 keep the method and body.
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        current = next.href;
      }
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > max) throw new Error(`response too large (${len} bytes)`);
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            await reader.cancel();
            throw new Error(`response too large (> ${max} bytes)`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return { status: res.status, contentType: res.headers.get('content-type'), body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(t);
    }
  }
}

// Tests and `pnpm dev`: answers from a table keyed by URL prefix; records every request.
export class FakeFetcher implements Fetcher {
  routes: { match: (url: string) => boolean; reply: (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => FetchResult }[] = [];
  requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  on(prefix: string | RegExp, reply: FetchResult | ((url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => FetchResult)): this {
    this.routes.push({ match: (u) => (typeof prefix === 'string' ? u.startsWith(prefix) : prefix.test(u)), reply: typeof reply === 'function' ? reply : () => reply });
    return this;
  }
  async fetch(url: string, opts: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string } = {}): Promise<FetchResult> {
    this.requests.push({ url, method: opts.method ?? 'GET', headers: opts.headers ?? {} });
    const r = this.routes.find((x) => x.match(url));
    if (!r) return { status: 404, contentType: 'text/plain', body: Buffer.from(`fake fetcher: no route for ${url}`) };
    return r.reply(url, opts);
  }
}

export const json = (value: unknown, status = 200): FetchResult => ({ status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)) });
