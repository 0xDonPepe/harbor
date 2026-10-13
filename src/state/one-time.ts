// Decision 165: result fields that must never reach the state database. The recovery words open every
// home they cover without the login password, so a stolen or copied harbor.db must not carry them.
export const ONE_TIME_RESULT_KEYS = ['recoveryKey', 'installationRecoveryKey'] as const;
export const ONE_TIME_TTL_MS = 24 * 60 * 60_000;

// Split an operation result into what may be stored and what stays in memory only.
export function splitOneTime(result: Record<string, unknown>): { stored: Record<string, unknown>; memory: Record<string, unknown> } {
  const stored: Record<string, unknown> = {};
  const memory: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) ((ONE_TIME_RESULT_KEYS as readonly string[]).includes(k) ? memory : stored)[k] = v;
  return { stored, memory };
}
