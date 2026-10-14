// Decision 179: which graphics card this machine can hand to an app that asks for `gpu`. Read-only host facts
// (files under /proc, /dev, /sys, /run, /usr/lib and Docker's registered runtimes); the planner gets them as an
// input. Every path is under `root` so tests use a fake host tree. Never throws.
// Decision 181: the NVIDIA driver is only CHECKED (on the PCI bus but not loaded, updated but not rebooted, too
// old: a note, the card is still handed over). Harbor never installs, updates or removes a driver: that is the OS's (kernel modules, DKMS, Secure Boot,
// reboots, and the card may drive the desktop).
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import type { GpuProblem, HostGpu } from '../contracts/types.js';
import { NVIDIA_DRIVER_MIN_MAJOR } from '../planner/gpu.js';

export interface GpuObserver {
  // fresh facts (cached ~30 s so plan creation stays cheap)
  detect(): Promise<HostGpu>;
  // the last facts detect() returned, without probing (null before the first one)
  cached(): HostGpu | null;
}

export interface GpuProbe {
  root: string; // '/' on a real host
  // `docker info` Runtimes (names); may throw when the engine is down
  runtimes: () => Promise<string[]>;
}

export const NO_GPU: HostGpu = { kind: 'none', detail: 'No graphics card found' };

// Kernel DRM drivers of Intel and AMD graphics. An nvidia-drm render node (an NVIDIA card's own) does not count:
// without the toolkit it gives a container nothing it can compute on.
const DRI_DRIVERS: Readonly<Record<string, string>> = { i915: 'Intel graphics', xe: 'Intel graphics', amdgpu: 'AMD graphics', radeon: 'AMD graphics' };
const HOOK_DIRS = ['usr/bin', 'usr/local/bin', 'usr/sbin'];
// Where the driver's userspace libraries live (Ubuntu/Debian x86-64 and arm64, Fedora/RHEL)
const NVML_DIRS = ['usr/lib/x86_64-linux-gnu', 'usr/lib64', 'usr/lib/aarch64-linux-gnu'];

// The kernel module's version from /proc/driver/nvidia/version, both wordings:
//   "NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.163.01  Tue Apr  8 …"
//   "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  595.99.02  Release Build  …"
export function parseNvidiaDriverVersion(text: string): string | null {
  const m = /^NVRM version:.*?Kernel Module(?: for [\w-]+)?\s+(\d+\.\d+(?:\.\d+)?)\b/m.exec(text);
  return m ? m[1]! : null;
}

const versionParts = (v: string): number[] => v.split('.').map(Number);
function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Every installed userspace driver version (libnvidia-ml.so.<version>), oldest first. Several can sit side by side
// (a .run install apt later replaced, a hand-copied library): the toolkit picks the one matching the running module.
function nvidiaLibraryVersions(root: string): string[] {
  const found = new Set<string>();
  for (const d of NVML_DIRS) {
    let names: string[];
    try {
      names = readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^libnvidia-ml\.so\.(\d+\.\d+(?:\.\d+)?)$/.exec(n);
      if (m) found.add(m[1]!);
    }
  }
  return [...found].sort(compareVersions);
}

// Drivers that hold a card for a virtual machine (GPU passthrough): such a card is not this machine's to use
const PASSTHROUGH_DRIVERS = new Set(['vfio-pci', 'pci-stub']);

