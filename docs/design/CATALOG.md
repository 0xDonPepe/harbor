# Design addendum: the one-click catalog and "bring your own folder"

**Status:** approved direction (Carlos, 2026-09-14): a catalog of apps that are easy to install
(Open WebUI, Nextcloud with office, an OpenClaw-class agent, Immich, Jellyfin, plus useful Umbrel
staples), with configurable external storage for the apps where that is the biggest pain.
North star: *a self-hosted cloud for humans.*

## 1. What a package must be

Every package is the same four files plus optional assets, checked the same way (docs/design and
TDD section 4): `manifest.yaml`, `compose.yaml` in the supported subset (image by digest,
environment, depends_on, healthcheck, named volumes only), `README.md`, `release.json` with file and
asset hashes, per-image index digest and linux/amd64 platform digest, and a qualification record.
There is still no per-app code path in the engine: a package is data.

Selection rules for this catalog round:

1. Fits the Compose subset (`command` is allowed since decision 123) without `cap_add`, `devices`, `privileged`, host networking or
   extra ports. Apps that need them are listed in section 5 instead of being bent into shape.
2. First run finishes in the browser (its own account setup or no accounts at all). Apps whose only
   admin-creation path is a CLI command or a password in an environment variable are excluded for now
   (Harbor would either print a secret or hide it; both are wrong for a one-click flow).
3. No telemetry by default where the app offers a switch.
4. A health path that answers HTTP before any account exists.

## 2. Packages (revision 1)

| Package | Services | Category | External storage | First run |
|---|---|---|---|---|
| open-webui | Open WebUI + Ollama | ai | `models` (optional) | first account is admin; pull a model |
| anythingllm | AnythingLLM | ai | – | onboarding wizard (provider, workspace) |
| jellyfin | Jellyfin | media | `media` (optional) | setup wizard |
| immich | server, machine-learning, PostgreSQL (VectorChord), Valkey | media | `library` (optional) | admin account; mobile app |
| nextcloud | Nextcloud (Apache), PostgreSQL 17, Redis | files | `data` (optional) | admin account; recommended apps include Nextcloud Office (built-in CODE) |
| vaultwarden | Vaultwarden | security | – | create account; sign-ups open until turned off |
| uptime-kuma | Uptime Kuma | network | – | admin account |
| forgejo | Forgejo (SQLite, SSH off) | developer | – | installer pre-filled; admin section |
| freshrss | FreshRSS | productivity | – | installer (SQLite) |
| actual | Actual Budget server | finance | – | set server password |
| audiobookshelf | Audiobookshelf | media | `audiobooks`, `podcasts` (optional) | root account |
| navidrome | Navidrome | media | `music` (optional, read-only) | admin account |
| memos | Memos | productivity | – | first account is host |
| mealie | Mealie | home | – | default account, change it |

Plus the three MVP packages (Excalidraw, BentoPDF, n8n). Images were pinned on 2026-09-14 with
`scripts/catalog-pin.mjs` (registry API, no Docker daemon); each `release.json` records the tag that
was resolved, the index digest used in `compose.yaml`, the linux/amd64 platform digest, the image
creation time and the image config facts (exposed ports, declared volumes, user).

## 3. "Bring your own folder" (external storage)

The biggest pain with Immich, Nextcloud, Jellyfin and friends is where the big data lives. Harbor
keeps managed Docker volumes as the default and adds one optional choice per storage claim:

```yaml
storage:
  - id: library
    composeVolume: library
    purpose: Photos and videos
    retention: retain
    external: {hint: "Pick a folder with plenty of room, for example /mnt/photos", required: false, readOnly: false}
```

- The install request may carry `storage: {library: {hostPath: "/mnt/photos"}}` (CLI:
  `harbor install immich --storage library=/mnt/photos`; console: a per-claim choice in the install
  page). Only claims marked `external` accept a folder; `required: true` forces a choice.
- Plan time validation (before anything reaches Docker): absolute, normalized, no `..`, not the root,
  not under a denylist (`/etc /usr /proc /sys /dev /boot /run /root /var/lib/docker /var/lib/harbor`
  and the like, also after resolving symlinks), must exist and be a directory, must not overlap a
  folder another instance already uses (equal, parent or child), nor another claim of the same plan.
  The plan says `Use your folder /mnt/photos for Photos and videos; Harbor never deletes it`.
- Rendering: the service volume entry becomes a bind mount with `create_host_path: false` (and
  `read_only` when the claim says so); no Docker volume is created or declared for that claim.
