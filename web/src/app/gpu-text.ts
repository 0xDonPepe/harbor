// Decision 179: the graphics card, in the console's plain words. Pure (no DOM, no relative imports), so unit tests
// import it directly. machine = what this machine offers (Settings → Overview); app = whether the app's containers
// have it (the app page's "Graphics card:" line); review = the install/update review.

type Problem = 'NVIDIA_TOOLKIT_MISSING' | 'NVIDIA_DOCKER_RESTART_NEEDED';
export interface GpuShape {
  kind: 'nvidia' | 'dri' | 'none';
  detail: string;
  problem?: Problem;
}

export const GPU_TOOLKIT_STEP = 'Install the NVIDIA container toolkit (Operator Guide → GPU), then restart the app.';
export const GPU_DOCKER_RESTART_STEP = 'Restart Docker (sudo systemctl restart docker; this restarts every app), then restart the app.';

// What keeps an NVIDIA card from apps, and the next step (null: nothing)
export function gpuProblem(problem: Problem | undefined): { what: string; step: string } | null {
  if (problem === 'NVIDIA_TOOLKIT_MISSING') return { what: 'the NVIDIA container toolkit is not installed', step: GPU_TOOLKIT_STEP };
  if (problem === 'NVIDIA_DOCKER_RESTART_NEEDED') return { what: 'Docker has not restarted since the NVIDIA container toolkit was installed', step: GPU_DOCKER_RESTART_STEP };
  return null;
}

export function gpuMachineText(g: GpuShape): string {
  const p = gpuProblem(g.problem);
  if (g.kind === 'nvidia') return g.detail;
  if (g.kind === 'dri') return p ? `${g.detail} · an NVIDIA card is also here, but ${p.what} (Operator Guide → GPU)` : g.detail;
  if (p) return `${g.detail} · ${p.what} (Operator Guide → GPU)`;
  return 'None found · apps run on the CPU';
}

export function gpuAppText(g: GpuShape & { inUse: boolean }): string {
  const p = gpuProblem(g.problem);
  if (g.kind !== 'none') {
    const line = g.inUse ? `${g.detail} (in use)` : `${g.detail} found · restart the app to use it`;
    return p ? `${line} · an NVIDIA card is also here, but ${p.what}. ${p.step}` : line;
  }
  if (p) return `${g.detail} found, but ${p.what} · runs on the CPU. ${p.step}`;
  return 'none found — runs on the CPU';
}

export function gpuReviewText(g: GpuShape, asking = true): string {
  const p = gpuProblem(g.problem);
  if (g.kind === 'nvidia') return `This machine has an ${g.detail}: the app uses it.`;
  if (g.kind === 'dri') return p ? `This machine has ${g.detail} (the app uses it) and an NVIDIA card it cannot use yet: ${p.what}. ${p.step}` : `This machine has ${g.detail}: the app uses it.`;
  if (p) return `This machine has an ${g.detail}, but ${p.what}, so the app runs on the CPU until then. ${p.step}`;
  return `No usable graphics card found on this machine: the app runs on the CPU.${asking ? ' Allowing it now lets it use a card added later.' : ''}`;
}