// An NVIDIA display (0x0300) or 3D (0x0302) controller on the PCI bus, driver loaded or not (its audio function and
// bridges do not count, nor a card handed to a virtual machine: bound to vfio-pci or pci-stub)
function nvidiaOnPci(root: string): boolean {
  const dir = path.join(root, 'sys/bus/pci/devices');
  let devices: string[];
  try {
    devices = readdirSync(dir);
  } catch {
    return false;
  }
  return devices.some((d) => {
    try {
      const vendor = readFileSync(path.join(dir, d, 'vendor'), 'utf8').trim().toLowerCase();
      const cls = readFileSync(path.join(dir, d, 'class'), 'utf8').trim().toLowerCase();
      if (vendor !== '0x10de' || !(cls.startsWith('0x0300') || cls.startsWith('0x0302'))) return false;
    } catch {
      return false;
    }
    let bound: string | null = null;
    try {
      bound = path.basename(readlinkSync(path.join(dir, d, 'driver')));
    } catch {
      /* no driver bound (or nouveau's link unreadable): counts */
    }
    return bound === null || !PASSTHROUGH_DRIVERS.has(bound);
  });
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function nvidiaName(root: string): string {
  const dir = path.join(root, 'proc/driver/nvidia/gpus');
  const names: string[] = [];
  try {
    for (const bus of readdirSync(dir).sort()) {
      try {
        const m = /^Model:\s*(.+?)\s*$/m.exec(readFileSync(path.join(dir, bus, 'information'), 'utf8'));
        if (m) names.push(m[1]!);
      } catch {
        /* unreadable entry */
      }
    }
  } catch {
    /* no per-card entries */
  }
  if (!names.length) return 'NVIDIA graphics card';
  return names.length === 1 ? names[0]! : `${names[0]!} and ${names.length - 1} more`;
}

// the first executable toolkit hook (Docker's built-in NVIDIA support runs it), or null
function hookPath(root: string): string | null {
  for (const d of HOOK_DIRS) {
    const p = path.join(root, d, 'nvidia-container-runtime-hook');
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

// When dockerd started (ms since the epoch), or null when that cannot be read: its pid file, /proc/<pid>/stat
// field 22 (start time in clock ticks since boot; USER_HZ is 100 on x86-64) and /proc/stat btime (boot time).
export function dockerdStartedAt(root: string): number | null {
  for (const pidFile of ['run/docker.pid', 'var/run/docker.pid']) {
    try {
      const pid = readFileSync(path.join(root, pidFile), 'utf8').trim();
      if (!/^\d+$/.test(pid)) continue;
      const stat = readFileSync(path.join(root, 'proc', pid, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // field 3 (state) onwards
      const ticks = Number(fields[19]);
      const btime = /^btime\s+(\d+)$/m.exec(readFileSync(path.join(root, 'proc/stat'), 'utf8'));
      if (!Number.isFinite(ticks) || !btime) continue;
      return (Number(btime[1]) + ticks / 100) * 1000;
    } catch {
      /* no pid file here, or the process is gone */
    }
  }
  return null;
}

// Docker registers its `nvidia` device driver once, when dockerd starts, and only when the hook exists then: a hook
// installed after that is not usable until Docker restarts (a container asking for the card would fail to start).
function hookUsable(root: string, hook: string): boolean {
  const started = dockerdStartedAt(root);
  if (started === null) return false;
  try {
    // ctime, not mtime: dpkg keeps the package's build time as mtime, while ctime is when the file landed here
    return started >= statSync(hook).ctimeMs;
  } catch {
    return false;
  }
}

// the first Intel/AMD render node: its name, group and description
function driNode(root: string): { node: string; detail: string; renderGid: number } | null {
  let nodes: string[];
  try {
    nodes = readdirSync(path.join(root, 'dev/dri')).filter((n) => /^renderD\d+$/.test(n)).sort();
  } catch {
    return null;
  }
  for (const n of nodes) {
    try {
      const driver = path.basename(readlinkSync(path.join(root, 'sys/class/drm', n, 'device/driver')));
      const detail = DRI_DRIVERS[driver];
      if (detail) return { node: n, detail, renderGid: statSync(path.join(root, 'dev/dri', n)).gid };
    } catch {
      /* no driver link: not a card we know */
    }
  }
  return null;
}

export async function detectGpu(probe: GpuProbe): Promise<HostGpu> {
  try {
    const { root } = probe;
    const versionPath = path.join(root, 'proc/driver/nvidia/version');
    const loaded = existsSync(versionPath); // the kernel module is running
    const onPci = nvidiaOnPci(root);
    const nvidia = loaded || existsSync(path.join(root, 'dev/nvidia0')) || onPci;
    const dri = driNode(root);
    // only the render node and its group (never card<N> or the video group: no display or modesetting access)
    const driFacts = (): HostGpu => ({ kind: 'dri', detail: dri!.detail, renderNode: dri!.node, renderGid: dri!.renderGid });
    if (nvidia) {
      const versionFile = loaded ? readOrNull(versionPath) : null;
      const driverVersion = versionFile !== null ? parseNvidiaDriverVersion(versionFile) : null;
      const installed = nvidiaLibraryVersions(root);
      // the running driver's own userspace when it is installed (the toolkit uses that one), else the newest
      const libraryVersion = driverVersion && installed.includes(driverVersion) ? driverVersion : (installed.at(-1) ?? null);
      const versions = { ...(driverVersion ? { driverVersion } : {}), ...(libraryVersion ? { libraryVersion } : {}) };
      // an NVIDIA card Docker cannot hand over: the app uses Intel/AMD graphics when there are some, else the CPU
      const blocked = (problem: GpuProblem, detail: string): HostGpu => (dri ? { ...driFacts(), problem, ...versions } : { kind: 'none', detail, problem, ...versions });
      // Decision 181, driver checks first (the toolkit cannot help without a working driver):
      // on the PCI bus with no kernel module loaded (not installed, not rebooted since, or blocked, e.g. by Secure Boot)
      if (onPci && !loaded) return blocked('NVIDIA_DRIVER_MISSING', 'NVIDIA graphics card');
      const name = nvidiaName(root);
      // apt updated the driver and deleted the running module's userspace; the old module still runs. Only claimed when
      // the running version is known and its library is gone (an extra, newer library next to it is not a reboot).
      if (driverVersion && installed.length && !installed.includes(driverVersion)) return blocked('NVIDIA_REBOOT_NEEDED', name);
      // older than CUDA 12 needs: still handed over (CUDA 11 images, NVENC/NVDEC work), with a note
      const tooOld = driverVersion !== null && versionParts(driverVersion)[0]! < NVIDIA_DRIVER_MIN_MAJOR;
      const usable = (): HostGpu => ({ kind: 'nvidia', detail: name, ...(tooOld ? { problem: 'NVIDIA_DRIVER_TOO_OLD' as const } : {}), ...versions });
      let runtimes: string[] = [];
      try {
        runtimes = await probe.runtimes();
      } catch {
        /* engine down or no info(): the hook and dockerd's start time decide */
      }
      // A registered `nvidia` runtime only shows after a Docker restart with the toolkit installed, so the device
      // driver is registered too. Else the hook counts only when dockerd started after it was installed.
      if (runtimes.includes('nvidia')) return usable();
      const hook = hookPath(root);
      if (hook && hookUsable(root, hook)) return usable();
      return blocked(hook ? 'NVIDIA_DOCKER_RESTART_NEEDED' : 'NVIDIA_TOOLKIT_MISSING', name);
    }
    if (dri) return driFacts();
    return NO_GPU;
  } catch (e) {
    return { kind: 'none', detail: `Could not check for a graphics card: ${(e as Error).message}` };
  }
}

// The daemon's observer: real files, Docker's runtimes, a 30-second cache shared by concurrent callers
export class HostGpuObserver implements GpuObserver {
  private last: { at: number; facts: HostGpu } | null = null;
  private pending: Promise<HostGpu> | null = null;
  constructor(private readonly opts: GpuProbe & { now?: () => number; ttlMs?: number }) {}

  async detect(): Promise<HostGpu> {
    const now = (this.opts.now ?? Date.now)();
    if (this.last && now - this.last.at < (this.opts.ttlMs ?? 30_000)) return this.last.facts;
    this.pending ??= detectGpu(this.opts).then((facts) => {
      this.last = { at: (this.opts.now ?? Date.now)(), facts };
      this.pending = null;
      return facts;
    });
    return this.pending;
  }

  cached(): HostGpu | null {
    return this.last?.facts ?? null;
  }
}

// Tests and `pnpm dev`: whatever the test sets (default: no graphics card)
export class FakeGpu implements GpuObserver {
  constructor(public facts: HostGpu = NO_GPU) {}
  async detect(): Promise<HostGpu> {
    return { ...this.facts };
  }
  cached(): HostGpu | null {
    return { ...this.facts };
  }
}

// `pnpm dev` / e2e: HARBOR_DEV_GPU picks what the fake machine has: nvidia | dri | dri-toolkit-missing |
// toolkit-missing | restart-needed | driver-missing | reboot-needed | driver-too-old | none (the default)
export function devGpu(kind: string | undefined): FakeGpu {
  const RTX = 'NVIDIA GeForce RTX 3090';
  switch (kind) {
    case 'nvidia':
      return new FakeGpu({ kind: 'nvidia', detail: RTX, driverVersion: '595.99.02', libraryVersion: '595.99.02' });
    case 'dri':
      return new FakeGpu({ kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992 });
    case 'dri-toolkit-missing':
      return new FakeGpu({ kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992, problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '595.99.02' });
    case 'toolkit-missing':
      return new FakeGpu({ kind: 'none', detail: RTX, problem: 'NVIDIA_TOOLKIT_MISSING', driverVersion: '595.99.02' });
    case 'restart-needed':
      return new FakeGpu({ kind: 'none', detail: RTX, problem: 'NVIDIA_DOCKER_RESTART_NEEDED', driverVersion: '595.99.02' });
    case 'driver-missing':
      return new FakeGpu({ kind: 'none', detail: 'NVIDIA graphics card', problem: 'NVIDIA_DRIVER_MISSING' });
    case 'reboot-needed':
      return new FakeGpu({ kind: 'none', detail: RTX, problem: 'NVIDIA_REBOOT_NEEDED', driverVersion: '550.163.01', libraryVersion: '595.99.02' });
    case 'driver-too-old':
      return new FakeGpu({ kind: 'nvidia', detail: RTX, problem: 'NVIDIA_DRIVER_TOO_OLD', driverVersion: '470.256.02', libraryVersion: '470.256.02' });
    default:
      return new FakeGpu();
  }
}
