#!/usr/bin/env bash
# wsl-bootstrap.sh — the Linux half of Veraldar-Setup.exe. The installer runs it inside WSL, hidden (no terminal:
# nothing here asks anything), and reads what it writes into the install folder on the Windows side
# (OUT: %LOCALAPPDATA%\Veraldar as WSL sees it, e.g. /mnt/c/Users/me/AppData/Local/Veraldar).
#
#   wsl-bootstrap.sh --setup --out OUT [--user NAME] [--win-user NAME]               as root (wsl -u root)
#       the Linux user the root runs as: NAME (the distribution's own default user), else one named after the
#       Windows user, made without a password (wsl -u starts it; nothing to type). Then what join.sh needs —
#       curl, python3, openssh-client, ca-certificates — with apt-get. Writes OUT/setup.ini: user=, made=, result=
#   wsl-bootstrap.sh --hub URL --name NAME --out OUT [-- more join.sh options]         as that user
#       runs join.sh — the stamped one the installer embeds beside this script: it fetches the signed release and
#       checks it (signature + sha256) itself — and keeps OUT/status.ini current for the installer's window:
#         state=prepare | code (code=, qr=join-qr.bmp) | done | fail (step=W-…, why=the last error line)
#       Exit: join.sh's (0 joined and running, 3 refused, 4 expired, 64 usage, 1 other), 5 joined but the root
#       does not answer (W-RUN).
#   wsl-bootstrap.sh --cancel           stop the join started above (the installer's Cancel, or its time limit)
#   wsl-bootstrap.sh --mask             stdin to stdout with key/token-like strings masked
#   wsl-bootstrap.sh --png2bmp PNG BMP [PX]   the QR picture as a BMP, about PX pixels (the installer shows BMP)
#
# Logs: ~/.local/state/veraldar/bootstrap.log (everything, inside WSL) and OUT/setup.log (masked; the installer's
# install-report.txt quotes its last lines). Tests only: VERALDAR_JOIN_SH (another join.sh), VERALDAR_PROBE_SECS.
set -euo pipefail
umask 077

HERE=$(cd "$(dirname "$0")" && pwd)
MODE=join HUB='' NAME='' OUT='' S_USER='' S_WINUSER=''
while [ $# -gt 0 ]; do
  case $1 in
    --setup) MODE=setup ;;
    --cancel) MODE=cancel ;;
    --mask) MODE=mask ;;
    --png2bmp) MODE=png2bmp; shift; break ;;
    --hub) HUB=${2:?}; shift ;;
    --name) NAME=${2:?}; shift ;;
    --out) OUT=${2:?}; shift ;;
    --user) S_USER=${2:?}; shift ;;
    --win-user) S_WINUSER=${2:-}; shift ;;
    --) shift; break ;;
    *) echo "wsl-bootstrap: unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

# ------------------------------------------------------------------------------------------- masking
# Before anything reaches the Windows side: the terminal QR (coloured blocks) and ANSI colours out, plain ASCII
# (the report is read with the Windows code page); sk-… keys, *KEY/*TOKEN/*SECRET/*PASSWORD values, and long
# runs that look random (24+ base64url/hex characters with letters and digits; 40+ of standard base64) become
# ***. Path and URL segments that are plain words stay readable.
mask() {
  perl -CSD -pe 'BEGIN { $| = 1; $SIG{__WARN__} = sub {} }
    sub rnd { my $s = shift; length($s) >= 24 && $s =~ /[0-9]/ && $s =~ /[A-Za-z]/ }
    if (/\e\[[0-9;]*(?:4[0-7]|10[0-7])[;m]/ || /[\x{2580}-\x{259F}]/) { $_ = ""; next }
    s/\r//g; s/\e\[[0-9;?]*[A-Za-z]//g;
    s/[\x{2010}-\x{2015}\x{2212}]/-/g; s/[\x{2018}\x{2019}]/\x27/g; s/[\x{201C}\x{201D}]/"/g;
    s/\x{2026}/.../g; s/\x{00B7}/-/g; s/\x{2192}/->/g; s/[^\x09\x0a\x20-\x7e]/?/g;
    s/\b(sk-)[A-Za-z0-9_-]{4,}/$1***/g;
    s/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\*\*\*)\S+/$1$2***/gi;
    s{[A-Za-z0-9_+/=-]{24,}}{
      my $r = $&;
      ($r !~ m{^/} && length($r) >= 40 && $r =~ /[A-Z]/ && $r =~ /[a-z]/ && $r =~ /[0-9]/ && $r =~ m{[+/]})
        ? "***" : join("/", map { rnd($_) ? "***" : $_ } split(m{/}, $r, -1))
    }ge;'
}
[ "$MODE" = mask ] && { mask; exit 0; }

