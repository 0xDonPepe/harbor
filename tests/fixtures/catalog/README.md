# Test catalog (frozen copies)

These are frozen copies of the official apps that Harbor's tests, the e2e suite and `pnpm dev`
use: bentopdf, excalidraw, freshrss, immich, jellyfin, memos, n8n, nextcloud, uptime-kuma.

They are not the App Store. They never ship in a release and are never shown to a real Harbor box.
The real catalog lives in [carlosalaniz/harbor-apps](https://github.com/carlosalaniz/harbor-apps)
(decision 158); update apps there, not here.

Change a copy only when a test needs it. After editing one, refresh its hashes:

```sh
pnpm catalog:hash --catalog tests/fixtures/catalog <id>
pnpm catalog:verify tests/fixtures/catalog
```
