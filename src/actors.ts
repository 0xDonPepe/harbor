// The actor list itself lives in the contracts (src/contracts/api.ts, the console reads it too); this module keeps
// the daemon-side helpers and re-exports the list for existing importers.
import { INTERNAL_ACTORS } from './contracts/api.js';

export { INTERNAL_ACTORS };

export function isInternalActor(name: string): boolean {
  return (INTERNAL_ACTORS as readonly string[]).includes(name.toLowerCase());
}

// The refusal for a new username (setup, `harbor enroll`); null when the name is free to use.
export function reservedUsername(name: string): string | null {
  return isInternalActor(name) ? `"${name}" is a name Harbor uses for its own background work; pick another username` : null;
}
