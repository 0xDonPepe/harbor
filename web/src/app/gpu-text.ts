// Decision 179: the graphics card, in the console's plain words. Pure (no DOM, no relative imports), so unit tests
// import it directly. machine = what this machine offers (Settings → Overview); app = whether the app's containers
// have it (the app page's "Graphics card:" line); review = the install/update review.
// Decision 181: the NVIDIA driver checks (Harbor only checks; the operator installs drivers) and the running driver's
// version next to a working NVIDIA card. NVIDIA_DRIVER_TOO_OLD comes with kind nvidia: the card is used, with a note.

type Problem = 'NVIDIA_TOOLKIT_MISSING' | 'NVIDIA_DOCKER_RESTART_NEEDED' | 'NVIDIA_DRIVER_MISSING' | 'NVIDIA_REBOOT_NEEDED' | 'NVIDIA_DRIVER_TOO_OLD';
export interface GpuShape {
  kind: 'nvidia' | 'dri' | 'none';
  detail: string;
  problem?: Problem;
  driverVersion?: string;
  libraryVersion?: string;
}

export const GPU_TOOLKIT_STEP = 'Install the NVIDIA container toolkit (Operator Guide → GPU), then restart the app.';
export const GPU_DOCKER_RESTART_STEP = 'Restart Docker (sudo systemctl restart docker; this restarts every app), then restart the app.';
export const GPU_DRIVER_INSTALL_STEP = 'Install the NVIDIA driver (sudo ubuntu-drivers install), then restart the machine.';
export const GPU_DRIVER_LOAD_STEP = 'Restart the machine to load it. If it still does not run, Secure Boot may be blocking it (Operator Guide → GPU → Drivers).';
export const GPU_DRIVER_REBOOT_STEP = 'Restart the machine to finish the NVIDIA driver update.';
// 525 = NVIDIA_DRIVER_MIN_MAJOR in src/planner/gpu.ts (CUDA 12)
export const GPU_DRIVER_UPDATE_STEP = 'To run them, update the NVIDIA driver to 525 or newer if the card supports it (sudo ubuntu-drivers install), then restart the machine.';

// What keeps an NVIDIA card from apps (or, NVIDIA_DRIVER_TOO_OLD on a usable card, what some apps cannot do with it),
// and the next step (null: nothing)
export function gpuProblem(g: Pick<GpuShape, 'problem' | 'driverVersion' | 'libraryVersion'>): { what: string; step: string } | null {
  switch (g.problem) {
    case 'NVIDIA_TOOLKIT_MISSING':
      return { what: 'the NVIDIA container toolkit is not installed', step: GPU_TOOLKIT_STEP };
    case 'NVIDIA_DOCKER_RESTART_NEEDED':
      return { what: 'Docker has not restarted since the NVIDIA container toolkit was installed', step: GPU_DOCKER_RESTART_STEP };
    case 'NVIDIA_DRIVER_MISSING':
      return g.libraryVersion ? { what: 'the NVIDIA driver is installed but not running', step: GPU_DRIVER_LOAD_STEP } : { what: 'the NVIDIA driver is not running', step: GPU_DRIVER_INSTALL_STEP };
    case 'NVIDIA_REBOOT_NEEDED':
      return { what: `the machine has not restarted since the NVIDIA driver update${g.driverVersion && g.libraryVersion ? ` (${g.libraryVersion} installed, ${g.driverVersion} running)` : ''}`, step: GPU_DRIVER_REBOOT_STEP };
    case 'NVIDIA_DRIVER_TOO_OLD':
      return { what: 'the NVIDIA driver is older than 525, so apps built on CUDA 12 or newer (like Ollama) cannot use the card', step: GPU_DRIVER_UPDATE_STEP };
    default:
      return null;
  }
}

// The NVIDIA card's name with its running driver, when the card itself works (usable, or waiting only for the
// toolkit or a Docker restart); extra joins the same parentheses
function cardName(g: GpuShape, extra?: string): string {
  const named = g.kind === 'nvidia' || (g.kind === 'none' && (g.problem === 'NVIDIA_TOOLKIT_MISSING' || g.problem === 'NVIDIA_DOCKER_RESTART_NEEDED'));
  const parts = [named && g.driverVersion ? `driver ${g.driverVersion}` : '', extra ?? ''].filter(Boolean);
  return parts.length ? `${g.detail} (${parts.join(', ')})` : g.detail;
}

export function gpuMachineText(g: GpuShape): string {
  const p = gpuProblem(g);
  if (g.kind === 'nvidia') return p ? `${cardName(g)} · ${p.what} (Operator Guide → GPU)` : cardName(g);
  if (g.kind === 'dri') return p ? `${g.detail} · an NVIDIA card is also here, but ${p.what} (Operator Guide → GPU)` : g.detail;
  if (p) return `${cardName(g)} · ${p.what} (Operator Guide → GPU)`;
  return 'None found · apps run on the CPU';
}

// inUse with kind none: NVIDIA_REBOOT_NEEDED while the containers still have the NVIDIA card they were created with
export function gpuAppText(g: GpuShape & { inUse: boolean }): string {
  const p = gpuProblem(g);
  if (g.kind === 'nvidia') {
    const line = g.inUse ? cardName(g, 'in use') : `${cardName(g)} found · restart the app to use it`;
    return p ? `${line} · ${p.what}. ${p.step}` : line;
  }
  if (g.kind === 'dri') {
    const line = g.inUse ? cardName(g, 'in use') : `${cardName(g)} found · restart the app to use it`;
    return p ? `${line} · an NVIDIA card is also here, but ${p.what}. ${p.step}` : line;
  }
  if (p && g.inUse && g.problem === 'NVIDIA_REBOOT_NEEDED') return `${g.detail} (in use) · ${p.what}. ${p.step} Until then, restarting the app moves it to the CPU.`;
  if (p) return `${cardName(g)} found, but ${p.what} · runs on the CPU. ${p.step}`;
  return 'none found — runs on the CPU';
}

// The review stays short: no driver version next to a working card (the reboot problem names both versions)
export function gpuReviewText(g: GpuShape, asking = true): string {
  const p = gpuProblem(g);
  if (g.kind === 'nvidia') return p ? `This machine has an ${g.detail}: the app uses it, but ${p.what}. ${p.step}` : `This machine has an ${g.detail}: the app uses it.`;
  if (g.kind === 'dri') return p ? `This machine has ${g.detail} (the app uses it) and an NVIDIA card it cannot use yet: ${p.what}. ${p.step}` : `This machine has ${g.detail}: the app uses it.`;
  if (p) return `This machine has an ${g.detail}, but ${p.what}, so the app runs on the CPU until then. ${p.step}`;
  return `No usable graphics card found on this machine: the app runs on the CPU.${asking ? ' Allowing it now lets it use a card added later.' : ''}`;
}
