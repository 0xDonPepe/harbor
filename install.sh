#!/usr/bin/env bash
# Harbor one-line installer for Ubuntu 24.04/26.04 / Debian 12+ on x86-64.
#
#   curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh | sudo bash
#
# What it does (each step is printed): checks the machine, installs Docker if needed, downloads the newest
# Harbor release from GitHub and verifies its signature and checksum, names the machine `harbor` (so it answers as
# http://harbor.local on your network through mDNS), installs Harbor, and prints the setup code for the
# browser wizard where you create your account. Nothing is asked on the terminal.
#
# Options (environment variables):
#   HARBOR_VERSION=0.8.0     install a specific release instead of the newest
#   HARBOR_HOSTNAME=harbor   mDNS name (default harbor -> http://harbor.local); empty keeps the current hostname
#   HARBOR_LAN=auto|on|off   LAN mode (default auto: on when the machine has a private-network address)
#   HARBOR_TOOLS=1           also set up Cockpit and Portainer
#   HARBOR_FORCE=1           allow a Debian/Ubuntu DERIVATIVE (Linux Mint, Pop!_OS, Raspberry Pi OS, ...):
#                            not a tested configuration; you keep the pieces
#   HARBOR_REPO=owner/name   GitHub repository (default carlosalaniz/harbor)
#   HARBOR_ARCHIVE=/path/harbor-X.Y.Z-linux-x64.tar.gz   install from a local archive (with SHA256SUMS and
#                            SHA256SUMS.sig next to it) instead of GitHub
#   HARBOR_ALLOW_UNSIGNED=1  accept a release without SHA256SUMS.sig: only together with an explicit
#                            HARBOR_VERSION older than 0.32.0 (the first signed release), downloaded from GitHub.
#                            A signature that does not verify is always refused. (An archive you built yourself
#                            has no signature: extract it and run `sudo ./bin/harbor bootstrap --yes` instead.)
#
# Signature (decision 168): SHA256SUMS.sig is the Ed25519 signature of SHA256SUMS by Harbor's release key; the
# public halves are below. The installer verifies it with openssl BEFORE it trusts the checksum, and stops otherwise.
set -euo pipefail

REPO="${HARBOR_REPO:-carlosalaniz/harbor}"
WANT_HOSTNAME="${HARBOR_HOSTNAME-harbor}"
LAN="${HARBOR_LAN:-auto}"
WORK=/root/harbor-install
FIRST_SIGNED=0.32.0

# Harbor's release public keys, one PEM block each, in the order of src/release-keys.ts (harbor-2026-10). A
# signature counts when any of them verifies it, so a rotation adds the next key here first. Keep the two equal
# (tests/unit/signing.test.ts checks it).
HARBOR_RELEASE_KEYS='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAm1Nz4bx1UpDvo+pvgAweZveNPi8c9dH2ze/kPaLPtXA=
-----END PUBLIC KEY-----'

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# verify_sig <sums-file> <base64-sig-file> <work-dir>: 0 when one of the release keys signed the exact bytes of
# <sums-file>.
verify_sig() {
  rm -f "$3"/harbor-release-key-*.pem
  printf '%s\n' "$HARBOR_RELEASE_KEYS" | awk -v dir="$3" '/-----BEGIN PUBLIC KEY-----/ { n++ } n { print > (dir "/harbor-release-key-" n ".pem") }'
  openssl base64 -d -A -in "$2" -out "$3/SHA256SUMS.sig.bin" 2>/dev/null || return 1
  [ "$(wc -c < "$3/SHA256SUMS.sig.bin" | tr -d ' ')" = "64" ] || return 1
  for key in "$3"/harbor-release-key-*.pem; do
    [ -f "$key" ] || continue
    if openssl pkeyutl -verify -pubin -inkey "$key" -rawin -in "$1" -sigfile "$3/SHA256SUMS.sig.bin" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

# fetch_sig <url> <out>: download SHA256SUMS.sig. A 404 (a release from before 0.32.0) leaves no file; any other
# failure stops the install (fail closed: a network error must not look like "unsigned").
fetch_sig() {
  rm -f "$2"
  sig_http=$(curl -sSL --max-time 30 -o "$2" -w '%{http_code}' "$1") || true
  case "$sig_http" in
    200) ;;
    404) rm -f "$2" ;;
    *)   rm -f "$2"; die "could not download SHA256SUMS.sig of Harbor $VERSION (HTTP ${sig_http:-000}); nothing was installed" ;;
  esac
}

