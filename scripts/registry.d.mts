// Types for scripts/registry.mjs (read-only OCI registry helper), for the TypeScript scripts that use it.
export declare function parseRef(ref: string): { registry: string; repo: string; tag: string | null; digest: string | null };
export declare function listTags(ref: string): Promise<string[]>;
export declare function resolve(
  ref: string,
  platform?: { os: string; architecture: string },
): Promise<{
  repository: string;
  tag: string | null;
  indexDigest: string;
  platformDigest: string;
  isIndex: boolean;
  platform: string;
  config: { Volumes: Record<string, unknown> | null; ExposedPorts: Record<string, unknown> | null; User: string; Labels: Record<string, string> | null; Healthcheck: unknown; created?: string } | null;
}>;
