# Build your own app for Harbor

Harbor installs *packages*: a zip with a manifest, a Compose file and a few optional files. Anyone can
build one and upload it from the console (**App Store → + Your own app**) or the CLI
(`harbor packages add my-app.zip`). Harbor checks the package the same way it checks the built-in
catalog, pins the images by digest for you, and puts it in *your* App Store. Upload a higher
`release.revision` later and Harbor offers an **Update** to every app installed from it.

Developing in a repository? Point Harbor at it instead (**App Store → + Your own app → Git
repository**, or `harbor sources add https://github.com/you/your-app`): Harbor fetches the branch,
imports the `harbor/` folder below, and every new commit becomes an update — deployed automatically
if you turn on *redeploy on commit*. See §7.

## 1. The zip

```
my-app/
  manifest.yaml     required
  compose.yaml      required
  README.md         optional (Harbor writes a short one if missing)
  icon.svg          optional, named in manifest presentation.icon (svg/png, ≤ 256 KiB)
  shot-1.png        optional screenshots, named in presentation.gallery (≤ 1 MiB each)
```

`zip -r my-app.zip my-app/` is fine (the top folder is stripped). Limits: 50 MB zip, 256 files.

## 2. manifest.yaml (template)

```yaml
apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: my-app                     # lowercase letters, digits, dashes; must not collide with a built-in app
  name: My App
  description: One sentence about what it does
release:
  revision: "1"                  # raise it (2, 3, …) for every new upload; this is what triggers updates
  version: "1.0.0"               # the app's own version, shown to people
  # minHarbor: "0.28.2"          # optional: the oldest Harbor release this revision runs on (§10)
deployment:
  compose: compose.yaml
  multiInstance: true            # false if only one copy may run
  services:
    web: application             # every compose service, marked application or infrastructure
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary     # secure if the app is better on HTTPS (clipboard, camera, PWA)
    httpsRequired: false         # true only if it does NOT work over plain http at all (secure-only login
                                 # cookie, WebCrypto vault): in LAN mode it then needs an HTTPS main address
                                 # (secure LAN, Tailscale or a domain) and the store says so before install
    kind: web                    # web (default) | api: machine-facing (an MCP gateway, a document server):
                                 # addresses to copy, no Open button (decision 141). Put it on ui.primaryEndpoint.
    # cookies: shared            # optional (Harbor 0.32.0, decision 167): writing the key at all needs
                                 # release.minHarbor: "0.32.0" (older Harbors refuse unknown keys).
                                 # isolated (default) = over the secure LAN address Harbor's relay renames and
                                 # signs this endpoint's HttpOnly cookies, so other apps on the same machine never
                                 # receive them. shared = its own cookies pass unchanged (it still never receives
                                 # another app's isolated cookies, and may not set a name shaped like one). Only for an app that must hand its cookie to
                                 # something else on harbor.local; most apps never need it.
ports:                           # optional (Harbor 0.29.0, decision 163; set release.minHarbor: "0.29.0"):
  wireguard:                     # a fixed host port published on EVERY network of the machine, no proxy, no URL
    service: app                 # e.g. a VPN server's tunnel port. Needs multiInstance: false. The plan refuses
    containerPort: 51820         # a port another app holds, something on the machine uses, or one inside
    hostPort: 51820              # Harbor's own range. The console says which port to forward on the router.
    protocol: udp                # udp only for now
    purpose: WireGuard VPN tunnels   # A release that ADDS a port is accepted like a new permission (0.31.0).
permissions:                     # optional (0.29.0, decision 163): per service, from this fixed list only.
  app: [net-admin, ip-forwarding]  # net-admin = NET_ADMIN (tunnels, routes, firewall rules); tun = the
                                 # /dev/net/tun device (OpenVPN); ip-forwarding = net.ipv4.ip_forward and friends,
                                 # inside the app's own network. Harbor renders them; cap_add/devices/sysctls stay
                                 # refused in compose.yaml. The operator accepts them when approving the install
                                 # (and an update that adds one); update-all and auto-update skip such updates.
health:
  endpoint: web
  path: /                        # must answer before any account exists; a published address of this
                                 # endpoint is checked at this path too (API-only app: e.g. /healthz)
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 90
ui:
  primaryEndpoint: web
storage:                         # optional: one claim per named volume
  - id: data
    composeVolume: data
    purpose: Uploaded files
    retention: retain
    external: {hint: "Pick a folder with room, e.g. /srv/harbor/MyApp", required: false, readOnly: false}
    # Claiming a folder stamps an app-generated drive id into its `.harbor-bind.json` marker
    # (random at install, kept on restore, fresh on replacement). A missing, foreign or
    # swapped folder refuses Start with DATA_MISSING; the observer stops the app when its
    # drive leaves and auto-starts it when the right folder is back (see decisions 89–90).
secrets:                         # optional: Harbor generates and keeps these
  - id: app-secret
    bytes: 32
    encoding: hex
    retention: retain
    # showOnce: JWT secret for the document server   # optional (decision 138): the operator sees this
    #                              generated value once after install, under this label (e.g. to paste it
    #                              into another system); never shown again, kept as an instance secret
    bindings:
      - service: web
        environment: APP_SECRET
      - service: web             # the value inside a literal (decision 139): images without a shell
        environment: DATABASE_URL  # cannot assemble a URL in `command:`. Exactly one {{value}}; no `$`.
        template: "postgres://app:{{value}}@db:5432/app"
        encode: url              # optional: percent-encode the value first (operator-typed passwords)
  - id: upstream-token           # …or asks the operator for one at install (decision 125, see §8)
    source: operator
    prompt: Access token of the documents app (its Settings → Access tokens)
    minLength: 16                # optional limits (1–4096); one line, no control characters
    optional: false              # true: install may leave it empty (the variable is then not set)
    retention: retain
    bindings:
      - service: web
        environment: UPSTREAM_TOKEN
links:                           # optional: talk privately to another installed app (decision 126, see §8)
  - id: docs                     # lowercase, ≤ 30 chars; the other app answers as `docs-link`
    purpose: The documents app this gateway reads and writes
    provider:
      packages: [docsapp]        # optional: which packages can satisfy it (any app when omitted)
      endpoint: web              # optional: the provider's endpoint (default: its main one)
    optional: false              # true: install may go without a provider for now
    bindings:
      - service: web             # only bound services join the link network
        environment: DOCS_BASE_URL
        format: url              # url (http://docs-link:3010) | authority (docs-link:3010) | host | port
configuration:                   # optional: hand the app its main address (links it sends out)
  - service: web
    environment: PUBLIC_URL
    endpoint: web
    format: origin               # url | origin | authority | host | scheme
                                 # The main address is the one picked at install: this network (secure
                                 # LAN when on, else LAN, else localhost), Tailscale or a domain. Written
                                 # at install/update/Restart — not at a plain Start.
hooks:                           # optional: apps that check the Host they are reached by (Nextcloud)
  afterStart:                    # runs INSIDE `service` after every start, Restart, publish and unpublish
    service: web
    user: www-data               # optional; the image's default user otherwise
    timeoutSeconds: 120          # 10–1800; a failing or slow hook is reported, the app still runs
    command: [sh, -c, 'for a in $HARBOR_ADDRESSES; do my-admin-tool trust "$a"; done']
                                 # Environment: HARBOR_ADDRESSES (every host[:port] it answers on, space
                                 # separated: localhost, LAN names/IPs on the http and secure ports, tailnet,
                                 # domains), HARBOR_PROXIES (where Harbor's proxies connect from — trust
                                 # forwarded headers only from these), HARBOR_URL (the main address).
                                 # Must be idempotent: it runs again on every address change.
setup:                           # optional: tell people what to do on first open
  endpoint: web
  instructions: Create the first account; it becomes the administrator.
defaultCredentials:              # optional: ONLY if the image ships a fixed login; shown with a "change it" warning
  username: admin
  password: changeme
  note: Change it under Settings → Users right after signing in.
provisionedCredentials:          # optional: Harbor creates the admin account through env vars at first install
  service: web                   # the service that reads them
  passwordEnv: ADMIN_PASSWORD    # Harbor injects a generated password here
  usernameEnv: ADMIN_USER        # either: Harbor injects the username ("admin" or `username`) here…
  username: admin                # …or the image uses a fixed name (then omit usernameEnv)
  note: Shown next to the one-time credentials after the install.
  label: My App admin login      # optional: what the one-time display calls it (default "<name> admin login")
                                 # Mutually exclusive with defaultCredentials. The credential is shown
                                 # once in the install result and retained as an instance secret.
presentation:
  tagline: Short line shown on the card
  category: productivity         # productivity media files automation network developer ai security finance home other
  icon: icon.svg
  gallery: [shot-1.png, shot-2.png]   # up to 6 screenshots (png/jpg/webp ≤ 1 MiB); a strip on the install page
  developer: You
  website: https://example.com
  source: https://github.com/you/my-app   # Harbor ≥ 0.30.0 (declare release.minHarbor: "0.30.0"): "Source code on GitHub" on the install page
  releaseNotes: What changed in this revision (shown before an update)
  sizeHint: About 300 MB, plus your files   # optional, ≤ 120 chars: shown as "Needs …" on the install page
  hideFromHome: false            # true suggests hiding it from Home (helpers without a page); the operator decides
```

