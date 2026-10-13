import { describe, expect, it } from 'vitest';
import { closeReasons } from '../../web/src/app/terminal-close.js';

// Decision 169: when the daemon ends a terminal because its session ended, it sends the reason and then
// closes the socket. The close event that follows must not wipe the reason off the terminal bar.
describe('terminal close reason', () => {
  it('keeps the reason the daemon sent when the socket closes right after', () => {
    const r = closeReasons();
    expect(r.closed('your session ended (logged out, or the password changed). Log in again to open a terminal.')).toMatch(/^your session ended/);
    expect(r.closed(undefined)).toMatch(/^your session ended/); // onclose after a ready terminal
    expect(r.closed('connection error')).toMatch(/^your session ended/);
  });

  it('uses the close event reason when nothing was said before', () => {
    expect(closeReasons().closed('connection closed')).toBe('connection closed');
    expect(closeReasons().closed(undefined)).toBeUndefined();
  });
});
