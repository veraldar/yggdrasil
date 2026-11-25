#!/usr/bin/env bash
# trunk.sh — YOUR OWN TRUNK on a small rented server (a VPS): the public address your phone and your
# computers reach. Your home computer (the root) dials OUT to it; nothing at home opens a port.
#
#   sudo bash trunk.sh --name trunk.example.org   first run: install, certificate, start — then CLAIM it
#                                                 (the claim code lives only on this server; your phone's
#                                                 browser turns it into your admin account)
#   sudo bash trunk.sh                            re-run: same release, renew the certificate if due
#   sudo bash trunk.sh --update [--major]         the newest signed 1.x release, if newer (what the weekly
#                                                 timer runs). --major alone allows crossing to 2.x
#   sudo bash trunk.sh --renew [--force]          certificate only (what the daily timer runs)
#   sudo bash trunk.sh --uninstall                remove the trunk (lists what goes, asks first; -y)
#
# Every download is checked before it runs: the release's SHA256SUMS must be signed by the yggdrasil
# release key (embedded below as YGG_SIGNER, never fetched), and each file must match its line in it.
# Safe defaults on the server: the firewall (ufw) on with only ssh, 443 (+ 80 for Let's Encrypt) open,
# Debian's automatic security updates on, and a weekly timer that installs a newer signed release.
#
#   --name NAME          the server's DNS name (an A/AAAA record pointing at this server). Needed once.
#   --add-name HOST      one more DNS name this trunk answers as (extra_names, its own certificate line).
#                         Repeat it per name. Used at switchover: --add-name ap.veraldar.org.
#   --version vX.Y.Z     which release of github.com/veraldar/yggdrasil (default: this script's own)
#   --binary FILE        use this bifrost-net binary instead of downloading one
#   --behind-proxy       :443 (and :80) already serve a website: the trunk listens plain http on
#                         127.0.0.1:8080 (phase 1) and reads the client's real address from X-Forwarded-For
#                         of the proxy in front (trusted_proxies). This script prints how to route the
#                         trunk's name to it (Caddy or nginx).
#   --acme               a certificate from Let's Encrypt (the default). Same as today: from OUR permanent
#                         key with certbot --csr, so the SPKI pin — what roots pin — survives renewals.
#   --webroot DIR        Let's Encrypt through the web server that holds port 80 (it serves DIR at
#                         http://NAME/.well-known/acme-challenge/). Without it, port 80 must be free.
#                         The trunk serves the tokens itself at /.well-known/acme-challenge/ (behind a
#                         proxy, the front forwards that path to the trunk).
#   --email ADDR         tell Let's Encrypt who you are (expiry mails). Default: no address.
#   --acme-server URL    another ACME server (default Let's Encrypt production; tests use Pebble)
#   --self-signed        no Let's Encrypt (tests, LAN). Phones show a warning; roots' pin works the same.
#   --renew [--force]    certificate only (what the daily timer runs)
#   --no-firewall        leave the firewall alone (default: ufw on; it stays off when other services listen)
#   --no-auto-updates    no automatic security updates, no weekly trunk update (both on by default)
#   -y                   don't ask (packages with apt, --uninstall)
#
# Linux x86_64 with systemd and glibc 2.31+ (Debian 11+, Ubuntu 20.04+; tested on Debian 12). Runs as the
# admin user (sudo). Files:
#   /etc/yggdrasil-trunk/trunk.toml   the v1 trunk's config (CONTRACTS C2; no secrets)
#   /etc/yggdrasil-trunk/key.pem      the TLS private key (600): made ONCE, kept forever — the pin your
#                                     roots trust is its fingerprint, so certificate renewals never break it
#   /etc/yggdrasil-trunk/cert.pem     the certificate (Let's Encrypt, made from that key with certbot --csr)
#   /etc/yggdrasil-trunk/trunk.conf   what you chose (name, port, mode) — re-runs read it
#   /var/lib/yggdrasil-trunk/         trunk.db (the trunk's state) — owned by the static user `trunk`
#   /run/trunk/                       credentials (trunk-kek, claim code), copied by an ExecStartPre=+ step
#   /usr/local/lib/yggdrasil-trunk/   bifrost-net · trunk-ctl is /usr/local/bin
#   yggdrasil-trunk.service           the trunk (static user `trunk`; ProtectSystem=strict)
#   yggdrasil-trunk-cert.timer        daily: renews the certificate when a third of its life is left
#   yggdrasil-trunk-update.timer      weekly: trunk.sh --update (a newer signed release, the same checks)
set -euo pipefail
umask 022

# ------------------------------------------------------------------------------ the release key
# scripts/release.sh stamps YGG_RELEASE with the release this file belongs to ('' = from a source checkout:
# the latest release). YGG_SIGNER is the release key's allowed_signers line (RELEASE-KEY.pub in the repo).
YGG_RELEASE=''
YGG_RELEASE_TEST=''
YGG_SIGNER='release@yggdrasil namespaces="yggdrasil-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJyKwTSmRf3Cy1cHpzKHl3teRvCQtgK8/dcFRvlNCDJg'
# A test release (signed by a throwaway key) is marked YGG_RELEASE_TEST=1 by scripts/release.sh: only it, or an
# unstamped script from a checkout, may be pointed at other signers. A real release's script refuses, loudly.
if [ -n "${YGG_RELEASE_TEST_SIGNERS:-}" ] && [ -n "$YGG_RELEASE" ] && [ "$YGG_RELEASE_TEST" != 1 ]; then
  printf '\033[1;31mxx\033[0m  %s\n' "YGG_RELEASE_TEST_SIGNERS is set, but this is the v$YGG_RELEASE release's installer: it trusts only the yggdrasil release key. Unset it — it is for tests, from a checkout." >&2
  exit 64
fi

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$1" >&2; exit "${2:-1}"; }
# never a silent stop: say where — and once this run has replaced the running trunk, put the previous one back
# shellcheck disable=SC2329  # the ERR trap below calls it
on_err() {
  local rc=$?
  printf '\033[1;31mxx\033[0m  trunk.sh stopped at line %s: %s\n' "$1" "$2" >&2
  if [ "${HAVE_PREV:-0}" = 1 ] && [ "${CHANGED:-0}" = 1 ] && [ "${ROLLING:-0}" = 0 ]; then
    ROLLING=1; rollback && warn "the previous trunk is back and answering"
  fi
  exit "$rc"
}
trap 'on_err $LINENO "$BASH_COMMAND"' ERR

ARGS=("$@")
NAME='' VERSION='' BINARY='' PORT='' BEHIND='' CERTMODE='' WEBROOT='' EMAIL='' ACME=''
ADD_NAMES=() MAJOR=0 RENEW=0 FORCE=0 YES=0 UPDATE=0 UNINSTALL=0 FIREWALL='' AUTOUPD=''
need() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 64; }
while [ $# -gt 0 ]; do
  case $1 in
    --name) need "$@"; NAME=$2; shift ;;
    --add-name) need "$@"; ADD_NAMES+=("$2"); shift ;;
    --version) need "$@"; VERSION=$2; shift ;;
    --binary) need "$@"; BINARY=$2; shift ;;
    --port) need "$@"; PORT=$2; shift ;;
    --behind-proxy) BEHIND=1 ;;
    --direct) BEHIND=0 ;;
    --self-signed) CERTMODE=self-signed ;;
    --acme) CERTMODE=acme ;;
    --webroot) need "$@"; WEBROOT=$2; CERTMODE=acme; shift ;;
    --email) need "$@"; EMAIL=$2; shift ;;
    --acme-server) need "$@"; ACME=$2; CERTMODE=acme; shift ;;
    --major) MAJOR=1 ;;
    --renew) RENEW=1 ;;
    --force) FORCE=1 ;;
    --update) UPDATE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-firewall) FIREWALL=0 ;;
    --no-auto-updates) AUTOUPD=0 ;;
    -y|--yes) YES=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" 64 ;;
  esac
  shift