Text the operator reads (names, descriptions, prompts, setup instructions, notes) is plain text: it is
shown as text everywhere, never as HTML, so `Bearer <token>` and `https://<domain>/` are fine
(decision 137). Control characters are refused.

## 3. compose.yaml (the supported subset)

```yaml
services:
  web:
    image: nginx:1.27-alpine          # a tag is fine: Harbor resolves it to repository@sha256 at upload
    environment:
      TZ: UTC
    volumes:
      - type: volume
        source: data
        target: /usr/share/nginx/html
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  data: {}
```

Allowed per service: `image`, `command` (an argument array, decision 123), `environment` (literal
values), `depends_on` (with `condition`), `healthcheck`, `volumes` of `type: volume`. Not allowed, on
purpose: `ports` (Harbor publishes the endpoints on 127.0.0.1 itself), `entrypoint`, `privileged`, `cap_add`, `devices`, host networking, bind mounts
(operators choose folders through storage claims instead).

`healthcheck: {disable: true}` (Harbor 0.28.4, decision 162; set `release.minHarbor: "0.28.4"`) switches off a check the
image carries. Use it when the image's own check cannot pass in your setup or takes longer than Harbor waits: Harbor
starts apps with `compose up --wait`, so an unhealthy container fails the install. `disable` stands alone (no `test`
or timings), and no service may wait for a disabled one with `condition: service_healthy`. Harbor's own HTTP health
check (`health:` in the manifest) still decides whether the app is ready.

