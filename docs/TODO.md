# TODO — found on a real host, not built yet

Work items found while moving a set of existing Compose apps onto Harbor on one home server
(2026-10-06, Harbor 0.22.1). Unlike `FUTURE.md` (deliberately out of scope), these are wanted.
Each needs the normal round: tests first, decision row, docs, release (AGENTS.md §4).

## 1. Encryption at rest for apps installed from the CLI (highest priority)

**Bug.** `harbor install <package>` without `--location` installs the app on plain Docker volumes
(`/var/lib/docker/volumes/hb_<id>_<claim>`), unsealed. The console wizard defaults to **Local**
(sealed in the Harbor data folder with Harbor's own key, decision 94). Same action, two different
outcomes, and nothing in the CLI output says "not encrypted". Consequence seen: after a reboot such
apps start by themselves before any login (no BFU, see `docs/design/APP_HOMES.md`) and their data is
plaintext on disk.

- [x] *(0.23.0, decision 130)* CLI `install` defaults to the Harbor data folder (sealed, no passphrase), exactly like the
      console; an explicit opt-out flag only if a real need appears (decide in the decision row).
- [x] *(0.23.0, decision 130)* Install plan + `harbor inspect` + console drawer say plainly whether an app is sealed
      ("Encrypted: no — plain Docker volumes"), and `harbor list` gets a column or marker.
- [x] *(0.24.0, decisions 142 + 144, verified live)* **`harbor seal <app>`**: move an installed app's plain volumes into a sealed home in place —
      same instance id, ports, names, links, exposures, secrets. Shape like the 0.17.0-beta.2
      in-place sealing (stop → create home → seal empty `volumes/` → `cp -a` each claim's volume
      into it as root → verify entry counts and bytes → switch the instance's volume definitions →
      start → only then delete the plain volumes; any failure restores the original). Needs free
      space for one extra copy; cannot scrub old blocks (say so). Console: *Encrypt this app…* in
      the drawer for unsealed apps. Integration tests with the fake adapter + a live run.
- [x] *(0.23.0)* Doc: OPERATOR_GUIDE "Headless reboot" section must also say that unsealed apps restart on
      their own (and how to tell which are which).
- [x] *(0.24.0, decision 143, verified live)* **Change an app's encryption passphrase** (custom-passphrase apps, and switching an app between
      "Harbor's own key" and "my own passphrase"): re-wrap the app key in the home's envelope
      (old passphrase or recovery key + new passphrase), never re-encrypt the data; refresh the
      machine wrapping; console drawer *Change passphrase…* + `harbor passphrase <app>` (values via
      stdin/console only, never in plans or logs, like decision 125).

## 2. Features wanted

- [x] *(0.23.0, decision 131)* **Hide apps from Home.** Helper apps without a page of their own (e.g. an MCP gateway, a
      document server) clutter the launcher. Per-app *Hide from Home* (drawer + `harbor look <app>
      --hide/--show`), a settings-table preference, no migration; hidden apps stay in the Store's
      *installed* view, in Platform/app lists and in notifications; Home shows a quiet "N hidden"
      link to reveal them. A package may suggest `presentation.hideFromHome: true` (API-only apps)
      as the default.
- [x] *(0.23.0, decision 132)* **Picture of the day by default.** A fresh install starts with rotating wallpapers on
      (Bing picture of the day, keyless, daily) instead of a static preset; existing installs keep
      their choice; credit shown on Home as today. Must degrade quietly offline (keep the last
      picture or the preset).
- [x] *(0.25.0, decisions 145–146, verified live; the copy goes through the kernel, see decision 145)* **Move an app between locations** (Local ↔ external drive, drive ↔ drive) keeping its
      encryption: stop → copy the sealed home's ciphertext as-is (`cp -a` of the home, no decrypt)
      to the target candidate → verify counts/bytes → switch the instance's home path and volume
      definitions → start → delete the source only after success; same instance id, ports, links,
      exposures, secrets. Passphrase rules follow the target (a removable drive requires a
      passphrase or the Harbor-password wrapping, decision 94/112); refuse targets that cannot seal
      (non-ext4). Console *Move to…* in the drawer + `harbor move <app> --location <dir>`.
      Pairs with `harbor seal` (§1): plain → sealed first, then move.

## 3. Smaller bugs and rough edges