- Records: a `bind` resource (`name` = the folder, `metadata.storageId`, `metadata.readOnly`,
  `metadata.driveId`) next to the `volume` resources. `inspect` lists it with `present` = folder exists. Schema v3 widens the
  `resources.kind` CHECK; the migration rebuilds the table in place.
- Claiming a folder stamps an app-generated `driveId` into its `.harbor-bind.json` marker
  (random at install, kept on restore, fresh on replacement — never a hardware UUID; see
  decisions 89–90). Reinstall and start verify folder + marker; a missing, foreign or swapped
  folder fails with `DATA_MISSING` and a next action. The observer stops the app through the
  queue when its drive leaves (`needsDrive` on the summary, Start refused), auto-mounts fresh
  inserts and auto-starts recovered apps (both policy-gated), and `adopt-drive` accepts a
  replacement folder. Nothing ever starts against the wrong folder.
- Remove leaves the folder untouched and says so in the events. Harbor never chowns or deletes an
  external folder; it creates one only when the operator names it in the folder picker, inside a parent
  the service account may already write to (the Harbor data folder `/srv/harbor` by default). Permissions are the app's business: the packaged images run as root
  (Immich, Jellyfin, Audiobookshelf, Navidrome) or take ownership on first start (Nextcloud), which
  is why the hint for Nextcloud says so.

## 4. Configuration binding formats

Apps want different shapes of "their own address". `configuration[].format` selects the part of the
endpoint's primary URL a variable receives, and it is re-rendered when the primary address changes:

| format | value for `https://cloud.example.com:8443/` |
|---|---|
| `url` (default) | `https://cloud.example.com:8443/` |
| `origin` | `https://cloud.example.com:8443` |
| `authority` | `cloud.example.com:8443` |
| `host` | `cloud.example.com` |
| `scheme` | `https` |

Nextcloud revision 1 used `authority` (`NEXTCLOUD_TRUSTED_DOMAINS`, `OVERWRITEHOST`), `scheme`
(`OVERWRITEPROTOCOL`) and `origin` (`OVERWRITECLIURL`); revision 2 drops them for an `afterStart`
hook that hands it every address at once (decision 116). Forgejo uses `url` and `host`; Vaultwarden,
Mealie, Open WebUI and Jellyfin use `origin`. Environment variable names may now be mixed case
(`JELLYFIN_PublishedServerUrl`, `FORGEJO__server__ROOT_URL`), which the previous upper-case-only
pattern forbade.

## 5. Deliberately not in this round

| App | Why not yet | What would unlock it |
|---|---|---|
| OpenClaw | its Compose file needs `command`, `init`, `cap_drop`, `security_opt`, `extra_hosts`; first run is a CLI onboarding that writes the gateway token | a small, reviewed subset extension (`command`, `init`, `cap_drop`) plus a "secret shown once" affordance for the gateway token; AnythingLLM and Open WebUI cover the assistant/agent need meanwhile |
| Paperless-ngx, Linkding | admin account only via CLI or `*_ADMIN_PASSWORD` env | a one-time credential display for install (the exposure flow already has the pattern) |
| Collabora as a separate server | needs different `ssl.termination` for loopback vs published; WOPI setup is an in-app step | scheme-dependent configuration; Nextcloud Office works today through the recommended apps' built-in CODE server |
| Home Assistant, Pi-hole, Syncthing, AdGuard | host networking, DNS port 53, non-HTTP ports | not in the HTTP-endpoint model of this release |
| Bitcoin/Lightning stack | not in the "cloud for humans" scope | – |

## 6. Porting Umbrel's official catalog

Umbrel packages are `umbrel-app.yml` + a Compose file that relies on `app_proxy`, `APP_DATA_DIR`
bind mounts, `${APP_*}` interpolation and often host features. About a third of its ~300 apps fit
Harbor's subset as-is; the rest need one or more of the exclusions above. A converter would be a
translation of the manifest (name, tagline, category, icon, gallery, developer, website) plus a
Compose rewrite (bind mounts → storage claims, `APP_DATA_DIR` → managed volumes, `app_proxy` →
endpoint). This round ports fourteen apps by hand with Harbor semantics (digest pinning, storage
claims, configuration formats, qualification). The converter is listed in docs/FUTURE.md; each
converted app still needs a live qualification, which is the real cost.

## 7. Qualification