`command` replaces the image's CMD (the image's ENTRYPOINT still runs first). Use the array form —
`command: [bench, worker, --queue, short]` — or a shell when you need one:
`command: [sh, -c, 'exec my-server --port 8080']`. Write it exactly as the container should receive it:
`$` is literal (Harbor escapes it for Compose), so `$HOME` reaches the shell, not Compose. The string
form (`command: my-server --port 8080`) is refused.

Every named volume needs exactly one storage
claim; every claim must be mounted. Secrets and configuration bindings must not be set literally in
`environment` as well.

**A cache should not persist** (lesson from a real move). A cache service such as Redis whose image
declares a `VOLUME` keeps its data in an anonymous volume across restarts and reboots. After a data copy
the app then ran with the empty install's cache (Frappe hid every Server Script until `bench clear-cache`).
Turn persistence off for caches — `command: [redis-server, --save, "", --appendonly, "no"]` — and claim
storage only for what is real data.

## 4. What Harbor does at upload

1. Reads the zip (no symlinks, no `..`, CRC checked). A manifest whose `release.minHarbor` is newer than
   this Harbor is refused first, with "needs Harbor x.y.z or newer". Then it validates `manifest.yaml` against the schema and
   `compose.yaml` against the subset, and cross-checks them (services, endpoints, volumes, bindings).
2. Resolves every image that is not already `repository@sha256:…` at its registry (anonymous pull token,
   `linux/amd64`), rewrites `compose.yaml` to the digest, and records tag, digests and image creation
   time in a generated `release.json` (qualification `pending`: Harbor did not test your app itself).
