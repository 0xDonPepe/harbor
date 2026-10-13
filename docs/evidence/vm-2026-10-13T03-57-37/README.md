# vm-2026-10-13T03-57-37

Fresh droplet, `pnpm test:vm -- --fresh --exposure`, archive 0.31.0. 16 pass / 8 fail / 1 blocked.
Proves the guard bug fixed in d7dcedc: after A10 restarted Docker, running sealed apps went needs_action
(lock-guard starts on a Docker-down tick) and every later exposure step refused them. See docs/VERIFICATION.md 3m.