# ------------------------------------------------------------------------------------- PNG -> BMP
# join.sh writes the QR as PNG (its own encoder, or qrencode's); a Windows static control shows BMP. Read the
# modules back (any PNG colour type / bit depth, non-interlaced), write them again at a size that fits the window.
png2bmp() { # PNG BMP [PX]
  python3 -I - "$@" <<'PY'
import struct, sys, zlib
src, dst = sys.argv[1], sys.argv[2]
target = int(sys.argv[3]) if len(sys.argv) > 3 else 200
data = open(src, "rb").read()
if data[:8] != b"\x89PNG\r\n\x1a\n":
    sys.exit("not a PNG")
pos, idat, plte, trns = 8, b"", b"", b""
while pos < len(data):
    n, kind = struct.unpack(">I4s", data[pos:pos + 8])
    body = data[pos + 8:pos + 8 + n]
    pos += 12 + n
    if kind == b"IHDR":
        w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
    elif kind == b"PLTE":
        plte = body
    elif kind == b"tRNS":
        trns = body
    elif kind == b"IDAT":
        idat += body
    elif kind == b"IEND":
        break
if interlace:
    sys.exit("interlaced PNG")
chans = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
bpp = max(1, chans * depth // 8)
stride = (w * chans * depth + 7) // 8
raw = zlib.decompress(idat)
rows, prev, i = [], bytearray(stride), 0
for _ in range(h):
    f, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
    i += 1 + stride
    for x in range(stride):
        a = line[x - bpp] if x >= bpp else 0
        b = prev[x]
        c = prev[x - bpp] if x >= bpp else 0
        if f == 1:
            line[x] = (line[x] + a) & 255
        elif f == 2:
            line[x] = (line[x] + b) & 255
        elif f == 3:
            line[x] = (line[x] + (a + b) // 2) & 255
        elif f == 4:
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(line)
    prev = line


def dark(x, y):
    line = rows[y]
    if depth < 8:
        per = 8 // depth
        v = (line[x // per] >> (8 - depth * (x % per + 1))) & ((1 << depth) - 1)
        if ctype == 3:
            if v < len(trns) and trns[v] < 128:
                return False
            return sum(plte[3 * v:3 * v + 3]) < 384
        return v < (1 << depth) // 2
    step = depth // 8
    o = x * chans * step
    s = [line[o + k * step] for k in range(chans)]
    if ctype == 3:
        if s[0] < len(trns) and trns[s[0]] < 128:
            return False
        return sum(plte[3 * s[0]:3 * s[0] + 3]) < 384
    if ctype in (4, 6) and s[-1] < 128:
        return False
    return (s[0] if ctype in (0, 4) else sum(s[:3]) / 3) < 128


ys = [y for y in range(h) if any(dark(x, y) for x in range(w))]
if not ys:
    sys.exit("no QR in the PNG")
y0, y1 = ys[0], ys[-1]
xs = [x for x in range(w) if any(dark(x, y) for y in (y0, y0 + 1, y1))]
x0, x1 = xs[0], xs[-1]
run = 0
while x0 + run < w and dark(x0 + run, y0):
    run += 1
mod = run / 7.0                       # the finder pattern's top edge: 7 modules
n = int(round((x1 - x0 + 1) / mod))
if n < 21 or (n - 17) % 4:
    sys.exit("not a QR code (%d modules)" % n)
m = [[dark(int(x0 + (c + 0.5) * mod), int(y0 + (r + 0.5) * mod)) for c in range(n)] for r in range(n)]
border = 3
s = max(2, target // (n + 2 * border))
side = (n + 2 * border) * s
rowlen = (side * 3 + 3) & ~3
pix = bytearray()
for Y in range(side - 1, -1, -1):     # BMP rows go bottom-up
    my = Y // s - border
    row = bytearray()
    for X in range(side):
        mx = X // s - border
        row += b"\x00\x00\x00" if 0 <= mx < n and 0 <= my < n and m[my][mx] else b"\xff\xff\xff"
    pix += row + b"\x00" * (rowlen - len(row))
head = struct.pack("<2sIHHI", b"BM", 54 + len(pix), 0, 0, 54)
head += struct.pack("<IiiHHIIiiII", 40, side, side, 1, 24, 0, len(pix), 2835, 2835, 0, 0)
with open(dst + ".tmp", "wb") as f:
    f.write(head + pix)
import os
os.replace(dst + ".tmp", dst)
PY
}
[ "$MODE" = png2bmp ] && { png2bmp "$@"; exit $?; }

STATE=$HOME/.local/state/veraldar
mkdir -p "$STATE"
LOG=$STATE/bootstrap.log
note() { # a line of ours: the full log, and (masked) the installer's setup.log
  printf '%s\n' "$*" >>"$LOG" 2>/dev/null || true
  [ -z "$OUT" ] || printf '%s\n' "$*" | mask | sed 's/$/\r/' >>"$OUT/setup.log" 2>/dev/null || true
}

# ------------------------------------------------------------------------------------------- cancel
if [ "$MODE" = cancel ]; then
  p=$(cat "$STATE/join.pid" 2>/dev/null || true)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true   # its process group: join.sh too
    note "[bootstrap] cancelled by the installer (pid $p)"
  fi
  rm -f "$STATE/join.pid"
  exit 0
fi

# the installer runs this IN its folder (wsl.exe --cd) with --out . : made absolute here (no path ever goes back
# to Windows — a user name with non-ASCII letters would not survive the trip)
if [ -n "$OUT" ] && [ -d "$OUT" ]; then OUT=$(cd "$OUT" && pwd); fi
[ -n "$OUT" ] && [ -d "$OUT" ] || { echo "wsl-bootstrap: --out DIR (the install folder, as WSL sees it) is needed" >&2; exit 64; }

# ------------------------------------------------------------------------------------- setup (root)
ini() { # FILE SECTION KEY=VALUE... — written whole, CRLF (Windows reads it with GetPrivateProfileString). The rename
  #       is tried a few times: Windows may hold the file open for a moment while the installer reads it
  local f=$1 sec=$2 kv i
  shift 2
  { printf '[%s]\r\n' "$sec"; for kv in "$@"; do printf '%s\r\n' "${kv//[$'\r\n']/ }"; done; } >"$f.tmp.$$" || return 1
  for i in 1 2 3 4 5 6 7 8 9 10; do mv -f "$f.tmp.$$" "$f" 2>/dev/null && return 0; sleep 0.2; done
  rm -f "$f.tmp.$$"; return 1
}
if [ "$MODE" = setup ]; then
  [ "$(id -u)" = 0 ] || { echo "wsl-bootstrap --setup runs as root (wsl -u root)" >&2; exit 64; }
  user=$S_USER made=0
  if [ -z "$user" ]; then # the Windows user's name, as a Linux user name; else "veraldar"
    user=$(printf '%s' "$S_WINUSER" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -cd 'a-z0-9_-' | cut -c1-32)
    case $user in [a-z]*) ;; *) user=veraldar ;; esac
    u=$(id -u "$user" 2>/dev/null || true)
    if [ -n "$u" ] && [ "$u" -lt 1000 ]; then user=veraldar; fi   # a system account: not that one
  fi
  if ! id -u "$user" >/dev/null 2>&1; then
    uid=(); getent passwd 1000 >/dev/null || uid=(-u 1000)   # 1000: what Ubuntu's own first run would make
    if ! useradd -m -s /bin/bash ${uid[@]+"${uid[@]}"} "$user" >>"$LOG" 2>&1; then
      note "[setup] could not make the Linux user $user"
      ini "$OUT/setup.ini" setup "user=$user" "made=0" "result=fail" "why=could not make the Linux user $user"
      exit 1
    fi
    made=1
    note "[setup] made the Linux user $user (no password: WSL starts it without one)"
    # WSL starts this user by default from now on (unless the distribution already names one)
    grep -qs '^\[user\]' /etc/wsl.conf || printf '\n[user]\ndefault=%s\n' "$user" >>/etc/wsl.conf
  fi
  missing=()
  command -v curl >/dev/null || missing+=(curl)
  python3 -c 'import ssl, json, urllib.request, zlib, fcntl' 2>/dev/null || missing+=(python3)
  command -v ssh-keygen >/dev/null || missing+=(openssh-client)
  [ -s /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  if [ ${#missing[@]} -gt 0 ]; then
    note "[setup] installing ${missing[*]} (apt-get)"
    if ! command -v apt-get >/dev/null; then
      ini "$OUT/setup.ini" setup "user=$user" "made=$made" "result=fail" "why=no apt-get to install ${missing[*]}"
      exit 1
    fi
    export DEBIAN_FRONTEND=noninteractive
    rc=0
    { apt-get -o DPkg::Lock::Timeout=300 update -q && \
      apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends "${missing[@]}"; } 2>&1 \
      | tee -a "$LOG" | mask | grep -v 'Reading database' | tail -n 20 | sed 's/$/\r/' >>"$OUT/setup.log" || rc=$?
    if [ $rc != 0 ]; then
      note "[setup] apt-get could not install ${missing[*]}"
      ini "$OUT/setup.ini" setup "user=$user" "made=$made" "result=fail" "why=apt-get could not install ${missing[*]}"
      exit 1
    fi
  fi
  # does this user's root already have its model? (then the installer does not ask — join.sh keeps it, as on Linux)
  model=0; home=$(getent passwd "$user" | cut -d: -f6)
  grep -qs '^YGG_UPSTREAM_BASE_URL=.' "${home:-/nonexistent}/.local/share/yggdrasil-root/brain.env" && model=1
  note "[setup] Linux user $user; curl, python3, openssh-client, ca-certificates present; model already set: $model"
  ini "$OUT/setup.ini" setup "user=$user" "made=$made" "result=ok" "why=" "model=$model"
  exit 0
fi

# ------------------------------------------------------------------------------------------- join
# its own process group, so --cancel stops join.sh and everything it started for the join (not the root's
# services: join.sh starts those in a session of their own)
if [ -z "${VERALDAR_PGRP:-}" ] && command -v setsid >/dev/null; then
  export VERALDAR_PGRP=1
  exec setsid -w "$BASH" "$0" --hub "$HUB" --name "$NAME" --out "$OUT" -- "$@"
fi
echo $$ >"$STATE/join.pid"
HUB=$(printf '%s' "$HUB" | tr -d '\r\n\t ')
JOIN=${VERALDAR_JOIN_SH:-$HERE/join.sh}
PROBE_SECS=${VERALDAR_PROBE_SECS:-30}
S_STATE=prepare S_CODE='' S_QR='' S_STEP='' S_WHY='' S_RC=''
status() { ini "$OUT/status.ini" join "state=$S_STATE" "code=$S_CODE" "qr=$S_QR" "name=$NAME" "step=$S_STEP" "why=$S_WHY" "rc=$S_RC"; }
finish() { # RC STATE STEP WHY
  S_RC=$1 S_STATE=$2 S_STEP=$3 S_WHY=$(printf '%s' "$4" | mask | cut -c1-200)
  note "[bootstrap] result: ${S_STEP:-ok} (exit $1)${S_WHY:+ — $S_WHY}"
  status
  rm -f "$STATE/join.pid" ${UP_FILE:+"$UP_FILE"}
  exit "$1"
}
rm -f "$OUT/join-qr.bmp" "$STATE/join-qr.png"
status
# shellcheck disable=SC1091
note "---- $(date '+%F %T') wsl-bootstrap: hub $HUB, name $NAME, $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}"), kernel $(uname -r)"
[ -n "$HUB" ] && [ -n "$NAME" ] || finish 64 fail W-JOIN "no trunk address or name given"
[ -f "$JOIN" ] || finish 1 fail W-JOIN "the installer has no join.sh beside wsl-bootstrap.sh"

# THE MODEL — kept in this one place (decision L15: asked when the PC is installed, as on Linux). The installer's
# model page writes OUT/upstream.env (YGG_UPSTREAM_* lines) when this root has none yet (setup.ini model=0); it moves
# inside WSL (mode 600; the Windows copy is removed at once) and goes to join.sh as --upstream-env. Else nothing:
# join.sh keeps the model this root already has, or stops ("no model upstream": W-MODEL).
UP_FILE=''
# the model file inside WSL goes on every way out — also when the installer's Cancel or time limit kills the group
trap 'rm -f "$STATE/join.pid" ${UP_FILE:+"$UP_FILE"}' EXIT
trap 'exit 143' TERM HUP INT
upstream_args() {
  [ -f "$OUT/upstream.env" ] || return 0
  UP_FILE=$(mktemp "$STATE/upstream.XXXXXX")
  cat "$OUT/upstream.env" >"$UP_FILE" && rm -f "$OUT/upstream.env"
  JARGS+=(--upstream-env "$UP_FILE")
}
JARGS=(--hub "$HUB" --name "$NAME" --qr-png "$STATE/join-qr.png")
upstream_args
DIR=$HOME/.local/share/yggdrasil-root
prev=''; for a in "$@"; do [ "$prev" = --dir ] && DIR=$a; prev=$a; done

RUNLOG=$STATE/join-run.log
: >"$RUNLOG"
watch_join() { # join.sh's lines (masked): to setup.log; the code + QR to status.ini as soon as they show
  local line c
  while IFS= read -r line; do
    printf '%s\r\n' "$line" >>"$OUT/setup.log"
    printf '%s\n' "$line" >>"$RUNLOG"
    case $line in
      *'Code (check it matches the phone):'*)
        c=${line##*:}; c=${c//[[:space:]]/}
        S_STATE=code S_CODE=$c S_QR=''
        if [ -s "$STATE/join-qr.png" ] && png2bmp "$STATE/join-qr.png" "$OUT/join-qr.bmp" "${VERALDAR_QR_PX:-215}" 2>>"$LOG"; then
          S_QR=join-qr.bmp
        fi
        status ;;
    esac
  done
}
set +e
bash "$JOIN" "${JARGS[@]}" "$@" </dev/null 2>&1 | tee -a "$LOG" | mask | watch_join
st=("${PIPESTATUS[@]}")
set -e
rc=${st[0]}

# what went wrong, from join.sh's exit code and its last error lines (join.sh die(): "xx  …", rootjoin: "rootjoin: …")
errs=$(grep -E '^(xx|rootjoin:|curl:)' "$RUNLOG" | tail -n 5 || true)
last=$(printf '%s\n' "$errs" | grep -E '^(xx|rootjoin:)' | tail -n 1 | sed -E 's/^(xx +|rootjoin: )//' || true)
case $rc in
  0) ;;
  3) finish 3 fail W-JOIN "refused on the phone" ;;
  4) finish 4 fail W-JOIN "the request expired before it was approved" ;;
  6) # joined, but "Same as the home root" brought no model (join.sh says why): the join is kept, Setup again picks one
     finish 6 fail W-MODEL "$(grep -E 'this root has no model yet' "$RUNLOG" | tail -n 1 | sed -E 's/^(!! +|xx +)//; s/^joined, but this root has no model yet: //' || true)" ;;
esac
if [ "$rc" != 0 ]; then
  case $errs in
    *'NOT signed by'*|*'has no signature'*|*'does not match SHA256SUMS'*|*'not the one release'*|*'holds another release'*)
      finish "$rc" fail W-SIG "$last" ;;
  esac
  case $errs in
    *'no model upstream'*) finish "$rc" fail W-MODEL "$last" ;;
    *'cannot download'*|*'cannot reach the hub'*|*'hub answered 404'*|*'hub answered 5'*|*'has no yggdrasil-'*|*'has no build for'*|*'curl: ('*)
      finish "$rc" fail W-NET "$last" ;;
    *'python3 (with ssl) is needed'*|*'glibc'*|*'MB are free'*|*'fetching and checking the release needs'*|*'cannot start:'*)
      finish "$rc" fail W-WSL "$last" ;;
  esac
  finish "$rc" fail W-JOIN "${last:-join.sh stopped (exit $rc)}"
fi

# joined: is the root up? (join.sh started it; give it a little longer, and start it again once if it is not)
probe() {
  local port i
  port=$(sed -n 's/^BRAIN_PORT=//p' "$DIR/root.conf" 2>/dev/null | tail -n 1)
  [ -n "$port" ] || return 1
  for i in $(seq 1 "$1"); do
    curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$port/root" 2>/dev/null && return 0
    [ "$i" = "$1" ] || sleep 1
  done
  return 1
}
if ! probe "$PROBE_SECS"; then
  [ -x "$DIR/bin/start" ] && "$DIR/bin/start" >>"$LOG" 2>&1 || true
  probe "$PROBE_SECS" || finish 5 fail W-RUN "joined, but the root's brain does not answer on 127.0.0.1"
fi
finish 0 'done' '' ''