- [x] *(0.23.0, decision 133: own port)* **Tailnet exposure collides with the LAN app port.** In LAN mode an app's host port (e.g.
      18080) is published on every interface (`0.0.0.0:18080`, plain HTTP, via docker-proxy).
      Publishing the same app on the tailnet runs `tailscale serve --https=18080 → 127.0.0.1:18080`
      on the **same port number**: tailscaled only gets the tailnet IPv6 address, while on the
      tailnet IPv4 address the app's plain-HTTP listener answers the TLS handshake. Seen as
      `degraded` with `write EPROTO … SSL routines:tls_get_more_records:packet length too long`;
      `http://<tailnet-ipv4>:18080/` answers 200 in plain HTTP. Fix: give tailnet HTTPS its own port
      (or `:443` with a path/hostname split), or bind LAN app ports to the LAN interface only (not
      `tailscale0`); add a check that refuses a tailnet port already bound on `0.0.0.0`.
      **Worse than a warning:** once tailscaled holds that port, the app's next `update` (or any
      container recreate) fails with `failed to bind host port` for the endpoint service, the
      automatic rollback fails the same way, and the app is down in `needs_action`. Seen live; the
      way out was freeing the port by hand (`tailscale serve --https=<port> off`), `remove` +
      `reinstall`, then re-publishing. Fix this before tailnet publishing is offered again.
- [x] *(0.23.0, decision 135: unexpose + Repair)* **`needs_action` has no repair path for publishing.** `unexpose`, `update` and `expose` all
      refuse in `needs_action` ("requires an installed app"), so the exposure that caused the failure
      cannot be withdrawn through Harbor. Allow withdrawing exposures (and a "retry last operation")
      in `needs_action`.
- [x] *(0.23.0, decision 134: kept and re-applied)* **`remove` silently withdraws public names; `reinstall` does not bring them back.** After
      remove + reinstall both domains had to be re-published by hand (and `primary` re-set). Either
      keep exposures with the retained instance and re-apply them on reinstall, or say clearly in the
      remove plan which names will go.
- [x] *(0.23.0, decision 135)* **Failed recreate leaves a container with no network.** After the failed bind, the endpoint
      container existed with `NetworkSettings.Networks = {}` and crash-looped (`host not found in
      upstream`); Harbor showed it as part of a running app. Rollback should remove such half-created
      containers, and readiness should flag them.
- [x] *(0.23.0)* **Package lesson (document in DEVELOPER_PACKAGES):** a cache service (redis) inside a package
      should not persist (`--save ""`): an image-declared VOLUME keeps the cache across restarts and
      reboots, and after a data copy the app ran with the empty install's cache (Frappe hid all
      Server Scripts until `bench clear-cache`).

