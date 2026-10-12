import { useState } from 'react';
import type { NotificationActionDto, NotificationDto } from '../../../src/contracts/api';
import { api, ApiError } from '../api';
import { requestHarborUpdate } from './pages/Settings';
import type { Console } from './store';

// Decision 164: every notification brings its own buttons (the daemon derives them from its kind); the
// console runs them. Mutations still go through plan → review (an app update) or Harbor's own confirm.
export function NotificationActions({ c, item, onOpenApp, onDone }: { c: Console; item: NotificationDto; onOpenApp: (instanceId: string) => void; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  if (!item.actions?.length) return null;
  const run = async (a: NotificationActionDto) => {
    setMsg(null);
    if (!item.read) void api.markNotificationRead(item.id).then((res) => c.patchData((d) => ({ ...d, notifications: res }))).catch(() => {});
    const inst = item.instanceId ? c.data.instances.find((i) => i.id === item.instanceId) : undefined;
    switch (a.do) {
      case 'route':
        if (a.route) location.hash = a.route;
        return onDone?.();
      case 'open-app':
        if (item.instanceId) onOpenApp(item.instanceId);
        return onDone?.();
      case 'update-harbor':
        requestHarborUpdate();
        location.hash = '#/settings/overview';
        return onDone?.();
      case 'update-app':
        if (!inst) return setMsg({ text: 'That app is gone.', error: true });
        void c.start({ kind: 'update', instance: inst });
        return onDone?.();
      case 'back-up-now':
        if (!item.instanceId) return;
        setBusy(true);
        try {
          await api.backupNow(item.instanceId);
          setMsg({ text: 'Backup queued.', error: false });
        } catch (e) {
          setMsg({ text: e instanceof ApiError ? e.message : String(e), error: true });
        } finally {
          setBusy(false);
        }
    }
  };
  return (
    <div className="notif-actions row wrap">
      {item.actions.map((a, i) => (
        <button key={`${a.do}-${a.label}`} className={`btn small ${i === 0 ? 'primary' : 'ghost'}`} disabled={busy} onClick={() => void run(a)} aria-label={`${a.label}: ${item.title}`}>
          {a.label}
        </button>
      ))}
      {msg && (
        <span role="status" className={`small ${msg.error ? 'error' : 'muted'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