done

# ------------------------------------------------------------------------------------ the server
if [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null || die "run this as the admin user (root): it installs a system service"
  case $0 in /*|./*|../*) exec sudo -- bash "$0" "${ARGS[@]}" ;; *) exec sudo -- bash "./$0" "${ARGS[@]}" ;; esac
fi
[ -d /run/systemd/system ] || die "this server does not run systemd (needed for the service and the renewal timer)"
# (HERE unused in v1: the router comes from the release only)
ETC=/etc/yggdrasil-trunk
LIB=/usr/local/lib/yggdrasil-trunk
VAR=/var/lib/yggdrasil-trunk
CONF=$ETC/trunk.conf
KEY=$ETC/key.pem
CERT=$ETC/cert.pem
TOML=$ETC/trunk.toml
KEK=$ETC/trunk-kek
BIN=$LIB/bifrost-net
CTL=/usr/local/bin/trunk-ctl
SELF=/usr/local/sbin/yggdrasil-trunk
UNIT=yggdrasil-trunk.service
UNIT_FILE=/etc/systemd/system/$UNIT
STATIC_USER=trunk
CHANGED=0
UNITS_ALL=(yggdrasil-trunk.service yggdrasil-trunk-cert.timer yggdrasil-trunk-cert.service
  yggdrasil-trunk-update.timer yggdrasil-trunk-update.service)

confget() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | tail -1 || true; }
# where releases come from (a mirror or a test server is remembered for the timers; signed all the same)
RELEASES=${TRUNK_RELEASES:-$(confget RELEASES)}; RELEASES=${RELEASES:-https://github.com/veraldar/yggdrasil/releases}

# ---------------------------------------------------------------------------------- --uninstall
if [ $UNINSTALL = 1 ]; then
  GONE=()
  for u in "${UNITS_ALL[@]}"; do [ -e "/etc/systemd/system/$u" ] && GONE+=("/etc/systemd/system/$u  (unit)"); done
  for p in "$ETC" "$LIB" "$VAR" /var/log/yggdrasil-trunk "$SELF" "$CTL"; do [ -e "$p" ] && GONE+=("$p"); done
  FW_RULES=$(confget FIREWALL_RULES)
  if [ ${#GONE[@]} = 0 ]; then say "no yggdrasil trunk on this server — nothing to remove"; exit 0; fi
  echo "This removes the yggdrasil trunk from this server:"
  printf '    %s\n' "${GONE[@]}"
  [ -e "$KEK" ] && echo "    (the key-encryption key in $ETC goes too: trunk.db backups become unreadable without it)"
  [ -n "$FW_RULES" ] && echo "    firewall rules trunk.sh added: $FW_RULES (ufw itself stays on, ssh stays open)"
  echo "    kept: the packages it installed (certbot, ufw, unattended-upgrades — the security updates stay on)"
  if [ $YES = 0 ]; then
    [ -t 0 ] || die "--uninstall asks first: add -y to remove without a question" 64
    read -r -p "remove all of this? [y/N] " a
    case $a in y|Y|yes|YES) ;; *) die "nothing removed" ;; esac
  fi
  for u in "${UNITS_ALL[@]}"; do systemctl disable --now --quiet "$u" 2>/dev/null || true; done
  for u in "${UNITS_ALL[@]}"; do rm -rf "/etc/systemd/system/$u" "/etc/systemd/system/$u.d"; done
  systemctl daemon-reload; systemctl reset-failed "${UNITS_ALL[@]}" 2>/dev/null || true
  if [ -n "$FW_RULES" ] && command -v ufw >/dev/null; then
    for r in $FW_RULES; do ufw delete allow "$r" >/dev/null 2>&1 || true; done
  fi
  rm -rf "$ETC" "$LIB" "$VAR" /var/log/yggdrasil-trunk "$SELF" "$CTL"
  if id "$STATIC_USER" >/dev/null 2>&1; then
    userdel "$STATIC_USER" 2>/dev/null || warn "could not remove the user $STATIC_USER (in use?)"
  fi
  say "removed."
  exit 0
fi

NAME=${NAME:-$(confget NAME)}
[ -n "$NAME" ] || die "which name? sudo bash trunk.sh --name trunk.example.org  (a DNS name that points at this server)" 64
NAME=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
NAME=${NAME%.}
case $NAME in
  *[!a-z0-9.-]*|.*|-*|'') die "--name: '$NAME' is not a host name (letters, digits, dots, dashes)" 64 ;;
esac
IS_IP=0; case $NAME in *[!0-9.]*) ;; *) IS_IP=1 ;; esac
BEHIND=${BEHIND:-$(confget BEHIND_PROXY)}; BEHIND=${BEHIND:-0}
CERTMODE=${CERTMODE:-$(confget CERT)}; CERTMODE=${CERTMODE:-acme}
[ $IS_IP = 1 ] && [ "$CERTMODE" = acme ] && die "Let's Encrypt needs a DNS name, not an IP address (or use --self-signed)" 64
# extra names: remembered (a re-run keeps them), --add-name adds to them
EXTRA_NAMES=$(confget EXTRA_NAMES)
for n in ${ADD_NAMES[@]+"${ADD_NAMES[@]}"}; do
  case $n in *[!a-zA-Z0-9.-]*|.*|-*|'') die "--add-name: '$n' is not a host name" 64 ;; esac
  case " $EXTRA_NAMES " in *" $n "*) ;; *) EXTRA_NAMES="${EXTRA_NAMES:+$EXTRA_NAMES }$n" ;; esac
done
# phase 1 (behind a proxy): plain http on 8080 — the v1 config's C2 default
if [ -z "$PORT" ]; then
  PORT=$(confget PORT)
  if [ -z "$PORT" ] || [ "$BEHIND" != "$(confget BEHIND_PROXY)" ]; then [ "$BEHIND" = 1 ] && PORT=8080 || PORT=443; fi
fi
case $PORT in ''|*[!0-9]*) die "--port: a number" 64 ;; esac
WEBROOT=${WEBROOT:-$(confget WEBROOT)}
EMAIL=${EMAIL:-$(confget EMAIL)}
ACME=${ACME:-$(confget ACME_SERVER)}
CA_BUNDLE=${REQUESTS_CA_BUNDLE:-$(confget CA_BUNDLE)}   # a test ACME server's own CA (Pebble); empty for Let's Encrypt
PUBLIC_PORT=$PORT; [ "$BEHIND" = 1 ] && PUBLIC_PORT=443
HOSTPORT=$NAME; [ "$PUBLIC_PORT" = 443 ] || HOSTPORT=$NAME:$PUBLIC_PORT
SCHEME=https; [ "$BEHIND" = 1 ] && SCHEME=http   # phase 1: the proxy terminates TLS; the trunk speaks http
PUBLIC_URL=$SCHEME://$HOSTPORT

# -------------------------------------------------------------------------------------- packages
apt_need() { # PKG… — install what is missing (asks first unless -y or not a terminal)
  local miss=() p
  for p in "$@"; do dpkg-query -W -f '${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || miss+=("$p"); done
  [ ${#miss[@]} = 0 ] && return 0
  command -v apt-get >/dev/null || die "missing: ${miss[*]} — install them with your package manager, then re-run"
  if [ $YES = 0 ] && [ -t 0 ]; then
    read -r -p "install ${miss[*]} with apt? [Y/n] " a
    case $a in n*|N*) die "needs: ${miss[*]}" ;; esac
  fi
  say "apt-get install ${miss[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${miss[@]}" >/dev/null
}

probe_trunk() { # the HTTP status the trunk gives on its port (000: nothing answers in 10 s)
  local c=000 p
  if [ "$BEHIND" = 1 ]; then
    p=(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/t/state")
  else
    p=(curl -sk -o /dev/null -m 5 -w '%{http_code}' --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/t/state")
  fi
  for _ in $(seq 20); do c=$("${p[@]}" 2>/dev/null || true); [ "$c" != 000 ] && break; sleep 0.5; done
  echo "$c"
}
# ------------------------------------------------------------------- the release: signed, checked
fetch() { curl -fsSL --retry 3 --proto '=https,http' -o "$2" "$1"; }
REL_DIR=''
release_sums() { # BASE — BASE/SHA256SUMS into $REL_DIR, verified: signed by YGG_SIGNER, else stop here
  local base=$1 signers
  [ -n "$REL_DIR" ] || { REL_DIR=$(mktemp -d); trap 'rm -rf "$REL_DIR"' EXIT; }
  command -v ssh-keygen >/dev/null || apt_need openssh-client
  say "release: $base/SHA256SUMS (+ its signature)"
  fetch "$base/SHA256SUMS" "$REL_DIR/SHA256SUMS" || die "cannot download $base/SHA256SUMS — check the network and that the release exists"
  fetch "$base/SHA256SUMS.sig" "$REL_DIR/SHA256SUMS.sig" || die "the release at $base has no signature (SHA256SUMS.sig) — refusing it"
  signers=$REL_DIR/allowed_signers
  printf '%s\n' "$YGG_SIGNER" >"$signers"
  if [ -n "${YGG_RELEASE_TEST_SIGNERS:-}" ]; then # tests only: their own throwaway release key
    warn "TEST ONLY: trusting the release signers in $YGG_RELEASE_TEST_SIGNERS (YGG_RELEASE_TEST_SIGNERS), not the built-in key"
    cat "$YGG_RELEASE_TEST_SIGNERS" >"$signers"
  fi
  ssh-keygen -Y verify -f "$signers" -I release@yggdrasil -n yggdrasil-release -s "$REL_DIR/SHA256SUMS.sig" \
    <"$REL_DIR/SHA256SUMS" >/dev/null 2>&1 \
    || die "the SHA256SUMS at $base is NOT signed by the yggdrasil release key — refusing it (a tampered or foreign release)"
  say "release: signature OK (the yggdrasil release key)"
}
sum_of() { sed -n "s/^\([0-9a-f]\{64\}\)  $1\$/\1/p" "$REL_DIR/SHA256SUMS" | head -1; }   # ASSET → its sha256
release_get() { # BASE ASSET OUT — download ASSET, check it against the verified SHA256SUMS
  local want; want=$(sum_of "$2")
  [ -n "$want" ] || die "the release has no $2"
  fetch "$1/$2" "$3" || die "cannot download $1/$2"
  [ "$(sha256sum <"$3" | cut -c1-64)" = "$want" ] || { rm -f "$3"; die "$2 does not match SHA256SUMS — refusing to install it"; }
}
release_base() { if [ -n "$1" ]; then echo "$RELEASES/download/v${1#v}"; else echo "$RELEASES/latest/download"; fi; }
installed_version() { confget BINARY | sed -n 's/^bifrost-net-\([0-9][0-9A-Za-z.+-]*\)-linux-.*/\1/p'; }
newer() { # A B — is version A newer than B? A pre-release is OLDER than its release: 0.9.1-rc.1 < 0.9.1
  [ "$1" = "$2" ] && return 1
  local a=${1%%-*} b=${2%%-*}
  if [ "$a" != "$b" ]; then [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" = "$a" ]; return; fi
  case $1/$2 in
    *-*/*-*) [ "$(printf '%s\n%s\n' "${1#*-}" "${2#*-}" | sort -V | tail -1)" = "${1#*-}" ] ;;
    *-*/*) return 1 ;;
    *) return 0 ;;
  esac
}
major_of() { printf '%s' "${1%%-*}" | cut -d. -f1; }

