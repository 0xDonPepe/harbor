# Signed releases and the signed catalog (decision 168, Harbor 0.32.0)

One Ed25519 key signs two things:

| What | Signature file | Signed bytes | Published by |
|---|---|---|---|
| A Harbor release | `SHA256SUMS.sig` (release asset next to `SHA256SUMS`) | the exact bytes of `SHA256SUMS` | Harbor's `release` workflow (`pnpm package --require-signature`) |
| An official app catalog | `catalog.json.sig` (release asset next to `catalog.json`) | the exact bytes of `catalog.json` | harbor-apps' `publish` job |

A `.sig` file is the base64 of the 64-byte Ed25519 signature plus a newline. `SHA256SUMS` pins the archive
by sha256, `catalog.json` pins `catalog.zip` by sha256 and size, so signing the small file covers the big one.

## Who checks what

| Where | Checks | On failure |
|---|---|---|
| `install.sh` | `SHA256SUMS.sig` with `openssl pkeyutl -verify -rawin` and the public keys embedded in the script (`HARBOR_RELEASE_KEYS`, any one may verify), before `sha256sum -c` | stops; nothing is installed |
| Self-update, console path (`POST /v1/system/update/apply`) | the newest release must be newer than the running one and list its archive, `SHA256SUMS` and `SHA256SUMS.sig`; until all three are uploaded the status says `pending` ("still being published") and no update is offered | refuses to start the update (409) |
| Self-update, root step (`harbor self-update apply`, started by `harbor-self-update@<version>.service`) | downloads `SHA256SUMS`, `SHA256SUMS.sig`, the archive; verifies the signature with the pinned keys first, then the checksum; refuses a version lower than the running one | fails; nothing is touched |
| Daemon catalog download | `catalog.json.sig` with the pinned keys, before anything in `catalog.json` is read | status error ("refusing the app catalog c…"); the box keeps its catalog |
| Daemon catalog read | the `catalog.json.sig` stored beside a downloaded catalog, again (cached by size/mtime) | that folder is not used: the seed is, until the next check downloads a signed bundle. This retires a catalog Harbor 0.31 or older downloaded unsigned |
| `pnpm package` (the seed) | `catalog.json.sig` when the release has one (always when `HARBOR_REQUIRE_SIGNED_CATALOG=1` and `--require-signature`) | the build fails |
| `pnpm catalog:fetch` (CI `official-catalog`) | the same; requires it when `HARBOR_REQUIRE_SIGNED_CATALOG=1` | the job fails |

The pinned public keys live in `src/release-keys.ts` as a list (`[{ id: 'harbor-2026-10', pem }]`); a
signature counts when any listed key verifies it. `install.sh` embeds the same PEM blocks, in the same order,
in `HARBOR_RELEASE_KEYS` and tries each (a unit test keeps the two lists equal). The shared helper is `src/signing.ts` (node:crypto only). The seed catalog inside a release tarball
needs no signature of its own: the tarball is signed.

Overrides, all root-only and typed by hand on the machine:

- `harbor self-update apply --to <v> --allow-downgrade`: install a release older than the running one.
- `harbor self-update apply --to <v> --allow-unsigned`: accept a local `--archive` (a dev build), or a GitHub
  release older than 0.32.0, WITHOUT `SHA256SUMS.sig`. A GitHub release from 0.32.0 on always needs its
  signature (CI publishes every one with it), and a signature that is there but does not verify is always refused. Inside `harbor-self-update@.service` (the unit the console starts through polkit) the CLI
  refuses both flags (`HARBOR_SELF_UPDATE_UNIT=1`), and its `ExecStart` is `apply --to %i` with nothing else.
- `HARBOR_ALLOW_UNSIGNED=1 install.sh`: only with an explicit `HARBOR_VERSION` older than 0.32.0, downloaded
  from GitHub. The installer prints a loud warning. A local `HARBOR_ARCHIVE` always needs `SHA256SUMS.sig` next to
  it; an archive you built yourself is installed with `sudo ./harbor-<v>-linux-x64/bin/harbor bootstrap --yes`.

Releases before 0.32.0 have no `SHA256SUMS.sig`. Going back to one is a downgrade anyway, so it needs both
`--allow-downgrade --allow-unsigned`; the error messages print that exact command.

## Key custody

- **Private key**: the GitHub Actions secret `HARBOR_SIGNING_KEY` in both repositories,
  carlosalaniz/harbor and carlosalaniz/harbor-apps, plus one offline copy kept by Carlos (password manager or
  an encrypted USB stick, not a synced folder). Nowhere else: never on a Harbor box, a droplet, a test fixture
  or a tracked file. A working copy for local packaging checks may sit in the git-ignored `local/` folder
  (`HARBOR_SIGNING_KEY_FILE=local/harbor-release-signing.key.pem pnpm package`).