`scripts/vm/qualify-catalog.mjs [--fresh] [--only a,b]` installs every package on the designated
droplet, waits for readiness, opens the UI in headless Chromium (title + screenshot + health probe),
inspects mounts and resources, removes the instance, and repeats once with host folders for every
package that has external claims. Results land in `docs/evidence/catalog-<timestamp>/` and in each
package's `release.json` qualification (`passed` or `blocked` with the reason).
Since 0.28.0 (§9) the packages live in harbor-apps: pass `--catalog <dir>` (default `../harbor-apps/apps`)
and the results are written into that checkout. The script refuses to record anything when the box's
`harbor catalog` revisions differ from the checkout's, so build the archive from a bundle of the same
checkout (`HARBOR_CATALOG_BUNDLE=<dir> pnpm package`) or narrow the run with `--only`. Right after
bootstrap, both the qualification and the VM suite (`run-vm-tests.mjs`, A01) pin the box to the archive's
seed: `catalog: {url: null}` in `/etc/harbor/harbor.json` (root:harbor 0640), `/var/lib/harbor/catalog`
removed, harbor restarted. They then assert `harbor catalog status` reports origin `bundled` with the
seed's serial: in A02 before the tamper steps, and in qualification again just before results are
recorded (a mismatch records nothing). Without that pin a downloaded catalog could take over mid-run.

## 6. Your own apps and updates (added 2026-09-15, v0.6.0)

Two package roots behind one `PackageStore`: the official catalog (hash-verified; shipped with Harbor, and since 0.28.0 also downloaded, §9)
and `localPackagesDir` for packages the operator uploads as a zip. Uploads are validated exactly like
bundled packages; Harbor writes `release.json` itself and pins tag images by digest through the registry
API at upload (decision 61). The console shows them with a *Your app* badge and a *Your apps* filter.

Updates (decision 62): a `PackageStore` revision higher than an instance's revision is an available
update, offered on Home, in the drawer and by `harbor list`/`harbor update`. The `update` plan keeps the
instance identity and swaps the release; the runner keeps `release-previous/` and rolls back automatically
when the new release does not start or answer. Developer guide: docs/DEVELOPER_PACKAGES.md.

## 8. Operator-provided secrets and app links (added 2026-10-05, v0.21.0, decisions 125–126)

- **`secrets[].source: operator`**: the value comes from the operator, not from Harbor's generator.
  Plan rows carry only `{id, source, prompt, optional, minLength, maxLength, ask}`; the value travels
  with `POST /v1/operations` (`secrets: {id: value}`), is checked before the operation exists, held in
  memory keyed by plan id and taken by the runner first thing (the install-location passphrase pattern).
  Storage, binding, retention and redaction are those of generated secrets. `configure` plans replace
  values later.
- **`links[]`**: per-link Docker network `<consumer project>_link_<id>`, created by the runner
  (`internal`, Harbor labels incl. `link` and `provider`, ownership checked before use and removal),
  declared `external` in both rendered Compose files. Joined by the consumer's bound services and the
  provider's endpoint service (alias `<id>-link`) only. The consumer's variables get
  `http://<id>-link:<containerPort>` (`url`/`authority`/`host`/`port`). Relation state in the `links`
  table (schema v9): `active`, `needs_provider` (provider removed or never chosen), `dormant` (consumer
  removed; Reinstall revives). Render paths re-create a missing network; after every `up`/`start` the
  other side is re-attached live.
- Not in this round: links to platform tools, several providers per link, cross-machine links, and
  automatic restarts of a consumer when a provider's container port changes (an event says to Restart).

## 9. The catalog moves to harbor-apps and updates itself (added 2026-10-11, v0.28.0, decision 158)

**Where it lives.** carlosalaniz/harbor-apps: `apps/index.json` + `apps/<id>/`, same package format.
Harbor keeps only frozen copies of 9 apps in `tests/fixtures/catalog` for its own tests, e2e and
`pnpm dev`; `targets/` (backup place packages) stays in Harbor. Editorial scripts resolve the catalog as
`--catalog <dir>` (or a positional dir), then `HARBOR_CATALOG_DIR`, then `../harbor-apps/apps`.

**What is published.** One GitHub release `c<serial>` per change on harbor-apps `main`, three assets:

| File | Content |
|---|---|
| `catalog.zip` | `index.json` at the root + per app only `manifest.yaml`, `compose.yaml`, `README.md`, `release.json` and the assets its manifest names; sorted, deterministic; ≤ 96 MiB, ≤ 4096 entries |
| `catalog.json` | `{schemaVersion: 1, serial, commit, createdAt, zip: {sha256, bytes}, packages}`, ≤ 64 KiB — the only signed bytes |
| `catalog.json.sig` | base64 ed25519 signature over the exact `catalog.json` bytes |