# ------------------------------------------------------------------------- --update (the timer)
# The newest signed release: when it is newer than the one installed, its own trunk.sh (checked against
# the signed SHA256SUMS) re-runs with --version — the same install, the same checks, the keys + db kept.
# A NEW MAJOR needs --major: v1 never updates itself to v2 silently.
if [ $UPDATE = 1 ]; then
  [ -f "$CONF" ] || die "no trunk installed here (no $CONF) — run trunk.sh --name … first"
  [ "$(confget SOURCE)" = file ] && { say "update: the binary is your own file (--binary) — nothing to update"; exit 0; }
  release_sums "$(release_base "$VERSION")"
  NEWV=${VERSION#v}
  [ -n "$NEWV" ] || NEWV=$(sed -n 's/^[0-9a-f]\{64\}  bifrost-net-\([0-9][0-9A-Za-z.+-]*\)-linux-[a-z0-9_]*$/\1/p' "$REL_DIR/SHA256SUMS" | head -1)
  [ -n "$NEWV" ] || die "the release names no bifrost-net version"
  HAVE=$(installed_version)
  if [ -n "$HAVE" ] && ! newer "$NEWV" "$HAVE"; then
    if [ "$NEWV" = "$HAVE" ]; then say "update: $HAVE is the newest release — nothing to do"
    else warn "update: the release offered ($NEWV) is OLDER than the one installed ($HAVE) — refusing to go back"; fi
    exit 0
  fi
  if [ -n "$HAVE" ] && [ "$(major_of "$NEWV")" != "$(major_of "$HAVE")" ]; then
    if [ $MAJOR = 0 ]; then
      die "update: v$HAVE → v$NEWV crosses a MAJOR version (v$(major_of "$HAVE") → v$(major_of "$NEWV")).
    A major is a different system: read its release notes, then run: sudo bash $SELF --update --major" 64
    fi
    say "update: crossing the major v$(major_of "$HAVE") → v$(major_of "$NEWV") (--major given)"
  fi
  [ -n "$VERSION" ] || release_sums "$(release_base "$NEWV")"   # that release's own signed list (not "latest")
  release_get "$(release_base "$NEWV")" trunk.sh "$REL_DIR/trunk.sh"
  say "update: ${HAVE:-?} → $NEWV (its trunk.sh, checked against the signed SHA256SUMS)"
  install -d -m 711 "$VAR" && install -m 700 "$REL_DIR/trunk.sh" "$VAR/trunk-update.sh"
  rm -rf "$REL_DIR"
  exec bash "$VAR/trunk-update.sh" --version "v$NEWV" -y
fi

# ---------------------------------------------------------------------------- the certificate
pin_of_key() { # the roots' pin: sha-256 of the public key (SPKI), "sha-256 AA:BB:…"
  openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | sha256sum | cut -c1-64 | tr 'a-f' 'A-F' |
    sed 's/../&:/g; s/:$//; s/^/sha-256 /'
}
cert_key_ok() { # does cert.pem carry key.pem's public key?
  [ -s "$CERT" ] && [ "$(openssl x509 -in "$CERT" -noout -pubkey 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)" = \
    "$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | sha256sum)" ]
}
cert_names() { openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed -n 's/^ *\(DNS\|IP Address\):\(.*\)$/\2/p' | tr '[:upper:]' '[:lower:]'; }
cert_for_name() { cert_names | grep -qx "$NAME"; }
cert_due() { # less than a third of its life left (90-day cert: 30 days; 6-day cert: 2 days)?
  local s e now
  s=$(date -d "$(openssl x509 -in "$CERT" -noout -startdate | cut -d= -f2)" +%s) || return 0
  e=$(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" +%s) || return 0
  now=$(date +%s)
  [ $((e - now)) -lt $(((e - s) / 3)) ]
}
self_signed() {
  local san="DNS:$NAME" n
  for n in $EXTRA_NAMES; do san="$san,DNS:$n"; done
  [ $IS_IP = 1 ] && san="IP:$NAME"
  openssl req -x509 -new -key "$KEY" -subj "/CN=$NAME" -addext "subjectAltName=$san" -days 3650 -out "$CERT.new" 2>/dev/null
  chmod 644 "$CERT.new"; mv -f "$CERT.new" "$CERT"
  echo self-signed >"$ETC/cert.source"
  CHANGED=1
}
port_owner() { # proto port → "name" of the process listening there, or empty when free
  ss -Hlnp"$1" "sport = :$2" 2>/dev/null | head -1 | sed -n 's/.*users:(("\([^"]*\)".*/\1/p;t;s/.*/somebody/p'
}
ACME_HINT=''
# printed snippets name IPv6 only where this server has it (nginx refuses [::] without it)
V6_80='' V6_443=''
if [ -s /proc/net/if_inet6 ]; then V6_80='listen [::]:80;' V6_443='listen [::]:443;'; fi
webroot_text() { # who holds :80 → what to add so http://NAME/.well-known/acme-challenge/ reaches the webroot
  local dir=$VAR/acme
  case $1 in
    nginx*) cat <<EOF
nginx holds port 80. Add this server block (e.g. /etc/nginx/conf.d/yggdrasil-trunk-acme.conf):

    server {
        listen 80; $V6_80
        server_name $NAME;
        location /.well-known/acme-challenge/ { root $dir; }
    }

then: sudo nginx -t && sudo systemctl reload nginx
and:  sudo bash trunk.sh --webroot $dir
EOF
    ;;
    caddy*) cat <<EOF
caddy holds port 80. Add this site to your Caddyfile ("http://" = caddy makes no certificate for it):

    http://$NAME {
        handle /.well-known/acme-challenge/* { reverse_proxy 127.0.0.1:$PORT }
        handle { respond 404 }
    }

then: sudo systemctl reload caddy
and:  sudo bash trunk.sh --webroot $dir
EOF
    ;;
    apache2*|httpd*) cat <<EOF
apache holds port 80. Add to the <VirtualHost *:80> that answers $NAME (or a new one with ServerName $NAME):

    ProxyPass /.well-known/acme-challenge/ http://127.0.0.1:$PORT/.well-known/acme-challenge/

then: sudo systemctl reload apache2
and:  sudo bash trunk.sh --webroot $dir
EOF
    ;;
    *) cat <<EOF
"$1" holds port 80, so Let's Encrypt cannot check this server by itself. Make
http://$NAME/.well-known/acme-challenge/FILE serve $dir/.well-known/acme-challenge/FILE,
then: sudo bash trunk.sh --webroot $dir      (or free port 80 and re-run)
EOF
    ;;
  esac
}
acme_issue() { # Let's Encrypt for NAME (+ extra names) from OUR key (certbot --csr): the pin survives every renewal
  local w how=() who sans="DNS:$NAME" n
  for n in $EXTRA_NAMES; do sans="$sans,DNS:$n"; done
  if [ -n "$WEBROOT" ]; then
    mkdir -p "$WEBROOT/.well-known/acme-challenge"; chmod 755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"
    how=(--webroot -w "$WEBROOT")
  else
    who=$(port_owner t 80)
    if [ -n "$who" ]; then ACME_HINT=$(webroot_text "$who"); return 2; fi
    how=(--standalone --http-01-port 80)
  fi
  w=$(mktemp -d)
  openssl req -new -key "$KEY" -subj "/CN=$NAME" -addext "subjectAltName=$sans" -out "$w/ap.csr" 2>/dev/null
  local args=(certonly --non-interactive --agree-tos --preferred-challenges http "${how[@]}"
    --config-dir "$VAR/letsencrypt" --work-dir "$VAR/letsencrypt/work" --logs-dir /var/log/yggdrasil-trunk
    --csr "$w/ap.csr" --cert-path "$w/cert.pem" --fullchain-path "$w/fullchain.pem" --chain-path "$w/chain.pem")
  if [ -n "$EMAIL" ]; then args+=(--email "$EMAIL"); else args+=(--register-unsafely-without-email); fi
  [ -n "$ACME" ] && args+=(--server "$ACME")
  local ca="Let's Encrypt"; [ -n "$ACME" ] && ca=$ACME
  say "certificate: asking $ca for $NAME${EXTRA_NAMES:+ (+ $EXTRA_NAMES)} (HTTP-01 on port 80${WEBROOT:+ through $WEBROOT})"
  if ! REQUESTS_CA_BUNDLE=${CA_BUNDLE:-${REQUESTS_CA_BUNDLE:-}} certbot "${args[@]}" >"$w/log" 2>&1; then
    sed 's/^/    /' "$w/log" | tail -n 15 >&2
    ACME_HINT="the certificate request failed (above). Check that $NAME points at this server (DNS A/AAAA record)
and that port 80 is reachable from the internet (your provider's firewall too). Then re-run: sudo bash trunk.sh"
    rm -rf "$w"; return 1
  fi
  [ -s "$w/fullchain.pem" ] || { ACME_HINT="certbot answered but wrote no certificate"; rm -rf "$w"; return 1; }
  install -m 644 "$w/fullchain.pem" "$CERT.new" && mv -f "$CERT.new" "$CERT"
  rm -rf "$w"
  cert_key_ok || die "the new certificate does not carry this server's key — refusing (your roots' pin would break)"
  echo acme >"$ETC/cert.source"
  CHANGED=1
  say "certificate: $(openssl x509 -in "$CERT" -noout -issuer | sed 's/^issuer=//') · until $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)"
}
ensure_cert() { # → 0 done · 2 waiting for the webroot · 1 failed (ACME_HINT says why)
  if ! cert_key_ok || ! cert_for_name; then
    self_signed   # a valid cert from our key right away: the trunk starts, the roots' pin already works
    say "certificate: self-signed for $NAME (from this server's key)"
  fi
  [ "$CERTMODE" = acme ] || return 0
  if [ "$(cat "$ETC/cert.source" 2>/dev/null)" = acme ] && [ $FORCE = 0 ] && ! cert_due; then
    say "certificate: valid until $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2) — nothing to do"
    return 0
  fi
  apt_need certbot
  acme_issue
}
restart_if_changed() {
  if [ $CHANGED = 1 ] && systemctl is-enabled --quiet $UNIT 2>/dev/null; then
    systemctl restart $UNIT; say "restarted $UNIT"
  fi
}

# ------------------------------------------------------------------------- --renew (the timer)
if [ $RENEW = 1 ]; then
  [ -s "$KEY" ] || die "no $KEY — run trunk.sh --name … first"
  rc=0; ensure_cert || rc=$?
  restart_if_changed
  [ $rc = 0 ] || { printf '%s\n' "$ACME_HINT" >&2; exit 1; }
  exit 0
fi

# ======================================================================================= install
say "yggdrasil trunk (v1) for $NAME ($( [ "$BEHIND" = 1 ] && echo "behind a proxy → 127.0.0.1:$PORT http" || echo "port $PORT"), certificate: $CERTMODE)"
# in a subshell: os-release defines NAME and VERSION, which are ours here
# shellcheck disable=SC1091
OS=$( . /etc/os-release 2>/dev/null; printf '%s|%s' " ${ID:-} ${ID_LIKE:-} " "${PRETTY_NAME:-unknown}" )
case ${OS%%|*} in *" debian "*|*" ubuntu "*) ;; *) warn "made for Debian 11+ / Ubuntu 20.04+; this is ${OS#*|} — trying anyway" ;; esac
# the release's bifrost-net is built on Debian 11: glibc 2.31 or newer, checked before anything is installed
if [ -z "$BINARY" ]; then
  GLIBC=$(ldd --version 2>&1 | head -1 | grep -o '[0-9][0-9]*\.[0-9][0-9]*$' || true)
  if [ -z "$GLIBC" ] || [ "$(printf '%s\n%s\n' 2.31 "$GLIBC" | sort -V | head -1)" != 2.31 ]; then
    die "this server's C library is ${GLIBC:+glibc }${GLIBC:-not glibc}: the release needs glibc 2.31 or newer (Debian 11+, Ubuntu 20.04+). Nothing was installed."
  fi
fi
case $(uname -m) in x86_64|amd64) ARCH=x86_64 ;; aarch64|arm64) ARCH=aarch64 ;; *) ARCH=$(uname -m) ;; esac
# -------------------------------------------------------------------------------- 1. ports first
# before anything is installed: a port taken by someone else stops here (ss comes with iproute2)
command -v ss >/dev/null || apt_need iproute2
OURS=0; systemctl is-active --quiet $UNIT 2>/dev/null && OURS=1
OWNER=$(port_owner t "$PORT")
if [ -n "$OWNER" ] && ! { [ $OURS = 1 ] && [ "$OWNER" = bifrost-net ]; }; then
  if [ "$BEHIND" = 1 ]; then
    die "port $PORT (loopback, for the trunk) is taken by '$OWNER' — pick another: --port N"
  fi
  die "port $PORT is taken by '$OWNER' (a website?). Keep it: run again with --behind-proxy — the trunk then
    listens plain http on 127.0.0.1:8080 and this script shows how to route $NAME to it from :443. Nothing was installed."
fi
if [ "$BEHIND" = 0 ] && [ -z "$(port_owner t 443)" ] && [ "$PORT" != 443 ]; then
  warn "port 443 is free but the trunk will listen on $PORT — phones then need https://$HOSTPORT"
fi

FIREWALL=${FIREWALL:-$(confget FIREWALL)}; FIREWALL=${FIREWALL:-1}
AUTOUPD=${AUTOUPD:-$(confget AUTO_UPDATES)}; AUTOUPD=${AUTOUPD:-1}
PKGS=(ca-certificates curl openssl iproute2 openssh-client sqlite3)   # openssh-client: ssh-keygen checks the release
[ "$FIREWALL" = 1 ] && PKGS+=(ufw)
[ "$CERTMODE" = acme ] && PKGS+=(certbot)
apt_need "${PKGS[@]}"

# ------------------------------------------------------------------------------ 2. the binary
NEWBIN=''
SOURCE=$(confget SOURCE)
BASE=''
if [ -n "$BINARY" ]; then
  [ -x "$BINARY" ] || die "--binary $BINARY: not an executable file"
  NEWBIN=$BINARY GOTVER="local file $(basename "$BINARY")" SOURCE=file
elif [ "$SOURCE" = file ] && [ -z "$VERSION" ] && [ -x "$BIN" ]; then
  # installed from your own file: a re-run keeps it (--version vX.Y.Z switches to a release)
  NEWBIN=$BIN GOTVER=$(confget BINARY)
  say "binary: kept — installed from your own file (--version vX.Y.Z switches to a release)"
else
  SOURCE=release
  [ "$ARCH" = x86_64 ] || die "no release binary for $ARCH yet — build bifrost-net (cargo build --release in trunk/) and pass --binary FILE"
  # which release: --version, else this script's own (stamped), else the latest — never older than installed
  WANTV=${VERSION#v}; WANTV=${WANTV:-$YGG_RELEASE}
  HAVE=$(installed_version)
  if [ -z "$VERSION" ] && [ -n "$HAVE" ] && { [ -z "$WANTV" ] || newer "$HAVE" "$WANTV"; }; then
    [ -n "$WANTV" ] && say "binary: $HAVE is installed, newer than this script's $WANTV — keeping $HAVE"
    WANTV=$HAVE
  fi
  BASE=$(release_base "$WANTV")
  release_sums "$BASE"
  # this very script, when it belongs to the release it installs: the one the release signed, or stop here
  if [ -n "$YGG_RELEASE" ] && [ "$WANTV" = "$YGG_RELEASE" ] && [ -f "$0" ] && [ -n "$(sum_of trunk.sh)" ] &&
     [ "$(sha256sum <"$0" | cut -c1-64)" != "$(sum_of trunk.sh)" ]; then
    die "this trunk.sh is not the one release v$YGG_RELEASE signed (its sha256 is not in SHA256SUMS) — download it again: $BASE/trunk.sh"
  fi
  if [ -n "$WANTV" ]; then ASSET=bifrost-net-$WANTV-linux-$ARCH
  else ASSET=$(sed -n "s/^[0-9a-f]\{64\}  \(bifrost-net-[0-9][0-9A-Za-z.+-]*-linux-$ARCH\)\$/\1/p" "$REL_DIR/SHA256SUMS" | head -1); fi
  WANT=$(sum_of "$ASSET")
  [ -n "$ASSET" ] && [ -n "$WANT" ] || die "the release${WANTV:+ v$WANTV} has no bifrost-net for linux-$ARCH (signed SHA256SUMS)"
  if [ -x "$BIN" ] && [ "$(sha256sum <"$BIN" | cut -c1-64)" = "$WANT" ]; then
    NEWBIN=$BIN
  else
    say "binary: $BASE/$ASSET"
    release_get "$BASE" "$ASSET" "$REL_DIR/$ASSET"
    chmod 755 "$REL_DIR/$ASSET"; NEWBIN=$REL_DIR/$ASSET
  fi
  GOTVER=$ASSET
fi
install -d -m 755 "$ETC" "$LIB"
install -d -m 711 "$VAR"   # 711: a web server may reach $VAR/acme (--webroot), nobody may list
# The trunk as it ran before this run (binary, config, unit, this script) is kept in $VAR/previous:
# when what this run installs does not start or answer, it goes back in place and restarts (--update's net).
PREV=$VAR/previous HAVE_PREV=0
if [ -x "$BIN" ] && [ -f "$CONF" ]; then
  rm -rf "$PREV.new"; install -d -m 700 "$PREV.new"
  for f in "$BIN" "$TOML" "$CONF" "$UNIT_FILE" "$SELF"; do
    if [ -f "$f" ]; then cp -p "$f" "$PREV.new/$(basename "$f")"; fi
  done
  rm -rf "$PREV"; mv "$PREV.new" "$PREV"; HAVE_PREV=1
fi
rollback() { # put the previous trunk back and restart it → 0 when it answers again
  [ "$HAVE_PREV" = 1 ] || return 1
  warn "putting back the trunk that ran before this run ($(sed -n 's/^BINARY=//p' "$PREV/trunk.conf" 2>/dev/null))"
  install -m 755 "$PREV/bifrost-net" "$BIN.new" && mv -f "$BIN.new" "$BIN"
  if [ -f "$PREV/trunk.toml" ]; then install -m 644 "$PREV/trunk.toml" "$TOML"; fi
  if [ -f "$PREV/trunk.conf" ]; then install -m 644 "$PREV/trunk.conf" "$CONF"; fi
  if [ -f "$PREV/$UNIT" ]; then install -m 644 "$PREV/$UNIT" "$UNIT_FILE"; fi
  if [ -f "$PREV/yggdrasil-trunk" ]; then install -m 755 "$PREV/yggdrasil-trunk" "$SELF"; fi
  systemctl daemon-reload; systemctl reset-failed $UNIT 2>/dev/null || true   # a crash loop may have hit the start limit
  systemctl restart $UNIT
  [ "$(probe_trunk)" != 000 ]
}
if [ "$NEWBIN" != "$BIN" ] && ! { [ -f "$BIN" ] && [ "$(sha256sum <"$NEWBIN")" = "$(sha256sum <"$BIN")" ]; }; then
  install -m 755 "$NEWBIN" "$BIN.new" && mv -f "$BIN.new" "$BIN"; CHANGED=1
  say "binary: $BIN ← $GOTVER"
else
  say "binary: $BIN ($GOTVER, unchanged)"
fi
MISSING=$(ldd "$BIN" 2>/dev/null | sed -n 's/^[[:space:]]*\([^ ]*\) => not found.*/\1/p' | tr '\n' ' ' || true)
if [ -n "$MISSING" ]; then
  if [ "$CHANGED" = 1 ] && rollback; then die "$GOTVER needs libraries this server lacks: $MISSING— the previous trunk is back and running"; fi
  die "bifrost-net needs libraries this server lacks: $MISSING"
fi
if ! "$BIN" trunk-kek --help >/dev/null 2>&1; then
  if [ "$CHANGED" = 1 ] && rollback; then die "$GOTVER does not run here — the previous binary is back and running"; fi
  die "$BIN does not run here (too old a release, or the wrong architecture?)"
fi

# ---------------------------------------------------------------- 3. the static user + the kek
# v1: the trunk owns state on disk (trunk.db), so it runs as the STATIC user `trunk` (A16), not a
# dynamic one. The kek stays root-only on disk; an ExecStartPre=+ step copies it (and anything else
# in $ETC/cred) into the service's /run/trunk at each start (LoadCredential fails on Debian 12
# containers, FINDINGS.md:431).
if ! id "$STATIC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$STATIC_USER" \
    || die "could not create the system user $STATIC_USER"
  say "user:   $STATIC_USER (system user, no login)"
fi
chown "$STATIC_USER:$STATIC_USER" "$VAR"
if [ ! -f "$KEK" ]; then
  (umask 077; "$BIN" trunk-kek "$KEK")
  say "kek:    $KEK (new, mode 600 — keep it: trunk.db and its backups are unreadable without it)"
else
  say "kek:    $KEK (kept)"
fi
chown root:root "$KEK"; chmod 600 "$KEK"

# ---------------------------------------------------------------------- 4. DNS + the certificate
if [ $IS_IP = 0 ]; then
  RESOLVED=$(getent ahosts "$NAME" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  MINE=$(ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')
  if [ -z "$RESOLVED" ]; then
    [ "$CERTMODE" = acme ] && die "$NAME does not resolve yet: create a DNS record $NAME → this server's public address, wait a minute, re-run" 64
    warn "$NAME does not resolve (yet) — phones and your roots need it to"
  else
    hit=0; for r in $RESOLVED; do case " $MINE " in *" $r "*) hit=1 ;; esac; done
    [ $hit = 1 ] || warn "$NAME resolves to $RESOLVED but this server's addresses are $MINE (fine behind 1:1 NAT, e.g. a cloud provider's public IP)"
  fi
fi
CERT_RC=0
# the firewall: ufw on, open only ssh + what the trunk needs (443; 80 for Let's Encrypt; a website's 80/443).
# A server where OTHER services listen publicly keeps its firewall as it is (they would be cut off) — said
# loudly, with what to do. --no-firewall: leave it alone (remembered).
FW_RULES=$(confget FIREWALL_RULES)   # the rules trunk.sh added (--uninstall takes them away again)
FW_STATE=off
fw_has() { ufw show added 2>/dev/null | grep -Eq "^ufw (allow|limit) $1( |\$)"; }
fw_allow() { # RULE COMMENT [mine] — allow RULE (443/tcp) unless an equal rule exists; "mine": --uninstall removes it
  fw_has "$1" && return 0
  # (no apostrophe in a ufw comment: ufw refuses the whole rule)
  if ufw allow "$1" comment "$2" >/dev/null; then
    say "firewall: allow $1 ($2)"
    if [ "${3:-}" = mine ]; then case " $FW_RULES " in *" $1 "*) ;; *) FW_RULES="${FW_RULES:+$FW_RULES }$1" ;; esac; fi
  else warn "ufw would not open $1 — open it yourself"; fi
  return 0
}
listeners() { # every public (not loopback) listening socket: "tcp 22 sshd" lines
  ss -Hlntup 2>/dev/null | awk '{ a = $5; p = a; sub(/.*:/, "", p); sub(/:[^:]*$/, "", a)
      if (a ~ /^(127\.|\[::1\]|\[::ffff:127\.)/ || a ~ /%lo$/) next
      n = "?"; if (match($0, /users:\(\("[^"]*"/)) n = substr($0, RSTART + 9, RLENGTH - 10)
      print $1, p, n }' | sort -u
}
if [ "$FIREWALL" = 1 ]; then
  SSH_PORTS=" 22 "   # 22 always, every port sshd listens on, and the one this session came in on
  while read -r proto p n; do
    if [ "$proto" = tcp ]; then case $n/$SSH_PORTS in sshd*/*" $p "*) ;; sshd*) SSH_PORTS="$SSH_PORTS$p " ;; esac; fi
  done < <(listeners)
  sp=$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $4}')
  if [ -n "$sp" ]; then case $SSH_PORTS in *" $sp "*) ;; *) SSH_PORTS="$SSH_PORTS$sp " ;; esac; fi
  WEB=''   # who serves 80/443 here besides us (a website: it stays reachable)
  OTHER=''
  while read -r proto p n; do
    case $proto/$p in udp/68|udp/546) continue ;; esac            # DHCP replies: ufw lets them in already
    if [ "$proto" = tcp ]; then case $SSH_PORTS in *" $p "*) continue ;; esac; fi
    case $n in bifrost-net) continue ;; esac                      # the trunk itself
    if [ "$proto" = tcp ] && { [ "$p" = 80 ] || [ "$p" = 443 ]; }; then WEB="$WEB $p"; continue; fi
    OTHER="$OTHER $proto/$p($n)"
  done < <(listeners)
  if ufw status 2>/dev/null | grep -q '^Status: active'; then FW_STATE=active
  elif [ -n "$OTHER" ]; then
    FW_STATE=skipped
    warn "firewall NOT turned on: other services listen here and would be cut off:$OTHER"
    warn "  open them first (sudo ufw allow PORT/tcp), then re-run — or keep it off for good: --no-firewall"
  else FW_STATE=enable; fi
  if [ "$FW_STATE" != skipped ]; then
    if [ "$FW_STATE" = enable ]; then for p in $SSH_PORTS; do fw_allow "$p/tcp" 'ssh: kept open by yggdrasil trunk'; done; fi
    if [ "$BEHIND" = 0 ]; then fw_allow "$PORT/tcp" 'yggdrasil trunk' mine
    else fw_allow 443/tcp 'https: the website and the yggdrasil trunk' mine; fi
    if [ "$CERTMODE" = acme ]; then fw_allow 80/tcp 'yggdrasil trunk: Lets Encrypt check' mine; fi
    for p in $WEB; do fw_allow "$p/tcp" 'the website on this server' mine; done
    if [ "$FW_STATE" = enable ]; then
      if ufw --force enable >/dev/null; then FW_STATE=on; say "firewall: on (ufw) — incoming: ssh ($(printf '%s' "$SSH_PORTS" | xargs)) and the rules above, nothing else"
      else warn "ufw would not turn on — the firewall stays off"; fi
    fi
  fi
fi
ensure_cert || CERT_RC=$?

# ---------------------------------------------------------------- 5. trunk.toml (C2) + systemd
EXTRA_TOML=''
for n in $EXTRA_NAMES; do EXTRA_TOML="$EXTRA_TOML\"$n\", "; done
EXTRA_TOML=${EXTRA_TOML%, }
[ -z "$EXTRA_TOML" ] && EXTRA_TOML='[]'
LISTEN_HTTP='' LISTEN_TLS='' PROXY_LINE='false' TRUSTED=''
if [ "$BEHIND" = 1 ]; then
  # phase 1: plain http on loopback; the proxy in front (Caddy/nginx) terminates TLS and forwards.
  # XFF is believed from the proxy's loopback address only (trusted_proxies).
  LISTEN_HTTP="127.0.0.1:$PORT"
  TRUSTED='["127.0.0.1/32", "::1/128"]'
else
  # phase 2: own TLS on :443 (SPKI pin); PROXY v1 off (no router in front)
  LISTEN_TLS="0.0.0.0:$PORT"
  [ -s /proc/net/if_inet6 ] && LISTEN_TLS="[::]:$PORT"
fi
# only the proxy's PROXY line when there is one: a v0.9-style sni router in front is not in v1's path
CERT_TOML=''
[ -n "$LISTEN_TLS" ] && CERT_TOML="cert_path = \"/run/yggdrasil-trunk/cert.pem\"
key_path  = \"/run/yggdrasil-trunk/key.pem\""
cat >"$TOML.new" <<TOML
# GENERATED by trunk.sh — the v1 trunk's config (CONTRACTS C2). No secrets: the kek and oauth secrets
# live in $ETC and are copied to /run/trunk by the service's ExecStartPre at each start.
public_url     = "$PUBLIC_URL"
extra_names    = [$EXTRA_TOML]
listen_http    = "$LISTEN_HTTP"
listen_tls     = "$LISTEN_TLS"
listen_ice     = ""                              # phase 2: "0.0.0.0:4479" (framed STUN / ICE-TCP)
proxy_protocol = $PROXY_LINE
trusted_proxies = $TRUSTED
db             = "$VAR/trunk.db"
state_dir      = "$VAR"
cred_dir       = "/run/trunk"
ctl_socket     = "/run/trunk/ctl.sock"
acme_webroot   = "$VAR/acme"
rp_id          = "veraldar.org"
origins        = ["$PUBLIC_URL"]
ice_owner_from = []
$CERT_TOML
[auth]
region_policy = "refresh"
TOML
chmod 644 "$TOML.new"
if [ -f "$TOML" ] && [ "$(sha256sum <"$TOML.new")" = "$(sha256sum <"$TOML")" ]; then rm -f "$TOML.new"
else mv -f "$TOML.new" "$TOML"; CHANGED=1; fi

# the units ---------------------------------------------------------------------------------------------
put_unit() { # path — content on stdin; marks CHANGED
  local tmp; tmp=$(mktemp); cat >"$tmp"; chmod 644 "$tmp"
  if [ -f "$1" ] && [ "$(sha256sum <"$tmp")" = "$(sha256sum <"$1")" ]; then rm -f "$tmp"; else mv -f "$tmp" "$1"; CHANGED=1; fi
}
# The kek (and any oauth secret) stays root-only on disk. At each start, a root-run ExecStartPre (+) copies
# what is in $ETC/cred into the service's own /run/trunk (tmpfs, 0700, owned by $STATIC_USER, gone when it
# stops) — what LoadCredential= does, but it also works where systemd 252 leaves credentials unreadable
# (Debian 12 in a container, FINDINGS.md:431).
# shellcheck disable=SC2016  # $$ and %% are systemd's escapes; the shell inside the unit expands them
PRE=$(printf '%s' "ExecStartPre=+/bin/sh -c 'd=\$RUNTIME_DIRECTORY; install -d -m 700 -o \$USER -g \$GROUP \$d/cred && for f in $KEK $ETC/cred/*; do [ -f \$f ] && install -m 400 -o \$USER -g \$GROUP \$f \$d/cred/\$(basename \$f); done'")
CERT_PRE=""
[ -n "$LISTEN_TLS" ] && CERT_PRE=$(printf '%s' "ExecStartPre=+/bin/sh -c 'd=\$RUNTIME_DIRECTORY; install -m 400 -o \$USER -g \$GROUP $KEY \$d/key.pem && install -m 444 $CERT \$d/cert.pem'")
put_unit "$UNIT_FILE" <<UNIT
# GENERATED by trunk.sh. The v1 trunk: accounts, devices, roots, the relay to your roots.
[Unit]
Description=yggdrasil trunk — accounts, devices and roots ($NAME)
After=network-online.target
Wants=network-online.target

[Service]
$PRE
$CERT_PRE
ExecStart=$BIN trunk -c $TOML
User=$STATIC_USER
Group=$STATIC_USER
RuntimeDirectory=yggdrasil-trunk
RuntimeDirectoryMode=0700
StateDirectory=yggdrasil-trunk
ReadWritePaths=/var/lib/yggdrasil-trunk
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
# trunk-ctl: the console client (root only; dispatches on argv[0])
if ! { [ -f "$CTL" ] && [ "$(sha256sum <"$BIN")" = "$(sha256sum <"$CTL")" ]; }; then
  install -m 755 "$BIN" "$CTL.new" && mv -f "$CTL.new" "$CTL"
fi
# this script, for the timers (they read trunk.conf): the release's own trunk.sh, checked against its signed
# SHA256SUMS (this file when it is that one, else the release's copy) — never an OLDER release's
SELF_SRC=$0
if [ -n "$REL_DIR" ] && [ -n "$(sum_of trunk.sh)" ] && [ "$(sha256sum <"$0" | cut -c1-64)" != "$(sum_of trunk.sh)" ]; then
  release_get "$BASE" trunk.sh "$REL_DIR/trunk.sh"; SELF_SRC=$REL_DIR/trunk.sh
fi
SELFV=$(sed -n "s/^YGG_RELEASE='\(.*\)'\$/\1/p" "$SELF" 2>/dev/null | head -1 || true)
NEWSELFV=$(sed -n "s/^YGG_RELEASE='\(.*\)'\$/\1/p" "$SELF_SRC" | head -1 || true)
if ! { [ -f "$SELF" ] && [ "$(sha256sum <"$SELF_SRC")" = "$(sha256sum <"$SELF")" ]; }; then
  if [ -n "$SELFV" ] && { [ -z "$NEWSELFV" ] || newer "$SELFV" "$NEWSELFV"; }; then
    say "kept $SELF (release $SELFV, newer than ${NEWSELFV:-a checkout copy})"
  else install -m 755 "$SELF_SRC" "$SELF"; fi
fi
# weekly: a newer signed release, if there is one (trunk.sh --update: the same checks as by hand)
if [ "$AUTOUPD" = 1 ] && [ "$SOURCE" = release ]; then
  put_unit /etc/systemd/system/yggdrasil-trunk-update.service <<UNIT
[Unit]
Description=update the yggdrasil trunk ($NAME) to a newer SIGNED release, if there is one
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=$SELF --update
UNIT
  put_unit /etc/systemd/system/yggdrasil-trunk-update.timer <<UNIT
[Unit]
Description=weekly: update the yggdrasil trunk to a newer signed release
[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
fi
if [ "$CERTMODE" = acme ]; then
  put_unit /etc/systemd/system/yggdrasil-trunk-cert.service <<UNIT
[Unit]
Description=renew the yggdrasil trunk certificate ($NAME) with the same key, when due
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=$SELF --renew
UNIT
  put_unit /etc/systemd/system/yggdrasil-trunk-cert.timer <<UNIT
[Unit]
Description=daily: renew the yggdrasil trunk certificate when a third of its life is left
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
fi

# ------------------------------------------------------------------- 6. settings, then start
cat >"$CONF.new" <<EOF
# GENERATED by trunk.sh — what you chose; re-runs read it. No secrets.
NAME=$NAME
PORT=$PORT
BEHIND_PROXY=$BEHIND
EXTRA_NAMES=$EXTRA_NAMES
CERT=$CERTMODE
WEBROOT=$WEBROOT
EMAIL=$EMAIL
ACME_SERVER=$ACME
CA_BUNDLE=$CA_BUNDLE
BINARY=$GOTVER
SOURCE=$SOURCE
RELEASES=$( [ "$RELEASES" = https://github.com/veraldar/yggdrasil/releases ] || printf '%s' "$RELEASES")
FIREWALL=$FIREWALL
FIREWALL_RULES=$FW_RULES
AUTO_UPDATES=$AUTOUPD
EOF
chmod 644 "$CONF.new"; mv -f "$CONF.new" "$CONF"
systemctl daemon-reload
systemctl enable --quiet $UNIT
if [ $OURS = 0 ] || [ $CHANGED = 1 ]; then systemctl restart $UNIT; say "started $UNIT"; else say "running $UNIT (unchanged)"; fi
if [ "$CERTMODE" = acme ]; then systemctl enable --quiet --now yggdrasil-trunk-cert.timer
else systemctl disable --quiet --now yggdrasil-trunk-cert.timer 2>/dev/null || true; fi
# automatic updates: Debian's security updates (unattended-upgrades) + the weekly signed trunk update
if [ "$AUTOUPD" = 1 ]; then
  AU=/etc/apt/apt.conf.d/20auto-upgrades
  if ! grep -qs '^APT::Periodic::Unattended-Upgrade "1";' "$AU" || ! grep -qs '^APT::Periodic::Update-Package-Lists "1";' "$AU"; then
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >"$AU"
  fi
  systemctl enable --quiet --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || warn "could not enable apt's daily timers"
  if [ "$SOURCE" = release ]; then systemctl enable --quiet --now yggdrasil-trunk-update.timer
  else systemctl disable --quiet --now yggdrasil-trunk-update.timer 2>/dev/null || true; fi
  say "updates: security updates daily (unattended-upgrades)$( [ "$SOURCE" = release ] && echo ", the trunk weekly (a newer signed release)")"
else
  systemctl disable --quiet --now yggdrasil-trunk-update.timer 2>/dev/null || true
fi

# the trunk answers on its port with THIS key (curl pins it)
code=$(probe_trunk)
if [ "$code" = 000 ]; then
  journalctl -u $UNIT -n 15 --no-pager -o cat >&2 || true
  if [ "$CHANGED" = 1 ] && rollback; then
    die "the trunk does not answer on 127.0.0.1:$PORT (log above) — the previous trunk is back and answering"
  fi
  die "the trunk does not answer on 127.0.0.1:$PORT (log above)"
fi
case $code in 200) STATE="answering" ;; *) STATE="answering (HTTP $code)" ;; esac
say "trunk:   $PUBLIC_URL  $STATE"
say "pin:     $(pin_of_key)"

# ----------------------------------------------------------------------------------- the end
line() { printf '%s\n' "────────────────────────────────────────────────────────────────────────────────"; }
echo
if [ "$BEHIND" = 1 ]; then
  line
  cat <<EOF
 :443 is your website's (the proxy in front). Send the name $NAME to the trunk — pick ONE:

 A) Caddy already on :443 — add this site to your Caddyfile:

    $NAME {
        reverse_proxy 127.0.0.1:$PORT
    }

    then: sudo systemctl reload caddy
    (the trunk also serves /.well-known/acme-challenge/ itself: certbot --webroot $VAR/acme works unchanged)

 B) nginx already on :443 — a server block per name (TLS terminated there, plain http to the trunk):

    server {
        listen 443 ssl; $V6_443
        server_name $NAME;
        ssl_certificate /etc/nginx/your-$NAME.crt;     # your certificate for $NAME
        ssl_certificate_key /etc/nginx/your-$NAME.key;
        location / { proxy_pass http://127.0.0.1:$PORT; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; }
    }

    then: sudo nginx -t && sudo systemctl reload nginx
EOF
  line
fi
if [ $CERT_RC != 0 ]; then
  line
  echo " CERTIFICATE PENDING — phones will refuse $PUBLIC_URL until this is done:"
  echo
  printf '%s\n' "$ACME_HINT" | sed 's/^/ /'
  echo
  echo " The trunk already runs with a temporary certificate from the same key: roots can connect now"
  echo " (they pin the key, not the certificate) and need nothing new once the real one arrives."
  line
fi
line
cat <<EOF
 Your trunk is up: $PUBLIC_URL

 CLAIM IT (once, from anywhere): your admin account is created from this server.
  1. On this server:    sudo trunk-ctl claim-code
     It prints a 6-digit code (rotates every 5 minutes; lives only in /run/trunk/claim).
  2. On any device:     open  $SCHEME://$HOSTPORT/claim
     No agent here?     sudo trunk-ctl claim-link   prints the same link with the code in it.
  3. Enter the code → Approve & create admin → email + password + 2FA (or a passkey).

 Then add your computers — the empty-trunk page at $PUBLIC_URL shows the one line per system:

     curl -fsSL $PUBLIC_URL/install/root.sh | bash        Linux, WSL2, macOS

 Add a name:   sudo bash trunk.sh --add-name ap.example.org
 Update:       sudo bash trunk.sh --update    (a major needs: --update --major)
 Remove:       sudo bash trunk.sh --uninstall
EOF
line
exit 0