3. Stores the package under `/var/lib/harbor/packages/<id>/` and lists it in your App Store with a
   *Your app* badge. Installing it is the same one-click flow as a built-in app.
4. If a package with the same id exists: the new revision must be higher (same revision with the same files
   is a no-op; same revision with different files is refused). Apps installed from the older revision
   show **Update available**.

## 5. Updates

**Update** (app drawer, the Home *updates* card, or `harbor update <name>`) keeps the instance name,
ports, published addresses, data volumes, your folders and secrets. It stops and deletes the current
containers, stores the new release, creates volumes/secrets/ports the new release adds (volumes the new
release dropped are kept, never deleted), pulls the new images by digest, starts, and checks health.
If the new release does not start or answer, Harbor puts the previous release back and starts it again;
the operation fails with a clear message and the app keeps running as before. Data migrations are the
app's own business: Harbor never touches the contents of a volume.

The same mechanism updates built-in apps: a new official catalog (§10) carries a higher revision, and
every installed app from that package shows an update (or updates itself, where the operator turned on
automatic updates). This no longer waits for a Harbor release.

## 6. Handy commands

```sh
harbor packages                       # your uploaded packages
harbor packages validate ./my-app     # the daemon's validators on a folder (or a repo with harbor/), offline
harbor packages add my-app.zip        # upload (pins images, reports what changed)
harbor install my-app                 # install like any other package
harbor list                           # UPDATE column shows "-> 2 (1.1.0)" when one is available
harbor update my-app --yes            # update; rolls back automatically on failure
harbor packages remove my-app         # only after every app from it is uninstalled completely
```

## 7. Apps from a git repository (develop → push → redeploy)

A repository layout Harbor understands:

```
your-app/
  harbor/
    manifest.yaml     required (same template as §2)
    compose.yaml      required (same subset as §3, plus `build:` below)
    README.md         optional
    icon.svg          optional
  app/
    Dockerfile        your code, built on the machine at install/update time
    …                 whatever the Dockerfile needs
```

`compose.yaml` services may declare `build:` **instead of** `image:` (git sources only; zip uploads
refuse it):

```yaml
services:
  web:
    build:
      context: ../app        # relative to harbor/; may step up into the repo, never out of it
      dockerfile: Dockerfile # optional, defaults to Dockerfile
```

The context and its Dockerfile must be real folders and files inside the repository (checked on disk, not
only by name: a symbolic link that leads out of the repository is refused). Links *inside* the context are
fine as long as they are relative and stay inside the context. `harbor/` itself and the files in it must not
be links (decision 165).

What Harbor does: shallow-clones the branch, records the **commit SHA** (the provenance pin for
built services — registry digests still pin `image:` services), appends the committer date to
`release.revision` so every commit orders as a newer revision, snapshots the build contexts into
the package, and runs the same validation as a zip. At install/update time Harbor runs
`docker build` (15-minute cap, progress in the operation events) and tags the image
`harbor-src/<app>-<service>:<shortsha>`. Files reach the build with git's modes (0644, 0755 for
executables), so a `COPY` into an image that runs as a non-root user stays readable. A failed build or a failed start rolls back exactly like
any other update.

Redeploy on commit: Harbor polls the branch (`git ls-remote`, default every 15 minutes — no inbound
webhooks needed, which matters behind NAT). With the toggle on, a new commit is imported and the
update plan submitted automatically (actor `git-source`); off, you get a notification and update
manually. A commit that does not validate is recorded on the source and skipped — the running app
is never touched. `harbor sources add/check/redeploy/remove` mirror the console's Store section.

## 8. Values from the operator, and links to other apps

**Operator-provided secrets** (`source: operator`). Some apps need a value the operator already has —
another service's API token, an SMTP password. Declare it with a `prompt` (what to type, where to find
it); Harbor asks for it in the install review dialog (a password field) or takes it from the CLI
(`harbor install my-app --secret upstream-token=@token.txt`, or `=-` for stdin; a value on the command
line itself is refused). It is stored and bound exactly like a generated secret: a 0600 file in the
instance's `secrets/`, kept across remove/reinstall/update, deleted by a full uninstall, never shown in
the console, the API, plans, operation events or logs. An update asks only for operator secrets the new
release adds. The operator can replace a value later (app page → *Values you provided → Change…*, or
`harbor configure my-app --secret upstream-token=@new.txt`). `bytes`/`encoding` are for generated
secrets only; `prompt`/`optional`/`minLength`/`maxLength` for operator ones only.

