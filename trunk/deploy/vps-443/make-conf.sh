#!/usr/bin/env bash
# make-conf.sh AP_NAME VPS_IP [ICE_PORT] [AP_PORT] [SITE_PORT] — print the VPS's sni-443.conf
#   AP_NAME    the trunk's TLS name (the access point's certificate)
#   VPS_IP     the address coturn listens on (TURN over TCP keeps going there)
#   ICE_PORT   the ap's raw livekit-ice forward (ap.toml [[ap.tcp]] listen), default 4479
#   AP_PORT    the ap's TLS listener (ap.toml listen), default 4443
#   SITE_PORT  caddy's https, default 8443
set -euo pipefail
[ $# -ge 2 ] || { sed -n '2,7s/^# \{0,1\}//p' "$0" >&2; exit 64; }
HERE=$(cd "$(dirname "$0")" && pwd)
AP_NAME=$1 VPS_IP=$2 ICE_PORT=${3:-4479} AP_PORT=${4:-4443} SITE_PORT=${5:-8443}
case $AP_NAME in *[!A-Za-z0-9.-]*|'') echo "AP_NAME: a DNS name" >&2; exit 64 ;; esac
case $VPS_IP in *[!0-9.]*|'') echo "VPS_IP: an IPv4 address" >&2; exit 64 ;; esac
for p in "$ICE_PORT" "$AP_PORT" "$SITE_PORT"; do case $p in *[!0-9]*|'') echo "ports: numbers" >&2; exit 64 ;; esac; done
sed -e "s/@AP_NAME@/$AP_NAME/g" -e "s/@VPS_IP@/$VPS_IP/g" -e "s/@ICE_PORT@/$ICE_PORT/g" \
    -e "s/@AP_PORT@/$AP_PORT/g" -e "s/@SITE_PORT@/$SITE_PORT/g" "$HERE/sni-443.conf.in"
