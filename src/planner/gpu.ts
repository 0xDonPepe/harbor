import type { GpuDto } from '../contracts/api.js';
import type { HostGpu, Manifest } from '../contracts/types.js';

// Decision 179: the `gpu` permission. PURE: the host facts (HostGpu) come from the GpuObserver (src/system/gpu.ts).

// The device request Docker's built-in NVIDIA support turns into `--gpus all` (it runs the toolkit's hook). The
// driver capabilities are named, so Docker sets NVIDIA_DRIVER_CAPABILITIES=compute,utility itself (CUDA and
// nvidia-smi; no graphics, display or video libraries) instead of leaving it to the container's environment.
export const NVIDIA_DEVICE_REQUEST = { driver: 'nvidia', count: 'all', capabilities: ['gpu', 'compute', 'utility'] } as const;
// Intel/AMD: the one render node detection found, mapped at its own path (never all of /dev/dri)
export function driDevice(node: string): string {
  return `/dev/dri/${node}:/dev/dri/${node}`;
}
const DRI_DEVICE_RE = /^\/dev\/dri\/(renderD\d+):\/dev\/dri\/\1$/;
// The NVIDIA container toolkit reads these from the container's environment to pick devices and driver features;
// Harbor's renderer decides them, so a package may not set them on a service granted gpu (decision 179).
export const NVIDIA_RESERVED_ENV: readonly string[] = ['NVIDIA_VISIBLE_DEVICES', 'NVIDIA_DRIVER_CAPABILITIES', 'NVIDIA_MIG_CONFIG_DEVICES', 'NVIDIA_MIG_MONITOR_DEVICES', 'NVIDIA_IMEX_CHANNELS'];

// services the package grants gpu, sorted
export function gpuServicesOf(manifest: Manifest): string[] {
  return Object.keys(manifest.permissions ?? {})
    .filter((s) => manifest.permissions![s]!.includes('gpu'))
    .sort();
}

// What reaches DTOs and plans: never group ids
export function gpuDto(g: HostGpu): GpuDto {
  return {
    kind: g.kind,
    detail: g.detail,
    ...(g.problem ? { problem: g.problem } : {}),
    ...(g.driverVersion ? { driverVersion: g.driverVersion } : {}),
    ...(g.libraryVersion ? { libraryVersion: g.libraryVersion } : {}),
  };
}

// Decision 181: the oldest NVIDIA driver branch CUDA 12 runs on (525.60.13 on Linux). Ollama's CUDA builds, like most
// CUDA images today, are CUDA 12 or later. Below it Harbor still hands the card over (CUDA 11 images and NVENC/NVDEC
// transcoders work on 470/515/520) and adds a note: a minimum is a property of an image, not of the gpu permission.
// (web/src/app/gpu-text.ts repeats the number in its wording.)
export const NVIDIA_DRIVER_MIN_MAJOR = 525;

export const TOOLKIT_NEXT_STEP = 'Install the NVIDIA container toolkit (Operator Guide, GPU), then restart the app';
export const DOCKER_RESTART_NEXT_STEP = 'Restart Docker so it can use the NVIDIA container toolkit (sudo systemctl restart docker; this restarts every app), then restart the app';
// Decision 181: Harbor only checks the driver; installing or updating it is the operator's (and the OS's) job
export const DRIVER_INSTALL_NEXT_STEP = 'Install the NVIDIA driver (sudo ubuntu-drivers install), then restart the machine';
// the driver's files are there, its kernel module is not loaded: not rebooted since the install, or Secure Boot refuses it
export const DRIVER_LOAD_NEXT_STEP = 'Restart the machine to load it; if it still does not run, Secure Boot may be blocking it (Operator Guide, GPU → Drivers)';
export const DRIVER_REBOOT_NEXT_STEP = 'Restart the machine to finish the NVIDIA driver update';
export const DRIVER_UPDATE_NEXT_STEP = `To run them, update the NVIDIA driver to ${NVIDIA_DRIVER_MIN_MAJOR} or newer if the card supports it (sudo ubuntu-drivers install), then restart the machine`;

type GpuFacts = Pick<GpuDto, 'kind' | 'detail' | 'problem' | 'driverVersion' | 'libraryVersion'>;

// What is wrong with an NVIDIA card (Docker cannot use it yet, or, for NVIDIA_DRIVER_TOO_OLD on a usable card, what
// some apps cannot do with it), and what to do (null: nothing)
export function gpuProblemText(g: Pick<GpuDto, 'problem' | 'driverVersion' | 'libraryVersion'>): { what: string; next: string } | null {
  switch (g.problem) {
    case 'NVIDIA_TOOLKIT_MISSING':
      return { what: 'the NVIDIA container toolkit is not installed', next: TOOLKIT_NEXT_STEP };
    case 'NVIDIA_DOCKER_RESTART_NEEDED':
      return { what: 'Docker has not restarted since the NVIDIA container toolkit was installed', next: DOCKER_RESTART_NEXT_STEP };
    case 'NVIDIA_DRIVER_MISSING':
      // its userspace found (libraryVersion): installed, only not loaded
      return g.libraryVersion ? { what: 'the NVIDIA driver is installed but not running', next: DRIVER_LOAD_NEXT_STEP } : { what: 'the NVIDIA driver is not running', next: DRIVER_INSTALL_NEXT_STEP };
    case 'NVIDIA_REBOOT_NEEDED':
      return { what: `the machine has not restarted since the NVIDIA driver update${g.driverVersion && g.libraryVersion ? ` (${g.libraryVersion} installed, ${g.driverVersion} running)` : ''}`, next: DRIVER_REBOOT_NEXT_STEP };
    case 'NVIDIA_DRIVER_TOO_OLD':
      return { what: `the NVIDIA driver is older than ${NVIDIA_DRIVER_MIN_MAJOR}, so apps built on CUDA 12 or newer (like Ollama) cannot use the card`, next: DRIVER_UPDATE_NEXT_STEP };
    default:
      return null;
  }
}

