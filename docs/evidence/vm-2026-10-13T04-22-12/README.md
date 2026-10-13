# vm-2026-10-13T04-22-12

Fresh droplet, `pnpm test:vm -- --fresh --exposure`, archive 0.31.0 + the guard fix. 22 pass / 2 fail / 1 blocked.
B11 proves decision 165 live: a public client sending `Host: harbor.local` never reaches the console; the box
itself does; Caddy accepts the remote_ip matcher. B10/B09 failed on stale runner expectations (fixed). See VERIFICATION 3m.
