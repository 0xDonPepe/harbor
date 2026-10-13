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
| `install.sh` | `SHA256SUMS.sig` with `openssl pkeyutl -verify -rawin` and the public key embedded in the script, before `sha256sum -c` | stops; nothing is installed |
| Self-update, console path (`POST /v1/system/update/apply`) | the newest release must be newer than the running one and list `SHA256SUMS.sig` | refuses to start the update (409) |
| Self-update, root step (`harbor self-update apply`, started by `harbor-self-update@<version>.service`) | downloads `SHA256SUMS`, `SHA256SUMS.sig`, the archive; verifies the signature with the pinned keys first, then the checksum; refuses a version lower than the running one | fails; nothing is touched |
| Daemon catalog download | `catalog.json.sig` with the pinned keys, before anything in `catalog.json` is read | status error ("refusing the app catalog c…"); the box keeps its catalog |
| `pnpm package` (the seed) | `catalog.json.sig` when the release has one (always when `HARBOR_REQUIRE_SIGNED_CATALOG=1` and `--require-signature`) | the build fails |
| `pnpm catalog:fetch` (CI `official-catalog`) | the same; requires it when `HARBOR_REQUIRE_SIGNED_CATALOG=1` | the job fails |

The pinned public keys live in `src/release-keys.ts` as a list (`[{ id: 'harbor-2026-10', pem }]`); a
signature counts when any listed key verifies it. `install.sh` embeds the same PEM (a unit test keeps them
equal). The shared helper is `src/signing.ts` (node:crypto only). The seed catalog inside a release tarball
needs no signature of its own: the tarball is signed.

Overrides, all root-only and typed by hand on the machine:

- `harbor self-update apply --to <v> --allow-downgrade`: install a release older than the running one.
- `harbor self-update apply --to <v> --allow-unsigned`: accept a release or `--archive` WITHOUT `SHA256SUMS.sig`
  (a local dev archive, or a release older than 0.32.0). A signature that is there but does not verify is
  always refused. Inside `harbor-self-update@.service` (the unit the console starts through polkit) the CLI
  refuses both flags (`HARBOR_SELF_UPDATE_UNIT=1`), and its `ExecStart` is `apply --to %i` with nothing else.
- `HARBOR_ALLOW_UNSIGNED=1 install.sh`: only with an explicit `HARBOR_VERSION` older than 0.32.0, or a local
  `HARBOR_ARCHIVE`. The installer prints a loud warning.

Releases before 0.32.0 have no `SHA256SUMS.sig`. Going back to one is a downgrade anyway, so it needs both
`--allow-downgrade --allow-unsigned`; the error messages print that exact command.

## Key custody

- **Private key**: the GitHub Actions secret `HARBOR_SIGNING_KEY` (the PEM text) in both repositories,
  carlosalaniz/harbor and carlosalaniz/harbor-apps, plus one offline copy kept by Carlos (password manager or
  an encrypted USB stick, not a synced folder). Nowhere else: never on a Harbor box, a droplet, a test fixture
  or a tracked file. A working copy for local packaging checks may sit in the git-ignored `local/` folder
  (`HARBOR_SIGNING_KEY_FILE=local/harbor-release-signing.key.pem pnpm package`).
- **Where it is used**: only in the two publish steps. Harbor: the `Build release archive` step gets it as an
  env var; `pnpm package --require-signature` fails without it, or when it is not a pinned key (so CI can
  never publish a release boxes would refuse). harbor-apps: the `Sign catalog.json` step of `publish` (no
  checkout, no install, openssl only), which also checks the result against the public key before the release
  is created.
- **Tests** generate throwaway keys per run (`tests/unit/bundle-helpers.ts`, `tests/unit/signing.test.ts`).

## Rotation (planned, no leak)

1. Make a new key pair offline (`openssl genpkey -algorithm ed25519 -out new.pem`;
   `openssl pkey -in new.pem -pubout`).
2. Ship the new PUBLIC key first: add it to `src/release-keys.ts` (second entry, new id) and to `install.sh`
   (the installer can carry both: verify with either). Release it, still signed with the old key. Wait until
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

1. Add the secret `HARBOR_SIGNING_KEY` to both repositories (Settings → Secrets and variables → Actions).
2. Merge the harbor-apps `signing` branch, so the next catalog release carries `catalog.json.sig`. Its CI fails
   without the secret, by design.
3. Release Harbor 0.32.0, the first signed release. Boxes on 0.31 and older still update to it: they do not
   check signatures. From 0.32.0 on, a box refuses an unsigned catalog, an unsigned release and a downgrade.
   (A 0.32.0 box whose newest catalog release is unsigned keeps the catalog it has and reports why: step 2
   must come first.)
4. Later, once every catalog release in use is signed, set `HARBOR_REQUIRE_SIGNED_CATALOG=1` in Harbor CI
   (`release.yml` `Build release archive` env and the `official-catalog` job), so a release build never ships
   an unsigned seed.