// Decision 181: the NVIDIA card's name, with its running driver when the card itself works (usable, or only waiting
// for the toolkit / a Docker restart); extra goes in the same parentheses ("in use")
export function gpuCardName(g: GpuFacts, extra?: string): string {
  const named = g.kind === 'nvidia' || (g.kind === 'none' && (g.problem === 'NVIDIA_TOOLKIT_MISSING' || g.problem === 'NVIDIA_DOCKER_RESTART_NEEDED'));
  const parts = [named && g.driverVersion ? `driver ${g.driverVersion}` : '', extra ?? ''].filter(Boolean);
  return parts.length ? `${g.detail} (${parts.join(', ')})` : g.detail;
}

// one plan line per service granted gpu (a working card's line carries no driver version: the GPU fact has it; the
// reboot problem names both versions)
export function gpuChanges(manifest: Manifest, g: GpuFacts): string[] {
  const p = gpuProblemText(g);
  return gpuServicesOf(manifest).map((svc) => {
    if (g.kind === 'nvidia') return `Use the ${g.detail} (GPU) for ${svc}${p ? ` (but ${p.what}: ${p.next})` : ''}`;
    if (g.kind === 'dri') return `Use ${g.detail} for ${svc}${p ? ` (an NVIDIA card is also in this machine, but ${p.what}: ${p.next})` : ''}`;
    if (p) return `An NVIDIA graphics card is in this machine, but ${p.what}: ${svc} runs on the CPU until then (${p.next})`;
    return `No usable graphics card found: ${svc} runs on the CPU`;
  });
}

// The app page / `harbor inspect` line after "Graphics card: ". inUse with kind none: NVIDIA_REBOOT_NEEDED while the
// containers still have the NVIDIA card they were created with (it keeps working until the app is re-rendered).
export function gpuStatusLine(g: GpuDto & { inUse: boolean }): string {
  const p = gpuProblemText(g);
  if (g.kind === 'nvidia') {
    const line = g.inUse ? gpuCardName(g, 'in use') : `${gpuCardName(g)} found; restart the app to use it`;
    return p ? `${line}, but ${p.what}. ${p.next}.` : line;
  }
  if (g.kind === 'dri') {
    const line = g.inUse ? gpuCardName(g, 'in use') : `${gpuCardName(g)} found; restart the app to use it`;
    return p ? `${line}. An NVIDIA card is also in this machine, but ${p.what}. ${p.next}.` : line;
  }
  if (p && g.inUse && g.problem === 'NVIDIA_REBOOT_NEEDED') return `${g.detail} (in use), but ${p.what}. ${p.next}; until then, restarting the app moves it to the CPU.`;
  if (p) return `${gpuCardName(g)} found, but ${p.what} — runs on the CPU. ${p.next}.`;
  return 'none found — runs on the CPU';
}

type RenderedService = { deploy?: { resources?: { reservations?: { devices?: { driver?: string }[] } } }; devices?: string[]; group_add?: string[] };
const serviceOf = (model: unknown, service: string): RenderedService | undefined => (model as { services?: Record<string, RenderedService> } | null)?.services?.[service];
// the render node a rendered service maps (null: none)
const renderedNode = (def: RenderedService): string | null => {
  for (const d of def.devices ?? []) {
    const m = DRI_DEVICE_RE.exec(d);
    if (m) return m[1]!;
  }
  return null;
};

// Does a rendered Compose model (parsed runtime compose.yaml) hand a graphics card to this service?
export function rendersGpu(model: unknown, service: string): boolean {
  return renderedGpuKind(model, service) !== 'none';
}

// Which kind of graphics card a rendered model hands this service
export function renderedGpuKind(model: unknown, service: string): HostGpu['kind'] {
  const def = serviceOf(model, service);
  if (!def) return 'none';
  if (def.deploy?.resources?.reservations?.devices?.some((d) => d.driver === 'nvidia')) return 'nvidia';
  return renderedNode(def) ? 'dri' : 'none';
}

// What a rendered model already hands the first of these services, as facts that render the same again (a
// re-render with no restart keeps describing the running containers; decision 167's rule for the port binding)
export function gpuFromRendered(model: unknown, services: string[]): HostGpu {
  for (const svc of services) {
    const def = serviceOf(model, svc);
    const kind = renderedGpuKind(model, svc);
    if (!def || kind === 'none') continue;
    if (kind === 'nvidia') return { kind: 'nvidia', detail: 'NVIDIA graphics card' };
    const [render] = (def.group_add ?? []).map(Number).filter((n) => Number.isInteger(n));
    return { kind: 'dri', detail: 'graphics card', renderNode: renderedNode(def)!, ...(render !== undefined ? { renderGid: render } : {}) };
  }
  return { kind: 'none', detail: 'No graphics card found' };
}
