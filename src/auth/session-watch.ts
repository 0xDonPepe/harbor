// Decision 169: a long-lived connection authenticated once (the web terminal checks the token on its first
// frame only) must not outlive its session. The watch ends it when the session is revoked (logout, log out
// other sessions, password change: the SessionService announces those at once), when it expires (a timer at
// the expiry), and on a periodic re-check that also catches revocations made by another process (an
// administrator reset from the CLI writes the database directly).
export interface SessionWatchOptions {
  valid: () => boolean; // re-checks the session (no activity stamp)
  expiresAt: string; // RFC 3339
  subscribe: (onRevoke: () => void) => () => void; // returns the unsubscribe
  onEnd: () => void;
  intervalMs?: number;
  now?: () => number;
}

export const SESSION_RECHECK_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647; // setTimeout's ceiling (~24.8 days); the periodic check covers the rest

export function watchSession(o: SessionWatchOptions): { stop: () => void } {
  let ended = false;
  const now = o.now ?? Date.now;
  const check = () => {
    if (ended) return;
    let ok: boolean;
    try {
      ok = o.valid();
    } catch {
      ok = false;
    }
    if (!ok) end();
  };
  const unsubscribe = o.subscribe(check);
  const interval = setInterval(check, o.intervalMs ?? SESSION_RECHECK_MS);
  interval.unref?.();
  const untilExpiry = new Date(o.expiresAt).getTime() - now();
  const expiry = Number.isFinite(untilExpiry) ? setTimeout(check, Math.max(0, Math.min(untilExpiry + 50, MAX_TIMER_MS))) : null;
  expiry?.unref?.();
  function stop(): void {
    clearInterval(interval);
    if (expiry) clearTimeout(expiry);
    unsubscribe();
  }
  function end(): void {
    if (ended) return;
    ended = true;
    stop();
    o.onEnd();
  }
  return { stop };
}