# check_release_sig <dir>: decide on <dir>/SHA256SUMS before its checksum is trusted. Sets SIGNED, or stops.
#   signed + verifies                                              -> "signature OK"
#   signed + does not verify                                       -> stop, always
#   unsigned + HARBOR_ALLOW_UNSIGNED=1 + explicit older HARBOR_VERSION (GitHub download) -> loud warning, go on
#   unsigned otherwise                                             -> stop
check_release_sig() {
  if [ -f "$1/SHA256SUMS.sig" ]; then
    verify_sig "$1/SHA256SUMS" "$1/SHA256SUMS.sig" "$1" || die "SHA256SUMS of Harbor $VERSION does not match its signature (SHA256SUMS.sig): the files were changed, or signed by a key Harbor does not trust. Nothing was installed."
    SIGNED="signature OK"
  elif [ -n "${HARBOR_ARCHIVE:-}" ]; then
    die "$HARBOR_ARCHIVE has no SHA256SUMS.sig next to it; refusing an unsigned archive. For an archive you built yourself, extract it and run: sudo ./harbor-$VERSION-linux-x64/bin/harbor bootstrap --yes"
  elif [ "${HARBOR_ALLOW_UNSIGNED:-0}" = "1" ] && [ -n "${HARBOR_VERSION:-}" ] && version_lt "$VERSION" "$FIRST_SIGNED"; then
    warn "##############################################################################"
    warn "HARBOR_ALLOW_UNSIGNED=1: Harbor $VERSION has NO signature (SHA256SUMS.sig)."
    warn "Nothing proves this archive is an official Harbor release. Installing it anyway."
    warn "##############################################################################"
    SIGNED="UNSIGNED (HARBOR_ALLOW_UNSIGNED=1)"
  elif version_lt "$VERSION" "$FIRST_SIGNED" && [ -n "${HARBOR_VERSION:-}" ]; then
    die "Harbor $VERSION is older than $FIRST_SIGNED, the first signed release. To install it anyway, on purpose: HARBOR_VERSION=$VERSION HARBOR_ALLOW_UNSIGNED=1"
  elif version_lt "$VERSION" "$FIRST_SIGNED"; then
    die "the newest Harbor release ($VERSION) is older than $FIRST_SIGNED, the first signed release, and has no signature. If Harbor $FIRST_SIGNED is being published right now, try again in a few minutes. Nothing was installed."
  else
    die "Harbor $VERSION has no SHA256SUMS.sig; refusing an unsigned release. Nothing was installed."
  fi
}

# version_lt A B: 0 when release version A is older than B (x.y.z, numeric per part)
version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$1" ]
}

[ "$(id -u)" -eq 0 ] || die "run as root:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sudo bash"
command -v curl >/dev/null || die "curl is required (apt-get install -y curl)"
command -v tar  >/dev/null || die "tar is required"
command -v openssl >/dev/null || die "openssl is required to check the release signature (apt-get install -y openssl)"

say "Checking this machine"
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
FORCE="${HARBOR_FORCE:-0}"
SUPPORTED=0
case "${ID:-}" in
  ubuntu) [[ "${VERSION_ID:-}" == 24.04* || "${VERSION_ID:-}" == 26.04* ]] && SUPPORTED=1 ;;
  debian) [[ "${VERSION_ID:-}" == 12* || "${VERSION_ID:-}" == 13* ]] && SUPPORTED=1 ;;
esac
if [ "$SUPPORTED" != "1" ]; then
  # Another Ubuntu/Debian RELEASE is not a derivative: bootstrap refuses it even with --force (src/bootstrap/host.ts),
  # so HARBOR_FORCE must not be offered for it.
  case "${ID:-}" in
    ubuntu|debian) die "Harbor supports Ubuntu 24.04/26.04 LTS and Debian 12/13 (this is ${PRETTY_NAME:-unknown}). Install a supported release; HARBOR_FORCE=1 only covers Debian/Ubuntu derivatives." ;;
  esac
  case " ${ID_LIKE:-} " in
    *debian*|*ubuntu*)
      [ "$FORCE" = "1" ] || die "Harbor supports Ubuntu 24.04/26.04 LTS and Debian 12/13 (this is ${PRETTY_NAME:-unknown}). This distro is Debian/Ubuntu-based and will probably work: re-run with HARBOR_FORCE=1 (not a tested configuration; you keep the pieces)."
      warn "HARBOR_FORCE=1: ${PRETTY_NAME:-unknown} is not a tested configuration; proceeding anyway"
      ;;
    *) die "Harbor supports Ubuntu 24.04/26.04 LTS and Debian 12/13 (this is ${PRETTY_NAME:-unknown})" ;;
  esac
fi
[ "$(uname -m)" = "x86_64" ] || die "Harbor supports x86-64 machines (this is $(uname -m))"
[ -d /run/systemd/system ] || die "systemd is required"
FREE_KB=$(df --output=avail -k / | tail -1)
[ "$FREE_KB" -ge 8000000 ] || die "at least 8 GB of free disk space is needed on / (have $((FREE_KB/1024/1024)) GB)"
MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
[ "$MEM_KB" -ge 1800000 ] || warn "less than 2 GB of memory; small apps only"
echo "    ${PRETTY_NAME}, x86-64, $((MEM_KB/1024/1024)) GB memory, $((FREE_KB/1024/1024)) GB free"

