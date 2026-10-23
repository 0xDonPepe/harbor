// The settle rule of `pnpm catalog:smoke` (scripts/catalog-smoke.ts), pure so it can be unit-tested.
//
// After Harbor says an app is healthy, every container must keep running and must not restart more often than it
// had at the phase's baseline. The baseline depends on the phase:
//   upgrade-install  the counts when Harbor said healthy: this is the revision boxes already run, so a first-start
//                    crash it recovers from (an app that starts before its database) must not block every update of
//                    it forever; it is reported, not failed;
//   upgrade          the counts just before the update: a container the update did not re-create keeps its count;
//   fresh            nothing: the new revision must start clean.
// Containers are matched by id, so a re-created container (new id) starts from zero.

export interface SettleContainer {
  id: string;
  service: string;
  running: boolean;
  exitCode: number;
  restarts: number;
}

export function restartBaseline(containers: SettleContainer[]): Map<string, number> {
  return new Map(containers.map((c) => [c.id, c.restarts]));
}

export function settleProblem(containers: SettleContainer[], allowed: Map<string, number>): string | null {
  for (const c of containers) {
    if (!c.running) return `${c.service} stopped (exit code ${c.exitCode})`;
    const base = allowed.get(c.id) ?? 0;
    if (c.restarts > base) return base > 0 ? `${c.service} restarted ${c.restarts - base} more time(s) after it was healthy` : `${c.service} restarted ${c.restarts} time(s)`;
  }
  return null;
}

// "web restarted 5 time(s)" for the restarts a baseline let through, or null when there were none.
export function toleratedRestarts(containers: SettleContainer[], allowed: Map<string, number>): string | null {
  const parts = containers.filter((c) => (allowed.get(c.id) ?? 0) > 0).map((c) => `${c.service} restarted ${allowed.get(c.id)} time(s)`);
  return parts.length ? parts.join(', ') : null;
}
