# Design: VPN and offline apps (decisions 184–185)

**Status:** approved direction (Carlos, 2026-10-20): "Harbor should support VPN connectivity. Global VPN mode:
everything goes through the VPN outbound. Per-app toggle. […] the instances should only communicate to the external
world through the VPN if configured that way. […] a completely offline mode for the app, like a network permission on
GrapheneOS: the app installs and is reachable but cannot connect to the internet." Choices made with him: the VPN is
for **apps only** (never the host); a VPN app whose tunnel is down gets **no internet** (kill switch); **VPN first**,
offline rides the same mechanism; a **package may declare a default** (it does not have to), and the default is direct.
First shipped in 0.36.0.

## 1. What the operator sees

- **Settings → VPN.** *Add VPN…* takes a WireGuard configuration file from the VPN provider (Mullvad, Proton, IVPN,
  AirVPN and most others export one), pasted or uploaded. The page then shows whether it is connected (last handshake),
  the server, the tunnel address and its DNS, and a switch **Send every app through the VPN**. *Replace…* and
  *Remove…* change or drop it. The private key is never shown again.
- **Each app has an *Internet access* choice** (app drawer → *Internet* → *Change…*, the install review, CLI):
  - **Direct**: as today.
  - **Through the VPN**: everything the app opens towards the internet leaves through the tunnel, its DNS lookups
    included. Your own network stays reachable (a NAS, a printer, the router's web page).
  - **Offline**: the app opens no connection to anything: not the internet, not your network, not this machine, not
    other apps (a Harbor link to another app keeps working).

  In every mode the app stays reachable the usual ways (this network, LAN HTTPS, tailnet, public address). Image pulls
  and updates are done by Docker on the host, so offline apps still update.
- **Send every app through the VPN** turns every *Direct* app into *Through the VPN*. Offline apps stay offline. There
  are no exceptions under it ("everything", Carlos's words); an app that must go direct needs the switch off.
- **Kill switch:** an app that goes through the VPN never falls back to direct. While the VPN is not connected, or no
  VPN is set up, it has no internet. The review says so before such a choice is approved, and a notification says how
  many apps are cut off while the VPN is down.
- A package may say what it should start with (`network.internet: offline`, for an app that never needs the internet;
  `vpn`, for a download client). Not declaring it means *Direct*. The operator's choice wins and is kept across
  updates; *Use the app's default* goes back to following the package.

## 2. How it works (host networking, root side)

Almost everything happens on the host, outside the containers: an app's networks, links and ports do not change.
The one thing inside is the resolver its containers ask (below), so a running app restarts for a few seconds when its
mode changes.

- Each app already has its own bridge network (`hb_<…>_default`). Harbor reads its subnet from Docker (IPv4 only;
  Harbor's app networks have no IPv6, and a non-direct app on a network with an IPv6 subnet is refused).
- One nftables table, `inet harbor_egress`, owned by Harbor:
  - **prerouting (mangle):** packets that an app *opens* (`ct direction original`), from its subnet to outside it, get
    a firewall mark: `0x01000000` (VPN) or `0x02000000` (offline), mask `0x0f000000`. Replies to connections that came
    *in* (someone opening the app) are the reply direction and are never marked, so they go back the way they came.
  - **prerouting (dstnat − 5):** a VPN-marked DNS query (udp/tcp 53, any destination) is rewritten to the tunnel's DNS
    server: an app that asks its own resolver (8.8.8.8, say) still asks through the tunnel.
  - **Docker's resolver (found live, Docker 29).** Containers ask Docker's embedded resolver (127.0.0.11), and Docker
    forwards external names **from the host's network namespace**, with the host's own address: nothing crosses the
    app's bridge, so the subnet mark never sees them (the first cut leaked a VPN app's lookups to the router this way,
    and an offline app could still have sent names out). So Harbor renders a resolver into non-direct apps' services
    (`dns:` in the runtime Compose file):
    - VPN apps: `198.51.100.53` (TEST-NET-2, never routed). **output (route, mangle):** the host's queries to it are
      marked VPN; **output (nat, dstnat − 5):** rewritten to the tunnel's DNS; routing then sends them into the tunnel
      (unreachable when there is none); **output (filter):** a VPN-marked host packet not leaving through `hb-vpn0` is
      refused; masquerade gives them the tunnel address. The address stays the same when the tunnel is replaced.
    - Offline apps: `127.0.53.53`, a loopback address nothing listens on: refused on the spot, nothing leaves.
    - Direct apps: nothing rendered, exactly as before 0.36.0 (an upgrade recreates no container).
  - **forward:** offline-marked → reject. VPN-marked: DNS that is not leaving through the tunnel → reject; leaving
    through `hb-vpn0` → accept (TCP MSS clamped to the route MTU); to a private, link-local or CGNAT address → accept
    (your own network); anything else → reject. This is the kill switch, independent of routing.
  - **input:** offline-marked → reject (an offline app cannot reach this machine, so it cannot reach other apps
    through their published ports either).
  - **postrouting:** masquerade out of `hb-vpn0`.
- Policy routing for VPN-marked packets only (host traffic is never marked, so the host, Tailscale, Let's Encrypt,
  self-update and image pulls are untouched):
  - `5160: from all to <tunnel DNS> fwmark 0x1000000/0xf000000 lookup 4842`
  - `5170: from all fwmark 0x1000000/0xf000000 lookup main suppress_prefixlength 0` (your network, Docker's bridges,
    anything the host routes specifically; never the default route)
  - `5180: from all fwmark 0x1000000/0xf000000 lookup 4842`
  - table 4842: `default dev hb-vpn0` while the tunnel exists, and always `unreachable default metric 4294967295`
    (`blackhole` dropped forwarded packets silently and apps waited out their timeouts, seen live), so a missing
    tunnel ends the lookup at once instead of falling through to the main default route.
- The tunnel is a kernel WireGuard interface `hb-vpn0` (`ip link add … type wireguard`, `wg setconf`, the address
  and MTU from the file; `rp_filter=2` on it). Only `PrivateKey`, `ListenPort`, `Address`, `DNS`, `MTU` and one
  `[Peer]` (`PublicKey`, `PresharedKey`, `Endpoint`, `AllowedIPs`, `PersistentKeepalive`) are accepted; `PostUp`,
  `PreUp`, `PostDown`, `PreDown`, `Table`, `FwMark`, `SaveConfig` and any other key are refused, because wg-quick
  runs those as root shell commands. `PersistentKeepalive` defaults to 25 (needed to tell a dead tunnel apart).
  No `DNS` in the file: Quad9 (9.9.9.9), through the tunnel, and the VPN page says so.

### Root handoff

The daemon never touches nftables, routes or WireGuard. Like sealing and backups it writes
`<stateDir>/egress/request.json`, passes the configuration text (it holds the private key) through
`<stateDir>/egress/tunnel.fifo`, and blocks on `systemctl start harbor-egress@<action>.service` (polkit allows the
harbor user to start that template only). Actions: `apply` (the full desired state: every non-direct app with its
mode and subnets), `tunnel-set`, `tunnel-remove`, `status`. The root step re-validates every field (subnets must be
private IPv4 CIDRs, ids and modes from fixed patterns), renders the ruleset itself and loads it atomically
(`nft -f`, the table deleted and re-created in one transaction), and writes its verdict to `status.json`.

Root keeps its own copy under `/etc/harbor/egress/` (0700 root): `state.json` (the last applied app rules),
`tunnel.conf` (the `wg setconf` text, 0600), `tunnel.json` (address, DNS, MTU, summary) and `rules.nft` (the ruleset
that loaded last, for the boot unit).

### Boot: fail closed

- `harbor-egress.service` (oneshot, `Before=docker.service`, `RequiredBy=docker.service`,
  `ConditionPathExists=/etc/harbor/egress/rules.nft`) runs `nft -f /etc/harbor/egress/rules.nft` before Docker starts
  any container: one OS binary, no Harbor code, no parsing. Root writes that file (temp + rename) only after the same
  ruleset loaded live, so it is known to load on this kernel. The firewall alone is the kill switch (it refuses
  whatever a VPN app sends outside the tunnel, routes or not), so the routing step that follows
  (`harbor egress-boot`: ip rules and table 4842) may fail without leaking anything (it is `ExecStart=-`). If nft
  itself cannot load the file, Docker does not start: no app runs without its rules. Never used VPN or offline: no
  file, the unit is skipped.
- `harbor-vpn.service` (oneshot, `After=network-online.target`, retried every 15 s) brings the tunnel up, since the
  endpoint name may need DNS. Until then the kill switch holds.

### Daemon side

- The desired state is computed fresh each time from every instance: effective mode (operator's choice, else the
  package default, else direct; *every app through the VPN* turns direct into VPN) and the subnet of its default
  network (skipped when the network does not exist: nothing can run on it). Applies are serialized and skipped when
  the result equals the last one applied this daemon run.
- The runner makes it fail closed at install and start: a non-direct app is created with `up --no-start`, the rules
  are applied, then it starts (the same order links use, decision 171); `start` applies them before `compose start`.
  A failed apply fails the operation and the app does not start. Remove, uninstall and a mode change apply again.
- Every render (install, update, restart, configure, restore, move) writes the resolver of the app's current mode. A
  mode change on a running app is a configure that re-creates it (rules between create and start); on a stopped app
  it loads the rules only, and `start` re-creates the containers when their rendered resolver no longer matches.
  *Every app through the VPN* moves the firewall at once and queues a restart (actor `vpn-policy`) for each running
  app whose mode it changed; until its turn, such an app's lookups still use its old resolver.
- Daemon start: one apply (the boot unit has already loaded the same rules; this catches anything that changed
  while the daemon was down).
- No VPN set up, no non-direct app, no state file: no root call at all.
- Read model: `/sys/class/net/hb-vpn0` (exists, `statistics/rx_bytes`) without root; the exact last handshake comes
  from `harbor-egress@status` when the console opens the VPN page or the operator presses *Check now*. Down = no
  interface, or no received bytes for 5 minutes (keepalive 25 s, rekey every 2 minutes, so a live peer always answers).
  The observer raises `vpn-down` while that lasts and an app uses the VPN; it resolves by itself.

## 3. Package format (decision 185)

```yaml
network:
  internet: offline   # direct (default) | vpn | offline
```

Optional, first accepted by 0.36.0 (`release.minHarbor: "0.36.0"`). An update whose default changes moves an app
that follows the default, and the update review says so.

## 4. Storage

- The operator's choice: `instances/<id>/settings.json` gets `"internet": "vpn" | "direct" | "offline"` next to
  `values` (only when it differs from following the default). Backups, both restores and update rollbacks already carry
  that file, so the choice travels with them; an adopted drive app starts at the package default.
- *Every app through the VPN* and the tunnel summary (no key): the `vpn` row of the `settings` table.
- No schema change.

## 5. Not done (on purpose)

- OpenVPN, several tunnels, per-app tunnels, exceptions under *every app through the VPN*.
- The host itself through the VPN (would cut Tailscale, Let's Encrypt and self-update).
- IPv6 inside app networks (Harbor's are IPv4 only).
- VPN apps reaching tailnet peers (tailnet addresses route into the tunnel).
- Port forwarding through the VPN provider.
