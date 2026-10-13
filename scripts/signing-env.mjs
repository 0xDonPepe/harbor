// The release signing key in the environment (decision 168): HARBOR_SIGNING_KEY (the PEM text) or
// HARBOR_SIGNING_KEY_FILE (a path). scripts/package.mjs takes both OUT of process.env before it starts any child
// process (pnpm build, tar, pnpm install --prod): none of them needs the key, and every one would inherit it.
export const SIGNING_ENV = ['HARBOR_SIGNING_KEY', 'HARBOR_SIGNING_KEY_FILE'];

// Copy the signing variables out of `env` and delete them from it. -> { HARBOR_SIGNING_KEY?, HARBOR_SIGNING_KEY_FILE? }
export function takeSigningEnv(env) {
  const taken = {};
  for (const k of SIGNING_ENV) {
    if (env[k] !== undefined) taken[k] = env[k];
    delete env[k];
  }
  return taken;
}
