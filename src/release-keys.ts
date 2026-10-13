// The public keys Harbor trusts for its own releases (SHA256SUMS.sig) and for the official app catalog
// (catalog.json.sig) (decision 168; custody, rotation and leaks: docs/design/SIGNING.md).
// A list so a rotation can ship the next key in a release BEFORE anything is signed with it: boxes on that
// release then accept both, signing switches, and a later release drops the old key.
// install.sh embeds the same PEM (tests/unit/signing.test.ts keeps them equal).
export interface ReleaseKey {
  id: string;
  pem: string;
}

export const RELEASE_KEYS: readonly ReleaseKey[] = [
  {
    id: 'harbor-2026-10',
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAm1Nz4bx1UpDvo+pvgAweZveNPi8c9dH2ze/kPaLPtXA=
-----END PUBLIC KEY-----
`,
  },
];