`serial` = the commit's committer time (unix seconds). The workflow refuses a committer time more than
5 minutes in the future, skips a re-run of a commit that is already released, fails a different commit
with the same serial as an existing release, and for a serial not newer than the latest release skips
when `main` has moved on (the newer commit publishes) and fails otherwise (clock skew).

**CI layout.** Four jobs, so the signing key never shares a runner with third-party code. *verify*
(every push and PR) and *bundle* (main only, read-only token, no secret) run Harbor's tools at
`.harbor-ref`, which must be a full commit sha on Harbor's `main`. *sign* runs in the `catalog-signing`
GitHub Environment (main only): it checks out only harbor-apps, installs nothing, re-checks the bundle
artifact (`scripts/check-bundle.mjs`: commit, serial, zip sha256 and size) and runs `scripts/sign.mjs`,
with the secret on that one step. *publish* is the only job with `contents: write`, and its token is
only on the steps that call `gh`.

**Trust.** The public key (SPKI DER, base64) is pinned in `src/packages/catalog-bundle.ts`
(`OFFICIAL_CATALOG_PUBLIC_KEY`) and in `keys/harbor-apps.pub`. The private key exists only as the
`CATALOG_SIGNING_KEY` secret of the harbor-apps `catalog-signing` Environment plus an offline backup; `scripts/sign.mjs` verifies its
own signature against the pinned key before anything is released. A box accepts a bundle only if the
signature verifies against a configured key, the serial is strictly higher than the active one (no
rollback, no replay) and at most 24 h ahead of the box's clock ("the app catalog is dated in the
future" otherwise: a far-future serial would block every honest bundle until then), the zip matches
the signed sha256 and size, and the index validates with every listed folder present.

**On the box.**

- Seed: `config.catalogDir` (`/opt/harbor/catalog`), extracted from the signed bundle by `pnpm package`
  (which resolves `releases/latest` to its `c<serial>` tag once, fetches all three files from
  `releases/download/c<serial>/`, requires the signed serial to match the tag, and fails rather than ship
  an empty or unverified catalog), with `catalog.json` + `.sig` kept
  verbatim. Without a `catalog.json` (dev, tests) the seed is serial 0. Read once at start.
- Downloads: `<stateDir>/catalog/<serial>/` (same layout) and `<stateDir>/catalog/current.json`
  (`{"serial": N}`, written via rename). Every catalog read picks the downloaded folder only when the
  pointer parses, its `index.json` exists, its serial beats the seed's, and its stored `catalog.json`
  still verifies against the keys configured **now** and names that folder's serial; otherwise the seed
  (logged once as "not trusted"). The check is cached by serial + size/mtime of `catalog.json` and its
  signature, so reads stay cheap. A key rotation therefore retires every folder the old key signed, and
  the next bundle is compared with the seed, not with the folder that lost its trust. A Harbor upgrade
  with a newer seed takes over by itself.
- Check: a minute after start, then every 6 h, or on demand (`POST /v1/catalog/refresh`,
  `harbor catalog refresh`, Store → *Check for new apps*; single-flight). Fetch `catalog.json` and the
  signature first (30 s each), stop if the serial is not newer, then `catalog.zip` (capped at the signed
  size, 5 min), extract to `.partial-<serial>` with a path check, validate, rename, write the pointer,
  prune all but the new folder and the one it replaced. The whole check has one deadline of 240 s (each
  step gets at most what is left), below the CLI's 300 s wait for the response. A signature or checksum
  mismatch (or a zip over its signed size) is what a release published between the fetches from
  `releases/latest` looks like, so such a check starts over once. Any failure leaves the active catalog
  as it was and is reported in `GET /v1/catalog/status` (`error`; `checkedAt` lives in memory only).
  The Store's catalog line shows a stored failure on load ("Last check failed: …", role=status) and
  "· checked <relative time>", so a stuck automatic check is never silent.
- Refresh is a direct route, not a plan: it never touches Docker. Installed apps see a higher revision
  on the next observer tick as an ordinary update — the notification, or an automatic `update` plan for
  instances with auto-update on. A plan made before a swap still pins its revision and hashes: if the
  runner finds them changed when it starts (before anything is written), the operation fails
  `PLAN_STALE` ("Review the plan again"), the app keeps its install state and readiness, no
  notification is sent, and a stale install leaves no instance row or port claim behind.
- Config: `catalog: {url, publicKeys}` (1–8 keys). Default url
  `https://github.com/carlosalaniz/harbor-apps/releases/latest/download`; https only (http just for
  loopback); `url: null` means no timer and no fetch (dev, tests, openapi generation).