mkdir -p "$WORK"
rm -f "$WORK/SHA256SUMS" "$WORK/SHA256SUMS.sig" "$WORK/SHA256SUMS.sig.bin"
if [ -n "${HARBOR_ARCHIVE:-}" ]; then
  say "Using local archive $HARBOR_ARCHIVE"
  [ -f "$HARBOR_ARCHIVE" ] || die "$HARBOR_ARCHIVE not found"
  [ -f "$(dirname "$HARBOR_ARCHIVE")/SHA256SUMS" ] || die "SHA256SUMS must sit next to $HARBOR_ARCHIVE"
  ARCHIVE=$(basename "$HARBOR_ARCHIVE")
  VERSION=$(echo "$ARCHIVE" | sed -E 's/^harbor-([0-9.]+)-linux-x64\.tar\.gz$/\1/')
  [ "$VERSION" != "$ARCHIVE" ] || die "archive name must look like harbor-X.Y.Z-linux-x64.tar.gz"
  cp -f "$HARBOR_ARCHIVE" "$WORK/$ARCHIVE"; cp -f "$(dirname "$HARBOR_ARCHIVE")/SHA256SUMS" "$WORK/SHA256SUMS"
  if [ -f "$(dirname "$HARBOR_ARCHIVE")/SHA256SUMS.sig" ]; then cp -f "$(dirname "$HARBOR_ARCHIVE")/SHA256SUMS.sig" "$WORK/SHA256SUMS.sig"; fi
else
  curl -fsS --max-time 15 -o /dev/null "https://api.github.com/repos/$REPO/releases" || die "cannot reach GitHub (api.github.com) or the repository is not public"
  say "Finding the newest Harbor release"
  if [ -n "${HARBOR_VERSION:-}" ]; then
    VERSION="$HARBOR_VERSION"
  else
    VERSION=$(curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO/releases?per_page=10" | grep -o '"tag_name": *"v[0-9][0-9.]*"' | grep -o 'v[0-9][0-9.]*' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
    [ -n "$VERSION" ] || die "no release found in $REPO"
  fi
  ARCHIVE="harbor-${VERSION}-linux-x64.tar.gz"
  BASE="https://github.com/$REPO/releases/download/v${VERSION}"
  echo "    Harbor $VERSION"
  say "Downloading $ARCHIVE"
  cd "$WORK"
  curl -fSL --progress-bar -o "$ARCHIVE" "$BASE/$ARCHIVE"
  curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS"
  fetch_sig "$BASE/SHA256SUMS.sig" SHA256SUMS.sig
fi
cd "$WORK"
say "Verifying $ARCHIVE"
# The signature first: SHA256SUMS is only trusted once Harbor's release key vouches for its exact bytes.
check_release_sig "$WORK"
grep " $ARCHIVE\$" SHA256SUMS | sha256sum -c - >/dev/null || die "checksum mismatch for $ARCHIVE"
rm -rf "harbor-${VERSION}-linux-x64"
tar -xzf "$ARCHIVE"
echo "    $SIGNED, checksum OK, Harbor $VERSION"

# LAN mode: on when there is a private-network address (home/office); a cloud server would expose everything
HAS_PRIVATE=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | grep -Ec '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' || true)
LAN_FLAGS=""
case "$LAN" in
  on)   LAN_FLAGS="--lan --lan-force" ;;
  off)  LAN_FLAGS="" ;;
  *)    if [ "$HAS_PRIVATE" -gt 0 ]; then LAN_FLAGS="--lan"; else warn "no private-network address found (cloud server?): LAN mode stays off; use Tailscale or SSH forwarding to reach Harbor"; fi ;;
esac
HOST_FLAGS=""
if [ -n "$WANT_HOSTNAME" ] && [ "$(hostname)" != "$WANT_HOSTNAME" ]; then HOST_FLAGS="--hostname $WANT_HOSTNAME"; fi
TOOL_FLAGS="--with-tailscale --with-public-proxy"
[ "${HARBOR_TOOLS:-0}" = "1" ] && TOOL_FLAGS="$TOOL_FLAGS --with-tools"
[ "$FORCE" = "1" ] && TOOL_FLAGS="$TOOL_FLAGS --force"

say "Installing Harbor $VERSION (Docker, mDNS, Tailscale, HTTPS proxy; a few minutes)"
# shellcheck disable=SC2086
"./harbor-${VERSION}-linux-x64/bin/harbor" bootstrap --yes --install-docker --setup-in-browser $TOOL_FLAGS $LAN_FLAGS $HOST_FLAGS
