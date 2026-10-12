export type Theme = 'system' | 'dark' | 'light';

// Theme is a per-browser convenience (localStorage may be unavailable; the page must still render).
export function readTheme(): Theme {
  try {
    const t = localStorage.getItem('harbor.theme');
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem('harbor.theme');
    else localStorage.setItem('harbor.theme', t);
  } catch {
    /* ignore */
  }
  if (t === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = t;
}

// Wallpaper (decision 164): the picture (of the day, or your own) or flat Harbor, which follows the
// light/dark theme. Older presets (dusk, forest, plain) read as "no choice", so they fall back to the picture.
export const WALLPAPERS = ['photo', 'harbor'] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];
function storedWallpaper(): Wallpaper | null {
  try {
    const w = localStorage.getItem('harbor.wallpaper');
    return (WALLPAPERS as readonly string[]).includes(w ?? '') ? (w as Wallpaper) : null;
  } catch {
    return null;
  }
}
// At page load: paint the stored choice without storing anything (no choice must stay "no choice").
export function bootWallpaper(): void {
  try {
    if (localStorage.getItem('harbor.wallpaper') !== null && !storedWallpaper()) localStorage.removeItem('harbor.wallpaper');
  } catch {
    /* ignore */
  }
  applyWallpaperRuntime(readWallpaper());
}
export function readWallpaper(): Wallpaper {
  return storedWallpaper() ?? 'harbor';
}
export function applyWallpaper(w: Wallpaper): void {
  try {
    localStorage.setItem('harbor.wallpaper', w);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset['wallpaper'] = w;
}
// The daemon's picture (uploaded, or the rotating one) becomes the 'photo' wallpaper; CSS reads the
// variable. `version` changes whenever the picture does, which busts the browser cache.
let currentVersion: string | null | undefined;
export function syncWallpaperPicture(picture: { present: boolean; version: string | null }): void {
  const version = picture.present ? (picture.version ?? 'x') : null;
  if (version === currentVersion) return;
  currentVersion = version;
  if (picture.present) document.documentElement.style.setProperty('--wallpaper-url', `url(/v1/appearance/wallpaper?v=${encodeURIComponent(version!)})`);
  else document.documentElement.style.removeProperty('--wallpaper-url');
  const pref = readWallpaper();
  if (picture.present && !hasExplicitWallpaper()) applyWallpaperRuntime('photo');
  else if (!picture.present && pref === 'photo') applyWallpaperRuntime('harbor');
}
// compatibility for the login screen (no session yet): HEAD tells us whether a picture exists
export function applyWallpaperPhoto(present: boolean): void {
  syncWallpaperPicture({ present, version: present ? `login-${Date.now()}` : null });
}
export function hasExplicitWallpaper(): boolean {
  return storedWallpaper() !== null;
}
// Surface opacity: how solid cards/sidebar/dialogs are over the wallpaper (0.5 translucent → 1 solid).
// Decision 164: the default is nearly solid (0.94, was 0.82) so text over a busy photo stays readable.
export const DEFAULT_SURFACES_OPACITY = 0.94;
// Per-browser like theme/wallpaper; CSS derives --card/--card-2 from --surfaces-opacity.
export function readSurfacesOpacity(): number {
  try {
    const raw = localStorage.getItem('harbor.surfaces-opacity');
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0.5, v)) : DEFAULT_SURFACES_OPACITY;
  } catch {
    return DEFAULT_SURFACES_OPACITY;
  }
}
export function applySurfacesOpacity(v: number): void {
  const clamped = Math.min(1, Math.max(0.5, v));
  try {
    if (Math.abs(clamped - DEFAULT_SURFACES_OPACITY) < 0.001) localStorage.removeItem('harbor.surfaces-opacity');
    else localStorage.setItem('harbor.surfaces-opacity', String(clamped));
  } catch {
    /* ignore */
  }
  document.documentElement.style.setProperty('--surfaces-opacity', String(clamped));
}
export function applyWallpaperRuntime(w: Wallpaper): void {
  document.documentElement.dataset['wallpaper'] = w;
}
