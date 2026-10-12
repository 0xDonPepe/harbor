// Where the app catalog checkout lives (decision 158). The official packages moved out of this repo to
// carlosalaniz/harbor-apps; editorial scripts take its apps/ folder explicitly. Resolution order:
//   1. the explicit argument (--catalog <dir>, or the script's positional dir)
//   2. HARBOR_CATALOG_DIR
//   3. ../harbor-apps/apps beside this checkout, when it exists
// Relative paths resolve against the directory the command was typed in (pnpm sets INIT_CWD).
import { existsSync } from 'node:fs';
import path from 'node:path';

export const HARBOR_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const SIBLING_CATALOG = path.resolve(HARBOR_ROOT, '..', 'harbor-apps', 'apps');

export function resolveCatalogDir(explicit) {
  const base = process.env.INIT_CWD ?? process.cwd();
  const env = process.env.HARBOR_CATALOG_DIR;
  const dir = explicit ? path.resolve(base, explicit) : env ? path.resolve(base, env) : existsSync(SIBLING_CATALOG) ? SIBLING_CATALOG : null;
  if (!dir) {
    throw new Error(
      `no app catalog checkout: pass --catalog <dir>, set HARBOR_CATALOG_DIR, or clone carlosalaniz/harbor-apps to ${path.dirname(SIBLING_CATALOG)} ` +
        "(Harbor's own frozen test copies are in tests/fixtures/catalog)",
    );
  }
  if (!existsSync(path.join(dir, 'index.json'))) throw new Error(`${dir} is not an app catalog (no index.json)`);
  return dir;
}

// Take `--catalog <dir>` out of an argument list: the remaining arguments and the resolved catalog dir.
export function catalogArg(argv) {
  const rest = [...argv];
  const i = rest.indexOf('--catalog');
  let explicit = null;
  if (i >= 0) {
    explicit = rest[i + 1];
    if (!explicit || explicit.startsWith('--')) throw new Error('--catalog needs a directory');
    rest.splice(i, 2);
  }
  return { rest, dir: resolveCatalogDir(explicit) };
}
