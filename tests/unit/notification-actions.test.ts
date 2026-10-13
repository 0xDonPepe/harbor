import { describe, expect, it } from 'vitest';
import { notificationActions, notificationLink } from '../../src/lifecycle/service.js';

// Decision 164: every notification brings its own call to action, derived from its kind.
describe('notification actions', () => {
  it('a Harbor release offers Install now', () => {
    expect(notificationActions('harbor-update', null)).toEqual([{ label: 'Install now', do: 'update-harbor', route: null }]);
    expect(notificationLink('harbor-update')).toBe('#/settings');
  });
  it('app actions appear only when the row names an app', () => {
    expect(notificationActions('update-available', 'i1')).toEqual([{ label: 'Update now', do: 'update-app', route: null }]);
    expect(notificationActions('update-available', null)).toEqual([]);
    expect(notificationActions('home-locked', 'i1')[0]).toMatchObject({ label: 'Unlock', do: 'open-app' });
  });
  it('a failed backup retries first, then points at Backups', () => {
    expect(notificationActions('backup-failed', 'i1').map((a) => a.do)).toEqual(['back-up-now', 'route']);
    expect(notificationActions('backup-target', null)).toEqual([{ label: 'Open Backups', do: 'route', route: '#/settings/backups' }]);
  });
  it('drives and disks go to Storage; unknown kinds offer nothing', () => {
    expect(notificationActions('device-mount-failed', null)[0]!.route).toBe('#/settings/storage');
    expect(notificationActions('disk-pressure', null)[0]!.route).toBe('#/settings/storage');
    // decision 174: a failed every-app Tailscale address points at Remote access, where it can be retried
    expect(notificationLink('tailnet-all-failed')).toBe('#/settings/remote');
    expect(notificationActions('tailnet-all-failed', 'i1').map((a) => a.label)).toEqual(['Open Remote access', 'Open app']);
    expect(notificationActions('something-new', 'i1')).toEqual([]);
  });
});