**Links** (`links:`). Apps are isolated: each runs on its own private network. When your app needs
another installed app (an MCP gateway that calls a documents app's API), declare a link instead of going
out through the other app's public address. At install the operator picks which app provides it (the
only candidate is picked automatically; CLI `--link docs=<app>[/<endpoint>]`). Harbor then creates one
network for this link, joined by **only** your bound services and the provider's endpoint service (its
database and other services never join), with no route to the internet. The provider answers on it as
`<link-id>-link` on its container port, and your variables receive that address in the chosen `format`.

- The provider is attached live; it is not restarted.
- If the provider is removed or uninstalled, the link is dropped and your app is flagged *needs a
  provider* (it keeps running without the variable after its next restart); the operator picks another
  app on its page or with `harbor configure my-app --link docs=<app>`.
- Restart re-creates the network if it went missing. Update keeps links, adds the ones a new release
  declares, and removes the ones it no longer declares.
- Use the address as a base URL (`url` has no trailing slash). Authenticate to the other app like any
  client would (often with an operator-provided secret, above): a link is reachability, not trust.


## 9. Backup place packages (`kind: BackupTarget`)

Apps are not the only packages. A **backup place** (decision 152) is a package too: it tells Harbor
which form to show and which built-in transport to hand the answers to. It carries **no code**:
backups run as root over every app's plaintext, so a package that could run something would be a root
shell. Bundled ones live in `targets/<id>/` (`manifest.yaml` + `README.md`); uploading your own is
planned for 0.27.

```yaml
apiVersion: harbor/v1alpha1
kind: BackupTarget
metadata:
  id: mega                       # lowercase, dashes; the folder name
  name: MEGA
  description: Your MEGA account, through rclone.
  status: beta                   # stable | beta (shown as a badge)
release:
  revision: "1"
transport: rclone                # local | s3 | sftp | rclone | rest
rclone:
  backend: mega                  # any rclone backend name (https://rclone.org/overview/)
fields:
  - id: user                     # ^[a-z][A-Za-z0-9]{0,31}$
    label: Email
    type: text                   # text | secret | textarea | number
    required: true
    rclone: user                 # the rclone option this answer fills
  - id: pass
    label: Password
    type: secret                 # stored masked, never in DTOs or logs, no default allowed
    required: true
    rclone: pass
    obscure: true                # passed through `rclone obscure` (rclone wants passwords obscured)
  - id: path                     # the one field without `rclone`: the folder in the remote
    label: Folder
    type: text
    default: harbor-backups
```

Rules the loader enforces (`src/backups/targets.ts`):

- Built-in transports read fixed field ids: `local` → `path`; `s3` → `endpoint`, `bucket`,
  `accessKeyId`, `secretAccessKey` (+ optional `path`, `region`); `sftp` → `host`, `user`, `path`,
  `privateKey` (+ optional `port`, `hostKey`); `rest` → `url` (+ optional `username`, `password`). A
  field the transport does not read is refused.
- `rclone` targets need `rclone.backend`, and every field except `path` must name its rclone option.
- `obscure` and `rclone` only apply to rclone targets; a secret cannot have a default.
- Any cloud rclone supports is a new package, not a Harbor release. One rclone does not support needs
  a new transport in the engine.

## 10. Adding an app to the official catalog (harbor-apps)

