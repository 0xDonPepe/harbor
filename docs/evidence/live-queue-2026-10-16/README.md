# Live: the operation queue on harbor-old (Harbor 0.35.0, 2026-10-16, decision 183)

Real Docker on harbor-old (x86-64, Ubuntu 24.04), driven with the `harbor` CLI over SSH. Throwaway apps named `q-*`
(unencrypted); the box's own apps (Ollama, Open WebUI, ComfyUI, a retained Nextcloud) were not touched and were
still healthy at the end.

| File | What it proves |
|---|---|
| `1-queue-installs-and-same-app-stop.txt` | Four requests in a row: install FreshRSS (running, pulling), install Memos (waiting), **Stop FreshRSS while its own install runs** (the CLI asks to queue it; `--yes`), install Excalidraw (waiting). `harbor queue` lists them in run order, the stop as a waiting item of its own |
| `2-cancel-too-late-refused.txt` | The queue drained in seconds (cached images): cancelling the now-running Excalidraw install is refused `NOT_CANCELLABLE` (*a running step cannot be stopped safely*), a finished one says *has finished*. The queued Stop of FreshRSS was planned at its turn and ran right after the install (FreshRSS ends `installed / stopped`) |
| `3-cancel-waiting-install.txt` | Install Uptime Kuma, install Bentopdf behind it, cancel the Bentopdf install while it waits: *Cancelled … nothing was changed*, state `cancelled` / `CANCELLED`, the name `q-bento` is free (not in `harbor list`) and installs again at once |
| `4-daemon-restart-with-items-waiting.txt` | A same-app Stop queued behind Bentopdf's install and a reviewed Restart of Memos waiting, then `systemctl restart harbor`. The items already under way finished; the waiting Restart ended `cancelled` with *Harbor restarted before this ran; nothing was changed.* (`startedAt` empty: never picked), and Memos stayed `installed / running / healthy`. No app was left `needs_action` |
| `5-five-purges-queued.txt` | Cleanup as a last test: five full uninstalls queued at once ran one after another; no `q-` app, container or volume left |

Not reproduced live: a running operation cut by a restart (`needs_action`, unchanged since decision 12) and
`REVIEW_NEEDED` (covered by the integration suite).