- [x] *(0.23.0, decision 136)* **Port-80 owner misdetection.** With another reverse proxy (not Harbor's Caddy) on :80 the
      daemon logs `port 80 is taken (Caddy): the LAN console is served through the proxy` — wrong
      owner and wrong conclusion; the console is then only on `127.0.0.1:<management port>`.
      Detect Caddy by its admin API/unit, otherwise say "taken by another program".
- [x] *(0.23.0, decision 138)* **One-time credentials on stdout.** `harbor install` prints provisioned credentials into the
      terminal/log of whoever runs it. Add `--credentials-file <path>` (0600) and print only where
      they went.
- [x] *(0.23.0, decision 138)* **Misleading label.** The install tray calls every provisioned credential "Basic-auth
      credentials", also when it is an app admin login or a shared secret (e.g. a document
      server's JWT secret). Use the package's own label/`credentialsNote`.
- [x] *(0.23.0, decision 138)* **Show-once generated secrets.** Let a package mark a generated secret as shown once to the
      operator (so it does not have to abuse `provisionedCredentials` for e.g. a JWT secret).
- [x] *(0.23.0, decisions 134–135: forgets the kept address; purge withdraws leftovers)* **Unexpose on a retained instance.** `harbor unexpose` right before `purge` failed with
      `INVALID_STATE: exposure changes require an installed instance; <app> is retained` although
      the app looked installed; purge then removed the route anyway. Reproduce and fix the state check
      or the message.
- [x] *(0.23.0, decision 139)* **Secret inside a literal env value.** Images without a shell cannot assemble e.g. a
      database URL in `command:`; allow a secret reference inside an environment literal
      (rendered by Harbor, never logged).
- [x] *(0.23.0, decision 140)* **Validate a package folder locally.** No CLI/route to run the daemon's validators on a
      folder before pushing a git source (`harbor packages validate <dir>`).
- [x] *(0.23.0, decision 137)* **`<` and `>` in package text.** Setup instructions cannot show `Bearer <token>` or
      `https://<domain>/`; allow them as text (it is rendered as text anyway) or document an
      alternative.
- [x] *(0.23.0, decision 141)* **API-only apps.** Every app must have a main web endpoint, so an API (e.g. an MCP gateway)
      still shows an *Open* button; allow an endpoint kind "api" with no browser launch.

## Backups (decisions 149–154): what 0.26.0 left for the next batches

Built in 0.26.0: restic engine through the root step, places Another disk / S3 / SFTP / Proton Drive
(beta), the nightly schedule with warm passes and the downtime cap, restore in place, restore on
another machine with the recovery key, console + CLI. Next:

- [ ] **0.27 — consistency B (database dumps).** Manifest `backup.dumps[] {service, command[],
      restore[], replaces}` (BACKUPS.md §10): `docker exec` streamed into `restic --stdin`, the
      `replaces` claim's raw files skipped, no pause at all; restore starts only that service, pipes the
      dump back, then the rest. Bundled Postgres/MySQL/SQLite packages declare it; operator can force A.
- [ ] **0.27 — uploaded place packages** (zip, same validator as bundled ones) and bundled Google Drive
      (operator pastes a token from `rclone authorize drive`) and MEGA packages.
- [ ] **0.27 — `check` and prune on demand** from Settings → Backups (today: weekly prune, monthly 2 %
      check, when nothing else runs).
- [ ] Live-verify Proton Drive with a real account (needs Carlos's credentials and a 2FA code).

## Official catalog (decision 158): what 0.28.0 left

Built in 0.28.0: the catalog lives in carlosalaniz/harbor-apps, published as GitHub releases (HTTPS, no
signature: signing was built and removed before release, decision 158); boxes
check every 6 hours (or on *Check for new apps* / `harbor catalog refresh`) and swap in a newer one
without a restart; each Harbor release ships the latest as the seed. Next:

- [x] **First publish + live run.** First catalog release `c1791783123`; 0.28.0 upgrade and a real catalog
      download verified on harbor-old (VERIFICATION §3q).
- [ ] **Declared minHarbor, end to end (decision 161).** Once 0.28.2 is released: harbor-apps CI runs
      `pnpm -s catalog:plan` with the latest release and each declared version's own `catalog:verify`;
      then publish an app declaring `release.minHarbor: "0.28.2"` and check that a 0.28.0 (or 0.28.1) box lists it as
      "needs Harbor 0.28.2 or newer" and a 0.28.2 box installs it.
- [ ] **Sign Harbor releases and the catalog together, with one key.** Today both trust GitHub over
      HTTPS (self-update and catalog alike). Signing only the catalog was built and dropped (decision 158):
      it guarded the catalog while the Harbor release on the same account stayed unsigned. Do both at once:
      one key, its custody and rotation written down (and what to do if it leaks), the self-update and the
      catalog download both refusing what it did not sign.
- [ ] **Daemon: download by tag, not `releases/latest`** (`pnpm package` already does, via `catalogTagFromLocation`). A release published between the `catalog.json` and
      `catalog.zip` fetches mixes two bundles; the daemon now starts such a check over once (zip/`catalog.json`
      checksum mismatch). Cleaner: resolve the `c<serial>` tag once and fetch both files from
      `releases/download/c<serial>/`, requiring `meta.serial` to match.
- [ ] **Catalog reset.** A downloaded folder whose stored `catalog.json` is damaged or names another serial
      already falls back to the seed; there is still no operator action to drop the downloaded catalogs
      (today: `sudo rm -rf /var/lib/harbor/catalog` + restart).
- [ ] **Persist `checkedAt` / `error`.** Status forgets the last check on every restart ("Not checked
      since the daemon started"); keep them in the `settings` table.
- [ ] **Review policy for community submissions** to harbor-apps: who may merge, what a reviewer checks
      (images, digests, health path, first run in the browser), and that qualification comes only from a
      droplet run.
- [ ] Small: the catalog fetch still sends the wallpaper fetcher's User-Agent; icons are cached for up to
      5 minutes after a swap.

## Security review (decision 165): what 0.31.0 left

The audit of 2026-10-12 fixed every high and medium finding in 0.31.0. Still open:

- [ ] **One address per app** (1.0 design). In LAN mode every app is `harbor.local:<port>`; browsers scope cookies by
      host, not port, so a malicious app's server receives the session cookies of every other app the admin uses
      (and all apps are same-site, so SameSite gives no CSRF protection between them). Needs `<app>.harbor.local`
      (mDNS names or a resolver, one SAN per app or a constrained wildcard) and the relay routing by name.
- [ ] **Link service-name shadowing.** On a link network Compose adds each bound service's own name as an alias, so a
      consumer service named like a provider-internal service (`db`) can answer the provider's lookups. Needs a
      naming scheme on link networks that keeps existing links working (refusing clashes would break common names).
- [ ] **Signed releases + catalog with one key** (already listed under the catalog); also refuse a self-update to an
      older version without an explicit flag.
- [ ] Low: an open terminal survives logout / password change (check the session on each frame or close terminals on
      revoke); SMTP must require TLS when a password is set and refuse CR/LF in from/to; the Reddit wallpaper fetch
      must not follow redirects to private addresses; GCM decrypt should pin `authTagLength: 16` and a 12-byte nonce;
      root helpers should open status files with `O_NOFOLLOW` and `chownTree` should `lstat`; SFTP places should show
      the host-key fingerprint for confirmation instead of trusting the first answer; the setup routes could say less
      once an administrator exists; the plain-http console could become redirect-only once HTTPS is trusted.
- [ ] Live checks: a request with `Host: harbor.local` from a real public address is refused by Caddy; a stick with a
      setuid binary mounts `nosuid`; *Replace certificate…* with a trusting browser; the key file on `/run`.