The built-in apps are not in this repository. They live in
[carlosalaniz/harbor-apps](https://github.com/carlosalaniz/harbor-apps), one folder per app, in the same
package format as above (decision 158). Every change merged there reaches Harbor boxes as a new
catalog within about 6 hours, without a Harbor release.

```
harbor-apps/
  apps/index.json          id -> { revision, dir, optional minHarbor }
  apps/<id>/manifest.yaml, compose.yaml, README.md, release.json, icon.png|svg (+ screenshots)
  scripts/subset.mjs       CI helper: copies a list of apps + a filtered index.json into a folder
  scripts/require-icons.mjs CI check: every app has an icon
```

**Every official app has an icon** (2026-10-12): a square tile, .png or .svg, at most 256 KiB, readable on both the
light and dark themes (the console draws it as a rounded square). Use the project's own logo or
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons); a transparent mark goes on a plain plate (white
for dark marks, dark slate for light ones), no gradients. Never Umbrel's gallery (umbrel-apps has no license).

**Contribution flow.** Clone both repositories side by side (`harbor/` and `harbor-apps/`) and run the
tools from the Harbor checkout. They find `../harbor-apps/apps` on their own; otherwise pass
`--catalog <dir>` or set `HARBOR_CATALOG_DIR`.

1. Edit `apps/<id>/`. Raise `release.revision` in the manifest **and** `revision` in `apps/index.json`
   on every change that should reach boxes as an update.
2. New or changed images: `node scripts/catalog-pin.mjs <id>` pins each `repo:tag` to its digest and
   rewrites `release.json` (no Docker needed).
3. `pnpm catalog:hash <id>` refreshes the file hashes (`--check` only reports stale ones);
   `pnpm catalog:verify` loads every app exactly as the daemon does.
4. Try it: `HARBOR_DEV_CATALOG=../harbor-apps/apps pnpm dev` shows the whole catalog in the dev console.
5. Open a pull request on harbor-apps. Its CI runs `catalog:verify` and `catalog:hash --check` with
   published Harbor releases' own loaders (see *minHarbor* below).

**minHarbor (decision 161).** An app states the oldest Harbor release it runs on in its own manifest:

```yaml
release:
  revision: "7"
  minHarbor: "0.29.0"   # optional; "x.y.z" (no leading zeros), a published Harbor release
```

- Leave it out when the app works on Harbor 0.28.0 (the first Harbor that downloads catalogs): that is
  the default. When you set it, it must be **0.28.2 or newer**, the first release that ships the field
  (0.28.0 and 0.28.1 do not know it and would refuse the manifest), so `pnpm catalog:verify` and uploads
  refuse `0.28.1` or lower. Write it the way the release is tagged: `0.28.2`, never `0.028.2` or
  `0.28.02` (leading zeros are refused).
- Set it when the app uses something a Harbor release added: a new manifest or Compose field, a new
  value, a wider limit. The Harbor release notes say which version first accepts each change. Use that
  version.
- A Harbor older than the value lists the app as unavailable ("needs Harbor x.y.z or newer"), refuses to
  install, restore or update to it, and refuses it as an upload or git source with the same message.
- `pnpm catalog:bundle` copies the value into the app's entry of the bundled `index.json`, because a
  0.28.0 box reads only the index. `apps/index.json` may leave it out; when it has one, it must equal the
  manifest's (verify, plan and bundle fail otherwise).
- `pnpm catalog:verify` prints `minHarbor=<value>` (or `minHarbor=0.28.0(default)`) for every app.
  `pnpm -s catalog:plan <apps>` prints the apps grouped by it, as one line of JSON:
  `{"groups":[{"minHarbor":"0.28.0","ids":["actual",...]},{"minHarbor":"0.28.2","ids":[...]}]}`
  (versions sorted, ids sorted; exit 1 with the reason when a declaration is invalid).

**What CI checks (the proof).** The value is your claim, and harbor-apps CI proves it instead of
trusting it:
1. the declared version must be a real published Harbor release: a GitHub release `v<x.y.z>` on
   carlosalaniz/harbor, not a draft or prerelease, whose tag commit is on Harbor's `main`;
2. the app must validate with **that** release's own validator: CI resolves the tag to its commit,
   checks that the commit is on Harbor's `main`, and checks out that exact commit (never the tag name,
   so a tag moved later cannot change what was checked). It installs that release's own toolchain
   (Node from its `package.json` engines, pnpm from its `packageManager`), runs `pnpm install`, and runs
   its `pnpm catalog:verify` on a folder holding just the apps that declare that version
   (`scripts/subset.mjs`);
