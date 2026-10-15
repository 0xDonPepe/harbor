// The actor names Harbor itself writes on plans and operations (background work nobody clicked). A session's actor
// is the login name, so a person must never be able to log in under one of these (decision 183: a guard's item is
// not cancellable and an auto-update's refusal rings the bell, both decided by the actor name).
export const INTERNAL_ACTORS = ['drive-guard', 'link-guard', 'lock-guard', 'scheduler', 'auto-update', 'git-source', 'tailnet-policy'] as const;

export function isInternalActor(name: string): boolean {
  return (INTERNAL_ACTORS as readonly string[]).includes(name.toLowerCase());
}

// The refusal for a new username (setup, `harbor enroll`); null when the name is free to use.
export function reservedUsername(name: string): string | null {
  return isInternalActor(name) ? `"${name}" is a name Harbor uses for its own background work; pick another username` : null;
}
