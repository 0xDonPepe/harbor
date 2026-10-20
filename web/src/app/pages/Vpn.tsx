// Settings → VPN (decision 184): the apps' WireGuard tunnel. Add it from the provider's file (pasted or uploaded),
// see whether it is connected, send every app through it, replace or remove it. The file goes up once; nothing secret
// comes back. Each app's own choice (Direct, Through the VPN, Offline) lives in its drawer.
import { useCallback, useEffect, useState } from 'react';
import type { VpnDto } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { Dialog, Pill } from '../components';
import { vpnStatusText } from '../internet-text';
import type { Console } from '../store';

const errText = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.nextAction ? `. ${e.nextAction}` : ''}` : e instanceof Error ? e.message : String(e));

export function Vpn({ c }: { c: Console }) {
  const [v, setV] = useState<VpnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const load = useCallback(async (check = false) => {
    try {
      setV(check ? await api.checkVpn() : await api.vpn());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (fn: () => Promise<VpnDto>) => {
    setBusy(true);
    setError(null);
    try {
      setV(await fn());
      void c.refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!v) {
    return (
      <section className="card" aria-labelledby="vpn-h">
        <h2 id="vpn-h">VPN</h2>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }
  const tone = v.status.state === 'connected' ? 'ok' : v.status.state === 'connecting' ? 'busy' : v.status.state === 'down' ? 'bad' : 'muted';
  const viaVpn = v.apps.filter((a) => a.mode === 'vpn');
  const offline = v.apps.filter((a) => a.mode === 'offline');
  return (
    <>
      <section className="card" aria-labelledby="vpn-h">
        <h2 id="vpn-h">VPN</h2>
        <p className="muted small">
          Send what your apps open towards the internet through a VPN. People still reach your apps the usual ways, and Harbor itself (updates, remote access) keeps going direct. An app that goes through the VPN
          never falls back to direct: while the VPN is not connected, it has no internet.
        </p>
        {!v.available && (
          <p className="warn small" role="alert">
            {v.reason}
          </p>
        )}
        {v.available && !v.tunnel && (
          <>
            <p>Use the WireGuard configuration file your VPN provider gives you (Mullvad, Proton VPN, IVPN, AirVPN and most others offer one; pick a single server and “all traffic”).</p>
            {!v.tunnelAvailable && v.reason && <p className="warn small">{v.reason}</p>}
            <div className="row">
              <button className="btn primary" disabled={!v.tunnelAvailable || busy} onClick={() => setAdding(true)}>
                Add VPN…
              </button>
            </div>
          </>
        )}
        {v.tunnel && (
          <>
            <p className="row wrap">
              <Pill tone={tone}>{v.status.state === 'connected' ? 'connected' : v.status.state === 'connecting' ? 'connecting' : 'not connected'}</Pill>
              <strong>{v.tunnel.name ?? 'VPN'}</strong>
              <span className="muted small" role="status">
                {vpnStatusText(v.status)}
              </span>
            </p>
            <dl className="kv">
              <dt>Server</dt>
              <dd>
                <code>{v.tunnel.endpoint}</code>
              </dd>
              <dt>Tunnel address</dt>
              <dd>
                <code>{v.tunnel.addresses.join(', ')}</code>
              </dd>
              <dt>DNS</dt>
              <dd>
                <code>{v.tunnel.dns.join(', ')}</code>
                {v.tunnel.dnsFallback ? <span className="muted small"> · your file named none, so Harbor uses Quad9, through the tunnel</span> : <span className="muted small"> · apps' lookups go here, through the tunnel</span>}
              </dd>
            </dl>
            <p className="row wrap">
              <button className="btn" disabled={busy} onClick={() => void act(() => api.checkVpn())}>
                Check now
              </button>
              <button className="btn" disabled={busy || !v.tunnelAvailable} onClick={() => setAdding(true)}>
                Replace…
              </button>
              <button className="btn danger" disabled={busy} onClick={() => setRemoving(true)}>
                Remove…
              </button>
            </p>
          </>
        )}
        {v.rules.state === 'failed' && (
          <p className="error small" role="alert">
            Harbor could not load its rules for VPN and offline apps: {v.rules.message}. Apps that need them do not start until they load.
          </p>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </section>
      {v.available && (
        <section className="card" aria-labelledby="vpn-apps-h">
          <h2 id="vpn-apps-h">Apps</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={v.allApps}
              disabled={busy}
              onChange={(e) => {
                if (e.target.checked) setConfirmAll(true);
                else void act(() => api.setVpnAllApps(false));
              }}
              aria-label="Send every app through the VPN"
            />{' '}
            Send every app through the VPN
          </label>
          <p className="muted small">Apps set to Direct go through it too. Offline apps stay offline.</p>
          {viaVpn.length > 0 && (
            <p className="small">
              <strong>Through the VPN:</strong> {viaVpn.map((a) => a.name).join(', ')}
            </p>
          )}
          {offline.length > 0 && (
            <p className="small">
              <strong>Offline:</strong> {offline.map((a) => a.name).join(', ')}
            </p>
          )}
          {!v.apps.length && <p className="muted small">Every app goes direct.</p>}
          <p className="muted small">Change one app in its drawer: Internet → Change…</p>
        </section>
      )}
      {adding && (
        <AddVpnDialog
          replacing={Boolean(v.tunnel)}
          onClose={() => setAdding(false)}
          onSave={async (config, name) => {
            setV(await api.setVpn(config, name));
            setAdding(false);
            void c.refresh();
          }}
        />
      )}
      {removing && (
        <Dialog title="Remove the VPN?" onClose={() => setRemoving(false)}>
          <p>{viaVpn.length ? `${viaVpn.map((a) => a.name).join(', ')} ${viaVpn.length === 1 ? 'goes' : 'go'} through the VPN and will have no internet until you add one again or switch ${viaVpn.length === 1 ? 'it' : 'them'} to Direct.` : 'No app goes through it right now.'}</p>
          <div className="row end">
            <button className="btn" onClick={() => setRemoving(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setRemoving(false);
                void act(() => api.removeVpn());
              }}
            >
              Remove VPN
            </button>
          </div>
        </Dialog>
      )}
      {confirmAll && (
        <Dialog title="Send every app through the VPN?" onClose={() => setConfirmAll(false)}>
          <p>Every app that goes direct now goes through the VPN instead. The firewall changes right away; each running app that changes then restarts in turn (a few seconds) so its lookups follow too.</p>
          {!v.tunnel && <p className="warn small">No VPN is set up yet: until you add one, these apps have no internet.</p>}
          <div className="row end">
            <button className="btn" onClick={() => setConfirmAll(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setConfirmAll(false);
                void act(() => api.setVpnAllApps(true));
              }}
            >
              Send every app through it
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function AddVpnDialog({ replacing, onClose, onSave }: { replacing: boolean; onClose: () => void; onSave: (config: string, name?: string) => Promise<void> }) {
  const [config, setConfig] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 16 * 1024) {
      setError('That file is too large for a WireGuard configuration.');
      return;
    }
    setConfig(await f.text());
    if (!name.trim()) setName(f.name.replace(/\.conf$/i, ''));
  };
  return (
    <Dialog title={replacing ? 'Replace the VPN' : 'Add a VPN'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          onSave(config, name.trim() || undefined)
            .catch((err: unknown) => setError(errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <p className="muted small">Paste the WireGuard configuration from your VPN provider, or choose the .conf file. Its private key stays on this machine, readable by root only; Harbor never shows it again.</p>
        <label className="small">
          WireGuard configuration
          <textarea className="code" rows={10} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} autoComplete="off" placeholder={'[Interface]\nPrivateKey = …\nAddress = …\nDNS = …\n\n[Peer]\nPublicKey = …\nAllowedIPs = 0.0.0.0/0\nEndpoint = …'} aria-label="WireGuard configuration" />
        </label>
        <label className="small">
          Or a file
          <input type="file" accept=".conf,text/plain" onChange={(e) => void pickFile(e.target.files?.[0])} aria-label="WireGuard configuration file" />
        </label>
        <label className="small">
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Mullvad Stockholm" aria-label="VPN name" />
        </label>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !config.trim()} aria-busy={busy}>
            {busy ? 'Connecting…' : replacing ? 'Replace' : 'Add VPN'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
