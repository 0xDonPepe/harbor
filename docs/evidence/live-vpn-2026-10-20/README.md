# Live: VPN and offline apps on harbor-old (2026-10-20, Harbor 0.36.0)

Decisions 184–185, docs/design/VPN.md. Host: harbor-old (Ubuntu 24.04, kernel 6.8, Docker 29.8.1 with the
iptables-nft backend, nftables 1.0.9, wireguard-tools 1.0.20210914, Tailscale running). VPN server: a plain kernel
WireGuard interface (`wgtest0`, UDP 51840, NAT to the internet) on the harbor-test droplet, opened with
`do-vm.mjs firewall-udp on 51840` and removed afterwards. Release: a signed local build of 0.36.0 applied with
`harbor self-update apply --archive` (redeployed after each fix below). Test apps: comfyui-gpu (switched between
modes), ollama-gpu and open-webui-gpu (direct, then every-app VPN).

Redacted: the droplet's address (`<droplet-ip>`), the home connection's public address (`<home-public-ip>`), LAN
addresses (`<harbor-old-lan>`, `<router>`, …), the SSH user and WireGuard public keys. The client configuration (with
its private key) lived only in a 0600 file on harbor-old and was deleted at the end.

| Log | What it shows |
|---|---|
| 00, 01, 02 | 0.35.0 → 0.36.0 (signature + checksum verified); both units enabled, `docker.service.requires/harbor-egress.service`; nftables + wireguard-tools present; no table, no rules: a machine that never used it is untouched |
| 03 | Baseline from comfyui-gpu's network: home address, DNS works, router and another app reachable |
| 04a | **Bug found live:** `nft -f -` from a pipe fails on nft 1.0.9 ("Not a regular file: /dev/stdin"); the tunnel came up but the rules did not, and tunnel-set left it half-made. Fixed: the ruleset loads from a root-only file; tunnel-set is all-or-nothing |
| 04 | After the fix: `harbor vpn set` → connected; `/etc/harbor/egress` 0700 root with 0600 files; `wg show`; ip rules 5160/5170/5180; table 4842; the loaded nft table |
| 05 | `harbor internet comfyui-gpu vpn` (configure plan, CLI) |
| 07, 09 (the droplet-side captures of this first round came back empty: tcpdump was not line-buffered) | VPN app leaves with the droplet's address, direct app with the home one, both reach the router. **Second bug found live:** the captures show the lookups leave from the HOST (its own LAN address, nothing on the bridge) to the router and 1.1.1.1: Docker's resolver forwards host-inherited servers from the host namespace, so the subnet mark never saw them (a DNS leak). Fixed: non-direct apps get a rendered `dns:` (VPN `198.51.100.53`, offline `127.0.53.53`) |
| 10, 11, 12 | After the fix: comfyui's container has `dns=[198.51.100.53]`; from inside it, lookups appear ONLY on `hb-vpn0` and inside the droplet's tunnel (none on wlp5s0/enp6s0), the public address is the droplet's, the router still answers. dockerd's log (not kept) shows that an explicit server is asked from the container's namespace, so these are app packets the firewall marks |
| 13 | Kill switch, server end down: lookup fails, a connection to 9.9.9.10 by IP times out, no packet for it on the physical interfaces; the router still answers; a direct app keeps the home address |
| 14 | `harbor vpn status --check` → NOT connected after 3 minutes; the bell's `vpn-down` ("comfyui-gpu goes through the VPN and has no internet until it is back") after 5 minutes without received bytes; resolved by itself once the server was back; the app leaves through the droplet again |
| 15 | `harbor vpn remove`: interface gone, table 4842 keeps its catch-all; no internet, no lookup; `harbor vpn set` again → connected |
| 16, 17 | **Third finding:** with `blackhole` the app waited out its own timeout (8 s); with `unreachable` the connection fails in 5 ms |
| 18, 20 | Lookups without a tunnel took 32 s (Docker's resolver ignores host/net-unreachable): VPN DNS is now turned to this machine and refused with port-unreachable → 4 s (one reply hit ICMP rate limiting; the rest were refused at once) |
| 19 | Offline: the container gets `dns=[127.0.53.53]`; internet by IP refused in 5 ms, lookups refused in 4 ms, router and this machine's LAN address refused; the app answers on loopback and from a Mac on the LAN (`harbor-old.local:18081` → 200) and stays healthy. **Fourth finding:** the offline app still reached another app through its own bridge's gateway (`172.18.0.1:18082` → 200) |
| 20 | Fixed (`fib daddr type local` marks anything addressed to this machine): offline → gateway refused, also for its own port; a VPN app may still reach other apps here (your network, by design) |
| 21 | `harbor vpn every-app on`: ollama-gpu and open-webui-gpu restarted by Harbor (actor `vpn-policy`), rendered `dns=[198.51.100.53]`, open-webui leaves through the droplet; `off`: restarted again, no `dns`, home address |
| 22a | An invalid first attempt at the boot test (Docker is socket-activated: Harbor's next ping restarted it, with our firewall, before the script's wipe ran; the script then deleted the table). Kept for honesty |
| 22 | Boot order, with `docker.socket` stopped too: table, ip rules, routes and `hb-vpn0` wiped, then `systemctl start docker.socket docker.service` → `harbor-egress.service` finished (nft + routing) before Docker started; table=1, rules=3, tunnel absent; the VPN app's connection refused (exit 7) until `harbor-vpn.service` brought the tunnel up; then the droplet's address |
| 23 | Cleanup: comfyui-gpu back to its default (direct, no `dns`, home address), VPN removed → no table, no rules, no routes, no interface; `rules.nft` removed, so the boot unit is skipped |

Not covered live: a real reboot (harbor-old's root is LUKS and asks for a passphrase at the console; the boot test
above replays the same unit ordering), the console pages (e2e on the fake engine), IPv6 inside app networks (not used
by Harbor).
