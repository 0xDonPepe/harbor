export declare const HARBOR_ROOT: string;
export declare const SIBLING_CATALOG: string;
export declare function resolveCatalogDir(explicit?: string | null): string;
export declare function catalogArg(argv: readonly string[]): { rest: string[]; dir: string };
