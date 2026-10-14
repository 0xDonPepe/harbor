// Decision 179: which graphics card this machine can hand to an app that asks for `gpu`. Read-only host facts
// (files under /proc, /dev, /sys, /run and Docker's registered runtimes); the planner gets them as an input.
// Every path is under `root` so tests use a fake host tree. Never throws.
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HostGpu } from '../contracts/types.js';

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
    const nvidia = existsSync(path.join(root, 'proc/driver/nvidia/version')) || existsSync(path.join(root, 'dev/nvidia0'));
    const dri = driNode(root);
    // only the render node and its group (never card<N> or the video group: no display or modesetting access)
    const driFacts = (): HostGpu => ({ kind: 'dri', detail: dri!.detail, renderNode: dri!.node, renderGid: dri!.renderGid });
    if (nvidia) {
      let runtimes: string[] = [];
      try {
        runtimes = await probe.runtimes();
      } catch {
        /* engine down or no info(): the hook and dockerd's start time decide */
      }
      // A registered `nvidia` runtime only shows after a Docker restart with the toolkit installed, so the device
      // driver is registered too. Else the hook counts only when dockerd started after it was installed.
      if (runtimes.includes('nvidia')) return { kind: 'nvidia', detail: nvidiaName(root) };
      const hook = hookPath(root);
      if (hook && hookUsable(root, hook)) return { kind: 'nvidia', detail: nvidiaName(root) };
      const problem = hook ? 'NVIDIA_DOCKER_RESTART_NEEDED' : 'NVIDIA_TOOLKIT_MISSING';
      if (dri) return { ...driFacts(), problem };
      return { kind: 'none', detail: nvidiaName(root), problem };
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

// `pnpm dev` / e2e: HARBOR_DEV_GPU=nvidia|dri|dri-toolkit-missing|toolkit-missing|restart-needed|none picks what the
// fake machine has
export function devGpu(kind: string | undefined): FakeGpu {
  switch (kind) {
    case 'nvidia':
      return new FakeGpu({ kind: 'nvidia', detail: 'NVIDIA GeForce RTX 3090' });
    case 'dri':
      return new FakeGpu({ kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992 });
    case 'dri-toolkit-missing':
      return new FakeGpu({ kind: 'dri', detail: 'Intel graphics', renderNode: 'renderD128', renderGid: 992, problem: 'NVIDIA_TOOLKIT_MISSING' });
    case 'toolkit-missing':
      return new FakeGpu({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_TOOLKIT_MISSING' });
    case 'restart-needed':
      return new FakeGpu({ kind: 'none', detail: 'NVIDIA GeForce RTX 3090', problem: 'NVIDIA_DOCKER_RESTART_NEEDED' });
    default:
      return new FakeGpu();
  }
}
