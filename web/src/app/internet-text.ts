// Decision 184: an app's internet access and the apps' VPN, in the console's plain words. Pure (no DOM, no relative
// imports), so unit tests import it directly.

export type InternetMode = 'direct' | 'vpn' | 'offline';
export interface InternetShape {
  mode: InternetMode;
  choice: InternetMode | null;
  packageDefault: InternetMode;
  allApps: boolean;
}

export const INTERNET_CHOICES: { mode: InternetMode; label: string; hint: string }[] = [
  { mode: 'direct', label: 'Direct', hint: 'It reaches the internet straight from this machine.' },
  { mode: 'vpn', label: 'Through the VPN', hint: 'Everything it opens goes through the VPN (Settings → VPN). While the VPN is not connected, it has no internet.' },
  { mode: 'offline', label: 'Offline', hint: 'It opens no connection at all: not the internet, not your network, not other apps. You can still open it as usual.' },
];

export function internetLabel(m: InternetMode): string {
  return INTERNET_CHOICES.find((c) => c.mode === m)!.label;
}

export function internetHint(m: InternetMode): string {
  return INTERNET_CHOICES.find((c) => c.mode === m)!.hint;
}

// "Through the VPN · every app goes through the VPN", "Offline · the app's default", "Direct · your choice"
export function internetSummary(i: InternetShape): { label: string; why: string } {
  const why = i.allApps && i.mode === 'vpn' && i.choice !== 'vpn' ? 'every app goes through the VPN' : i.choice === null ? "the app's default" : 'your choice';
  return { label: internetLabel(i.mode), why };
}

export interface VpnStatusShape {
  state: 'off' | 'connecting' | 'connected' | 'down';
  latestHandshakeAt: string | null;
}

// The VPN page's status line
export function vpnStatusText(s: VpnStatusShape, now = Date.now()): string {
  if (s.state === 'off') return 'Not set up';
  if (s.state === 'connecting') return 'Connecting…';
  if (s.state === 'down') return 'Not connected: apps that go through it have no internet';
  if (!s.latestHandshakeAt) return 'Connected';
  const secs = Math.max(0, Math.round((now - Date.parse(s.latestHandshakeAt)) / 1000));
  return `Connected · last heard from ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`} ago`;
}
