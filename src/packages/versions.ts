// Harbor release versions ("1.2.3", optional "v" prefix and "-suffix"). Pure: shared by the self-update
// check and the catalog's per-package minimum Harbor version (decision 158).

// "1.2.3" style; suffixes like "-mvp" sort before the plain version.
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('-');
  const pb = b.replace(/^v/, '').split('-');
  const na = pa[0]!.split('.').map(Number);
  const nb = pb[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if ((pa[1] ?? '') === (pb[1] ?? '')) return 0;
  if (!pa[1]) return 1;
  if (!pb[1]) return -1;
  return pa[1]! < pb[1]! ? -1 : 1;
}
