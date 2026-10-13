export declare const SIGNING_ENV: readonly string[];
export declare function takeSigningEnv(env: Record<string, string | undefined>): { HARBOR_SIGNING_KEY?: string; HARBOR_SIGNING_KEY_FILE?: string };
