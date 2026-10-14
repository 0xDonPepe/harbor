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
  return { kind: g.kind, detail: g.detail, ...(g.problem ? { problem: g.problem } : {}) };
}

export const TOOLKIT_NEXT_STEP = 'Install the NVIDIA container toolkit (Operator Guide, GPU), then restart the app';
export const DOCKER_RESTART_NEXT_STEP = 'Restart Docker so it can use the NVIDIA container toolkit (sudo systemctl restart docker; this restarts every app), then restart the app';

// What is wrong with an NVIDIA card Docker cannot use yet, and what to do (null: nothing)
export function gpuProblemText(problem: GpuDto['problem']): { what: string; next: string } | null {
  if (problem === 'NVIDIA_TOOLKIT_MISSING') return { what: 'the NVIDIA container toolkit is not installed', next: TOOLKIT_NEXT_STEP };
  if (problem === 'NVIDIA_DOCKER_RESTART_NEEDED') return { what: 'Docker has not restarted since the NVIDIA container toolkit was installed', next: DOCKER_RESTART_NEXT_STEP };
  return null;
}

// one plan line per service granted gpu
export function gpuChanges(manifest: Manifest, g: Pick<HostGpu, 'kind' | 'detail' | 'problem'>): string[] {
  const p = gpuProblemText(g.problem);
  return gpuServicesOf(manifest).map((svc) => {
    if (g.kind === 'nvidia') return `Use the ${g.detail} (GPU) for ${svc}`;
    if (g.kind === 'dri') return `Use ${g.detail} for ${svc}${p ? ` (an NVIDIA card is also in this machine, but ${p.what}: ${p.next})` : ''}`;
    if (p) return `An NVIDIA graphics card is in this machine, but ${p.what}: ${svc} runs on the CPU until then (${p.next})`;
    return `No usable graphics card found: ${svc} runs on the CPU`;
  });
}

// The app page / `harbor inspect` line after "Graphics card: "
export function gpuStatusLine(g: GpuDto & { inUse: boolean }): string {
  const p = gpuProblemText(g.problem);
  if (g.kind !== 'none') {
    const line = g.inUse ? `${g.detail} (in use)` : `${g.detail} found; restart the app to use it`;
    return p ? `${line}. An NVIDIA card is also in this machine, but ${p.what}. ${p.next}.` : line;
  }
  if (p) return `${g.detail} found, but ${p.what} — runs on the CPU. ${p.next}.`;
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