- **Secret format**: the multi-line PEM text exactly as the key file holds it (`-----BEGIN PRIVATE KEY-----`, the
  base64 line, `-----END PRIVATE KEY-----`). Paste the file content as is. Neither repository unescapes a one-line
  form with literal `\n`: such a secret fails both publish steps loudly.
- **Where it is used**: only in the two publish steps. Harbor: the `Build release archive` step gets it as an
  env var; `pnpm package --require-signature` fails without it, or when it is not a pinned key (so CI can
  never publish a release boxes would refuse). The script reads it once and removes it from its environment
  before it runs any child process (`pnpm build`, `tar`, `pnpm install`). harbor-apps: the `Sign catalog.json` step of `publish` (no
  checkout, no install, openssl only), which also checks the result against the public key before the release
  is created.
- **Tests** generate throwaway keys per run (`tests/unit/bundle-helpers.ts`, `tests/unit/signing.test.ts`).

## Rotation (planned, no leak)

1. Make a new key pair offline (`openssl genpkey -algorithm ed25519 -out new.pem`;
   `openssl pkey -in new.pem -pubout`).
2. Ship the new PUBLIC key first: add it to `src/release-keys.ts` (second entry, new id) and, as a second PEM
   block, to `HARBOR_RELEASE_KEYS` in `install.sh` (it tries every block). Release it, still signed with the old key. Wait until
   boxes have updated (every box that updates to this release accepts both keys).
3. Switch signing: replace `HARBOR_SIGNING_KEY` in both repositories with the new private key, and the public
   key the harbor-apps `Sign catalog.json` step checks against. The next Harbor release and the next catalog
   are signed with it. (`pnpm package --require-signature` already accepts any pinned key.)
4. In a later release, drop the old key from `src/release-keys.ts` and `install.sh`. Destroy the old private key.

A box that skipped step 2's release cannot verify step 3's signatures: it must update through a release from
step 2 or later. Self-update always installs the newest release, so keep at least one release in step 2 long
enough, and say so in its release notes.

## If the private key leaks

Someone holding it can sign a Harbor release or a catalog that every box accepts, but they still need to
publish it where boxes look (the two GitHub repositories), or to get between a box and GitHub.

1. Remove `HARBOR_SIGNING_KEY` from both repositories at once and check the GitHub audit logs, release lists
   and tags of both repositories for anything you did not publish; delete such releases.
2. Make a new key pair. Release Harbor with ONLY the new public key in `src/release-keys.ts` and `install.sh`,
   signed with the new key. Boxes on the old key cannot verify that release: they must be updated by hand
   (`curl … install.sh | sudo bash` re-installs in place and keeps state; or download the archive, check it
   against the published new public key, and `sudo ./bin/harbor bootstrap --yes`). Say so loudly in the
   release notes and the README.
3. Re-publish the catalog with the new key (any commit to harbor-apps main).
4. Write a DECISIONS row: what leaked, when, what was published with it.

## Rollout order (0.32.0)

1. Add the secret `HARBOR_SIGNING_KEY` to both repositories (Settings → Secrets and variables → Actions). It must
   exist BEFORE the Harbor push: `release.yml` runs `pnpm package --require-signature`, which fails without it.
2. Merge the harbor-apps `signing` branch, so the next catalog release carries `catalog.json.sig`. Its CI fails
   without the secret, by design.
3. Release Harbor 0.32.0, the first signed release: the signing code and the `package.json` bump to 0.32.0
   go out in the SAME push, so CI publishes the first signed release from it. From that push until the release
   job has published v0.32.0 (a few minutes), `install.sh` on main finds only unsigned releases and refuses to
   install ("the newest Harbor release (0.31.x) is older than 0.32.0 … try again in a few minutes"); if the
   release job fails, fix it at once (or revert) because fresh installs stay blocked until v0.32.0 exists.
   Boxes on 0.31 and older still update to it: they do not check signatures. From 0.32.0 on, a box refuses an unsigned catalog, an unsigned release and a downgrade.
   (A 0.32.0 box whose newest catalog release is unsigned keeps the catalog it has and reports why: step 2
   must come first.)
4. Later, once every catalog release in use is signed, set `HARBOR_REQUIRE_SIGNED_CATALOG=1` in Harbor CI
   (`release.yml` `Build release archive` env and the `official-catalog` job), so a release build never ships
   an unsigned seed.
