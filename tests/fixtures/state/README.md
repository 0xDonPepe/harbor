# State written by old Harbor releases (upgrade-jump test)

Each `<tag>/` folder is a state directory that the Harbor release `<tag>` wrote itself. The current daemon must
open it and keep working: `tests/integration/upgrade-jump.test.ts` checks that. Real machines skip versions
(production went from 0.22.1 to 0.25.0), so every migration step from that release runs in one go.

| Folder | Release | Schema version on disk |
|---|---|---|
| `v0.19.1/` | 0.19.1 | 8 |
| `v0.22.1/` | 0.22.1 | 10 |
| `v0.35.0/` | 0.35.0 | 13 |

These folders are **frozen test data**. Never edit them by hand, and do not regenerate them to match the current
code. When a release changes the schema, add a fixture for that release's tag instead.

## How they were made

```sh
node scripts/make-state-fixture.mjs v0.25.0             # a new release tag (one or more)
node scripts/make-state-fixture.mjs v0.22.1 --force     # replace an existing fixture (new ids and keys)
```

The script needs explicit tags and refuses a tag whose folder already exists unless `--force` is given.

For each tag, the script:

1. checks the tag out into a temporary git worktree outside the repository (`/tmp/harbor-old-<tag>`) and runs
   `pnpm install --frozen-lockfile --prefer-offline` there;
2. runs `scripts/state-fixture/driver.mts` with **that release's own code**. The driver starts the old daemon in
   fake mode (its FakeDocker, its fake Tailscale, Caddy and kernel crypto) and goes through the old public API,
   like an administrator would;
3. copies `state/`, `data/` and `fixture.json` here, then removes the worktree and the scratch root
   (`/tmp/harbor-fixture-<tag>`).

Nothing touches Docker or a live host. `pnpm install --prefer-offline` may download packages that are missing from
pnpm's cache.

## What the old Harbor did

- Enrolled the administrator `admin` / `upgrade-FIXTURE-password`, then logged in twice (one normal session, one
  30-day "remember me" session).
- Installed **excalidraw**, **memos** in an encrypted app home in the data folder (Harbor's own key), and **n8n**
  (two services, two generated secrets). Then stopped n8n.
- Tried to install **bentopdf** with a simulated registry failure, so there is one failed install and an
  `operation-failed` notification.
- Put excalidraw on the tailnet and memos on the public name `notes.example.com` (no basic auth).
- Saved settings: Home order, wallpaper rotation every 6 hours, machine name `fixture-harbor`, the global
  auto-update default (off), an ntfy channel, and excalidraw's display name, icon and auto-update.

The first encrypted install stored the installation's 12 recovery words in its operation result, as those
releases did (0.19.1, 0.22.1). The current daemon has to remove them (decision 165). From 0.31.0 the words are shown
once and never stored, so the `v0.35.0/` database has none.

## Files

- `state/`: the old Harbor's state directory: `harbor.db` (WAL checkpointed on close; there is no `-wal` or `-shm`
  file, and the script refuses to write one: never open these databases in place, copy them first), `instances/<id>/`
  (release copy, rendered `runtime/compose.yaml`, `secrets/`) and the wallpaper cache.
- `data/`: the data folder holding the memos app home (`manifest.json`; `vault/` and `volumes/` are empty).
- `fixture.json` describes the run:
  - the release version and the absolute `root` it ran under;
  - when it was made (`madeAt`), the admin login and the two session tokens it issued, the fixed listen port and app
    port range;
  - the sealed homes and the instances, exposures and notification kinds the old API reported;
  - `emptyDirs`: empty folders, which git does not keep;
  - `docker`: the fake engine's containers, volumes and networks.

  The test brings these back because the Docker engine and the kernel's fscrypt keys outlive a Harbor upgrade.

## Notes for the test

- **Secret values.** Nothing here was drawn at random, so nothing looks like a credential (AGENTS.md §3.3):
  - tokens the daemon draws (app secrets, session tokens) are `fefefe…<counter>`, through the daemon's `ids` override;
  - everything else the old code draws through `node:crypto` `randomBytes` (machine and app-home keys, salts, nonces,
    drive ids, fake container ids, the recovery words) is `fdfdfd…<counter>`: the driver swaps `randomBytes` for that
    stream. The recovery words come out as one word repeated twelve times (`sausage sausage …`).

  Ciphertext, GCM tags and scrypt hashes are computed from those values, so they still look random. They are
  deliberate and protect nothing; `.github/secret_scanning.yml` keeps `tests/fixtures/state/**` out of secret
  scanning for that reason.
- **Time.** The test sets its clock to two minutes after `madeAt`, so both old sessions are still within their
  lifetime on any day it runs.
- **Ports.** The app ports (47310-47349) are fixed in the state. The test checks that they are free on 127.0.0.1
  first and names any taken port.
- **Paths.** The state stores absolute paths (app homes, volume folders). The test copies the fixture to a
  temporary root, then replaces the generating root (`fixture.json` `root`) with its own in every text cell of
  `harbor.db` and every text file. A real upgrade keeps its paths, so this change only exists for the test.
