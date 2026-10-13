import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchSession } from '../../src/auth/session-watch.js';

// Decision 169: a terminal ends with its session.
describe('watchSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (expiresInMs: number) => {
    let valid = true;
    const listeners = new Set<() => void>();
    const onEnd = vi.fn();
    const w = watchSession({
      valid: () => valid,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      subscribe: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
      onEnd,
      intervalMs: 15_000,
    });
    return { w, onEnd, listeners, revoke: () => ((valid = false), [...listeners].forEach((l) => l())), invalidate: () => (valid = false) };
  };

  it('ends at once when a revocation is announced and the session is gone', () => {
    const t = setup(3_600_000);
    t.listeners.forEach((l) => l()); // another session was revoked: this one is still fine
    expect(t.onEnd).not.toHaveBeenCalled();
    t.revoke();
    expect(t.onEnd).toHaveBeenCalledTimes(1);
    expect(t.listeners.size).toBe(0); // unsubscribed
    vi.advanceTimersByTime(60_000);
    expect(t.onEnd).toHaveBeenCalledTimes(1);
  });

  it('ends at the expiry time', () => {
    const t = setup(5_000);
    t.invalidate(); // what valid() says once the clock passes expiresAt
    vi.advanceTimersByTime(4_000);
    expect(t.onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_100);
    expect(t.onEnd).toHaveBeenCalledTimes(1);
  });

  it('the periodic re-check catches a revocation made by another process', () => {
    const t = setup(3_600_000);
    t.invalidate(); // no announcement (e.g. `harbor admin reset` wrote the database)
    vi.advanceTimersByTime(14_000);
    expect(t.onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(t.onEnd).toHaveBeenCalledTimes(1);
  });

  it('stop() ends the watch quietly (the socket closed first)', () => {
    const t = setup(3_600_000);
    t.w.stop();
    t.revoke();
    vi.advanceTimersByTime(3_700_000);
    expect(t.onEnd).not.toHaveBeenCalled();
    expect(t.listeners.size).toBe(0);
  });
});