**minHarbor.** Optional `"minHarbor": "x.y.z"` on an index entry. A Harbor older than that lists the app
as unavailable ("needs Harbor x.y.z or newer"), install fails with INVALID_STATE and the next action
"Update Harbor …", restore from a backup says the same (not "no package"), and the app offers no
update. Presentation assets (`/v1/catalog/<id>/asset/<name>`) skip the gate, and fall back to an
installed copy's release snapshot when the current revision cannot be read, so installed apps keep
their icon. Since decision 159 it is computed, not typed: see §10.

**Id clashes.** An id the operator uploaded keeps winning after the official catalog adds the same id
(the official duplicate is hidden and offers no update); removing the upload hands the id back. A new
upload of an official id is still refused.

**Bootstrap order.** harbor-apps CI runs Harbor's tools at `.harbor-ref` (a commit on Harbor's `main`);
Harbor's release job needs a published harbor-apps release. First publish: push Harbor to `main` (its
release job and its `official-catalog` CI job fail: no catalog yet) → write that commit's sha into `.harbor-ref` → push harbor-apps (first
`c<serial>`) → re-run Harbor's release job. Later Harbor changes reach the catalog tooling only through a
reviewed `.harbor-ref` bump.

**Not done yet** (docs/TODO.md): a key rotation procedure, the daemon downloading by tag instead of
`releases/latest` (`pnpm package` already pins the tag; today a check that reads two releases starts over once), persisting `checkedAt`,
and a review policy for community submissions.

## 10. Compatibility: the format only grows (added 2026-10-11, v0.28.0, decision 159)

Published apps are read by Harbors of every age, and a new Harbor reads apps written for old ones.
Neither direction may break.

**The rule.** The package format only grows: never remove, rename or narrow a field or value an
official package may use. New fields and values are optional and get an entry in
`src/packages/features.ts`. A breaking change needs a migration in the engine: Harbor adapts old
packages (as Umbrel does), packages are never rewritten for it.

**Automatic minHarbor (old Harbor, new app).** `features.ts` (pure) maps field paths and enum/const
values to the Harbor that first accepts them:

| Key | Meaning |
|---|---|
| `compose.services.*.command` | a field (`*` = a key the author chooses, `[]` = an array item) |
| `manifest.endpoints.*.kind=api` | one enum/const value of a field |
| `path` + `when(value)` | an existing field whose pattern or limit was widened |

Everything up to 0.28.0 is `BASELINE` (no requirement: older Harbors never fetch the signed catalog);
`FEATURES` holds later additions with `since`. `requiredHarbor(manifest, compose)` = the highest `since`
over what a package uses. `pnpm catalog:bundle` re-writes the bundled index.json with each entry's
`minHarbor` = max(declared, computed) (sorted, deterministic; no longer the checkout's bytes), so authors
normally never set it. `pnpm catalog:verify` prints `minHarbor declared=… computed=…` per app and fails
when a declared value is lower than computed. The daemon checks the index `minHarbor` before parsing
the package files (§9). Uploads and git sources are not gated: the running Harbor validates them itself.
Not expressible as a path: a relaxed cross-field rule in `validateManifestReferences` — set `minHarbor`
by hand on the index entry.

**The guard.** `tests/unit/package-features.test.ts` walks `MANIFEST_SCHEMA` and
`COMPOSE_SOURCE_SCHEMA`: a path or value that is neither baseline nor in `FEATURES` fails ("add it with
the next version"), and so does a baseline or recorded one that disappeared ("the format only grows").

**Strict validation stays.** Umbrel ignores unknown manifest keys; Harbor refuses them. An unknown
Compose key is a security boundary (an old engine that silently dropped one could run something other
than what was reviewed), so old boxes get the explicit `minHarbor` gate instead of leniency.

**New Harbor, live catalog.** Harbor CI job `official-catalog` (separate from `verify`, so it never
changes that job's result) runs `pnpm catalog:fetch --out <dir>` (`scripts/catalog-fetch.mjs`, the same
tag-resolving, signature-verifying download `pnpm package` uses) and then `pnpm catalog:verify <dir>`
with the commit's code. An engine change that would break a published app fails at push/PR time, not
first at release. With no catalog release yet (bootstrap only) the fetch fails with "is there a
published catalog release on carlosalaniz/harbor-apps?".

**Why.** Umbrel's `manifestVersion` is the minimum OS, set by hand, and Umbrel only started enforcing it
on app updates in Aug 2026 (umbrel commit 36fa892d5e); StartOS stamps the minimum OS at pack time.
Harbor takes StartOS's stamping and Umbrel's grow-only format.