3. every app also validates with the **latest** Harbor release (resolved and checked out the same way),
   which also builds the bundle.
An app's folder must be named exactly like its id (`apps/<id>/`, index entry `"dir": "<id>"`): Harbor's
catalog loader already refuses an index entry whose `dir` differs from its id, and the subset copies rely
on it.
The format only grows (below), so an app that passes on its minimum and on the latest release passes on
every release in between.

**The format only grows** (for Harbor developers changing the format itself). Every published app is
read by Harbors of every age, so:
- never remove, rename or narrow a field or value an official package may use;
- add new fields and values as optional, and widen limits and patterns, never tighten them. Say in the
  release notes which Harbor version first accepts the change, so app authors know what to put in
  `release.minHarbor`;
- index.json entry fields are not package fields: an older Harbor refuses the whole index on an unknown
  key, so a new one needs a new index schemaVersion or must stay out of the index;
- a breaking change needs a migration in the engine: Harbor adapts old packages, like Umbrel;
- unknown keys stay refused (an unknown Compose key is a security boundary).
Harbor CI's `official-catalog` job loads the latest published catalog with every Harbor commit, so a
change that breaks a published app fails before it ships.

**Qualification.** `"status": "passed"` in `release.json` only comes from a live run on a disposable
droplet: `node scripts/vm/qualify-catalog.mjs --catalog <dir>` installs each app on a box running a
Harbor archive, opens it in a real browser and writes the result into the checkout's `release.json`
files. It refuses to record anything when the box's catalog revisions differ from the checkout (build
the archive from a bundle of that checkout with `HARBOR_CATALOG_BUNDLE`, or use `--only`). Never set it
by hand. A qualification change alone needs no revision bump.

**Publishing (maintainers).** Every push to `main` of harbor-apps that touches `apps/`, `scripts/`
or the workflow (or a manual run) runs four jobs:

1. **plan** resolves the latest Harbor release to its commit (checked to be on Harbor's `main`), runs its
   `pnpm catalog:plan`, and checks every declared `release.minHarbor` is a published Harbor release,
2. **check** (one job per Harbor version, from plan) checks out that exact commit with its own Node and
   pnpm and runs its `catalog:verify` on the apps that version must accept: the latest release on every
   app, and each declared `release.minHarbor` release on the apps declaring it,
3. **bundle** (read-only, no token) refuses a committer time more than 5 minutes ahead, then runs
   `pnpm catalog:bundle <apps> --out dist --commit <sha> --serial <unix> --summary dist/summary.json` with
   the latest Harbor release, which writes `catalog.zip` (deterministic: index.json with each app's
   declared `minHarbor` copied in, plus, per app, only the package files and the assets its manifest names)
   and `catalog.json` (zip sha256 + size, commit, serial, createdAt, package count), and uploads `dist/`,
4. **publish** (the only job with write access; no checkout, no install; the token reaches only its `gh`
   steps) downloads that artifact, checks it belongs to this commit and serial, and runs
   `gh release create c<serial>` with the two files (release notes from `summary.json`), marked latest.

There is no signature. A box trusts the catalog because it comes over HTTPS from this GitHub repository,
the same trust as Harbor's own self-update (decision 158). `catalog.json` is an integrity check against
a truncated or mixed download, not a trust anchor.

The serial is the commit's committer time in unix seconds. Boxes only ever move to a higher serial, so:
- a committer time more than 5 minutes in the future fails the bundle job,
- a re-run for a commit that is already released does nothing,
- a different commit in the same second as an existing release fails ("make a new commit"),
- a commit older than the latest release is skipped when `main` has moved on (the newer commit
  publishes), and fails as clock skew when it is still `main`'s tip.

Harbor releases ship the latest catalog too: `pnpm package` resolves the latest `c<serial>` tag once,
downloads both files from that tag, and refuses to build an archive whose zip does not match its
`catalog.json` or whose serial differs from the tag.

**Ids.** Official ids are reserved: uploading or importing a package with one is refused ("the id …
belongs to a built-in app"), unless you already had your own package with that id before the official
catalog added it — then yours keeps the id on your box.
