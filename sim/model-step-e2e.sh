#!/usr/bin/env bash
# model-step-e2e.sh — proves root/install/model-step.sh (install.sh --brain-only) end to end,
# one fresh debian:12 container per case, against the fake upstream msm-upstream (own CA,
# HTTPS 443 for api.z.ai openrouter.ai api.anthropic.com api.openai.com other.tree.test;
# http 8080 for a model on your own network). No real provider is called: those five names
# resolve (docker --add-host) to msm-upstream inside every case container. Made-up keys only.
# Verdict table + exit 0 only when all cases pass. Run under: bash sim/model-step-e2e.sh
set -u
cd "$(dirname "$0")/.."           # the repo (worktree) root
ROOT=$PWD
HERE=$ROOT/sim/model-step
DIST=$HOME/.cache/p4-rig/ms-dist/0.9.1-rc.2          # the TEST release under test (prebuilt)
STATE=$HOME/.cache/p4-msmatrix/run; rm -rf "$STATE"; mkdir -p "$STATE/log"
LOG=$STATE/log/run.log; : >"$LOG"
NET=msm-net; UP=msm-upstream; VER=0.9.1-rc.2
HU=lay; HH=/home/lay; ENVF=$HH/.config/yggdrasil/yggdrasil.env
NAMES="api.z.ai openrouter.ai api.anthropic.com api.openai.com other.tree.test"
FAIL=0; declare -a ROWS
say()  { printf '\033[1m==>\033[0m %s\n' "$*" | tee -a "$LOG"; }

# ---------------------------------------------------------------- the run's CA + fake upstream
say "building the upstream image (CA for $NAMES, mock on :443 and :8080)"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$STATE/ca.key" -out "$STATE/ca.pem" -days 2 \
  -subj "/CN=msm test CA" 2>>"$LOG"
# a CA the hosts' certs chain to: make a CA, then a leaf with SANs
openssl req -newkey rsa:2048 -nodes -keyout "$STATE/leaf.key" -out "$STATE/leaf.csr" \
  -subj "/CN=msm-upstream" 2>>"$LOG"
printf "subjectAltName=DNS:msm-upstream,DNS:api.z.ai,DNS:openrouter.ai,DNS:api.anthropic.com,DNS:api.openai.com,DNS:other.tree.test\n" \
  >"$STATE/san.ext"
openssl x509 -req -in "$STATE/leaf.csr" -CA "$STATE/ca.pem" -CAkey "$STATE/ca.key" -CAcreateserial \
  -out "$STATE/leaf.pem" -days 2 -extfile "$STATE/san.ext" 2>>"$LOG"
mkdir -p "$STATE/up"
cp "$HERE/msm_upstream.py" "$STATE/leaf.pem" "$STATE/leaf.key" "$STATE/up/"
docker rmi -f msm-upstream:latest >/dev/null 2>&1
cat >"$STATE/up/Dockerfile" <<'EOF'
FROM python:3.12-slim
COPY msm_upstream.py /up/msm_upstream.py
COPY leaf.pem leaf.key /up/
CMD python3 /up/msm_upstream.py 8080 /up/http.log & python3 /up/msm_upstream.py 443 /up/https.log /up/leaf.pem /up/leaf.key & wait
EOF
( cd "$STATE/up" && nice -n 10 docker build -q -t msm-upstream:latest . ) >/dev/null 2>>"$LOG" || { echo "docker build failed"; cat "$LOG"; exit 1; }

docker network rm "$NET" >/dev/null 2>&1
docker network create --subnet 172.28.7.0/24 "$NET" >/dev/null
AH=""; for n in $NAMES; do AH="$AH --add-host $n:172.28.7.9"; done
docker rm -f "$UP" >/dev/null 2>&1
docker run -d --name "$UP" --hostname msm-upstream --network "$NET" --ip 172.28.7.9 \
  -v "$STATE/up":/up msm-upstream:latest >/dev/null || { echo "upstream run failed"; exit 1; }
for i in $(seq 30); do docker exec "$UP" python3 -c "import socket;socket.create_connection(('127.0.0.1',8080))" 2>/dev/null && break; sleep 1; done
say "upstream up on msm-net (https 443 for the five names, http 8080)"

uplog() { docker exec "$UP" cat /up/https.log /up/http.log 2>/dev/null; }

# ---------------------------------------------------------------- a fresh container per case
say "prebaking the case image (debian:12 + what install.sh asks for)"
docker rmi -f msm-case:latest >/dev/null 2>&1
nice -n 10 docker build -q -t msm-case:latest - >/dev/null <<'EOF'
FROM debian:12
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    curl ca-certificates openssh-client procps python3 && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash lay
EOF
mkcase() { # NAME — debian:12, the CA trusted, a normal user, the release unpacked in ~lay
  local c=msm-$1
  docker rm -f "$c" >/dev/null 2>&1
  docker run -d --name "$c" --hostname "$c" --network "$NET" $AH msm-case:latest sleep infinity >/dev/null
  docker cp "$STATE/ca.pem" "$c":/usr/local/share/ca-certificates/msm-test-ca.crt >/dev/null
  docker exec "$c" update-ca-certificates >>"$LOG" 2>&1
  docker exec "$c" mkdir -p /rel && docker cp "$DIST/yggdrasil-$VER-linux-x86_64.tar.gz" "$c":/rel/ >/dev/null
  docker exec -u "$HU" -w "$HH" "$c" bash -c "tar -xzf /rel/yggdrasil-$VER-linux-x86_64.tar.gz --no-same-owner"
}

# drive the terminal install on a pty, as the user, inside the container
typed() { # NAME ENVSTRING LOGOUT — runs install.sh --brain-only --now via drive_install.py
  # on a pty, typing the answers; the transcript is written INSIDE the container and copied
  # out after (streaming the pty over the docker-exec channel wedges now and then)
  docker cp "$HERE/drive_install.py" msm-"$1":/tmp/drive_install.py >/dev/null
  docker exec -d -u "$HU" -e HOME=$HH -e MSM_INPUTS="$2" -e TRANSCRIPT=/tmp/transcript -e DONEFILE=/tmp/drive.done \
    msm-"$1" python3 /tmp/drive_install.py bash -c "cd ~/yggdrasil-$VER/root/install && bash install.sh --brain-only --now"
  for i in $(seq 120); do docker exec -u "$HU" msm-"$1" test -e /tmp/drive.done >/dev/null 2>&1 && break; sleep 2; done
  docker cp msm-"$1":/tmp/transcript "$STATE/log/$3" >/dev/null 2>&1
  docker exec -u "$HU" msm-"$1" rm -f /tmp/transcript /tmp/drive.done /tmp/drive_install.py
}

# one model turn: start the brain with its env file, create a session, post a message
turn() { # NAME LOGOUT
  docker exec -u "$HU" msm-"$1" bash -c '
    set -e
    cd ~
    (setsid nohup env $(sed -n 's/^\([A-Z_]*\)=\(.*\)$/\1=\2/p' ~/.config/yggdrasil/yggdrasil.env | xargs) \
       ~/.local/bin/yggdrasil >brain.log 2>&1 </dev/null &)
    for i in $(seq 60); do curl -sf http://127.0.0.1:4096/session >/dev/null 2>&1 && break; sleep 0.5; done
    S=$(curl -sf -X POST http://127.0.0.1:4096/session -H "content-type: application/json" -d "{\"title\":\"msm\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"id\"])")
    curl -s -X POST http://127.0.0.1:4096/session/$S/message -H "content-type: application/json" \
      -d "{\"parts\":[{\"type\":\"text\",\"text\":\"say one word\"}]}" >reply.json
    for i in $(seq 100); do python3 -c "import json;d=json.load(open(\"reply.json\"));exit(0 if d.get(\"parts\") else 1)" 2>/dev/null && break; sleep 0.3; done
    echo TURN-DONE' >"$STATE/log/$2" 2>&1
}

# the checks every keyed case runs
sweep() { # NAME KEY — the key is only in the env file: mode 600, once, nowhere else
  local c=msm-$1 k=$2 out
  out=$(docker exec -u "$HU" "$c" bash -c "
    e=~/.config/yggdrasil/yggdrasil.env
    m=\$(stat -c %a \$e)
    n=\$(grep -c \"^\$1=\" /dev/null; grep -c '$k' \$e)
    hits=\$(grep -rl -- '$k' ~ /tmp 2>/dev/null | grep -v '^\$e\$' | tr '\n' ' ')
    echo \"mode=\$m inenv=\$n elsewhere=[\$hits]\"
    " 2>&1)
  docker logs "$c" >"$STATE/log/$c-docker.log" 2>&1
  if docker logs "$c" 2>&1 | grep -q "$k"; then out="$out dockerlogs=KEY-FOUND"; fi
  echo "$out"
}

# env-file expectations: URL STYLE MODEL (and KEY, or '' for none)
chk_env() { # NAME URL STYLE MODEL KEY
  docker exec -u "$HU" msm-"$1" bash -c '
    e=~/.config/yggdrasil/yggdrasil.env
    g() { sed -n "s/^$1=//p" $e | tail -1; }
    [ "$(g YGG_UPSTREAM_BASE_URL)" = "'"$2"'" ] && [ "$(g YGG_UPSTREAM_STYLE)" = "'"$3"'" ] &&
    [ "$(g YGG_UPSTREAM_MODEL)" = "'"$4"'" ] && [ "$(g YGG_UPSTREAM_API_KEY)" = "'"$5"'" ]' 2>&1
}

# menu check from a typed transcript: exact order, no "Same as the home root"
chk_menu() { # TRANSCRIPT
  grep -q '  1  Z AI' "$1" && grep -q '  2  OpenRouter' "$1" && grep -q '  3  Anthropic' "$1" &&
  grep -q '  4  OpenAI' "$1" && grep -q '  5  Other' "$1" && ! grep -q 'Same as the home root' "$1"
}

evidence() { # NAME KEY — the upstream log line for this case's container traffic (masked)
  local l; l=$(uplog | grep -v 'GET' | tail -50 | grep -m1 "${2:+$2}" || uplog | tail -1)
  l=$(uplog | tail -20 | grep "\"model\"" | tail -1)
  printf '%s' "${l//$2/<key>}"
}

row() { # NAME VERDICT EVIDENCE
  ROWS+=("$(printf '%-12s %-4s %s' "$1" "$2" "$3")")
  [ "$2" = PASS ] || FAIL=1
}

# ================================================================================= the cases
KZ=sk-test-zai-0123456789abcdef; KO=sk-or-test-0123456789abcdef; KA=sk-ant-test-0123456789abcdef
KW=sk-oai-test-0123456789abcdef; KX=sk-test-other-0123456789ab

say "case zai"
mkcase zai
typed zai "$(printf '1\n%s\n\n' "$KZ")" zai-install.log
if ! chk_menu "$STATE/log/zai-install.log"; then row zai FAIL "menu wrong in transcript"; else
turn zai zai-turn.log
ev=$(uplog | tail -5 | grep api.z.ai | grep glm-5.3-flash | head -1 | sed "s/$KZ/<key>/")
ok=1
chk_env zai https://api.z.ai/api/anthropic anthropic glm-5.3-flash "$KZ" >/dev/null || ok=0
sw=$(sweep zai "$KZ"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no api.z.ai line at the upstream)"; }
row zai $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"
fi

say "case zai-model"
mkcase zai-model
typed zai-model "$(printf '1\n%s\nglm-5.3\n' "$KZ")" zai-model-install.log
turn zai-model zai-model-turn.log
ev=$(uplog | tail -5 | grep api.z.ai | grep '"model": "glm-5.3"' | head -1 | sed "s/$KZ/<key>/")
ok=1
chk_env zai-model https://api.z.ai/api/anthropic anthropic glm-5.3 "$KZ" >/dev/null || ok=0
sw=$(sweep zai-model "$KZ"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no glm-5.3 line at the upstream)"; }
row zai-model $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case openrouter"
mkcase openrouter
typed openrouter "$(printf '2\n%s\n\n' "$KO")" openrouter-install.log
turn openrouter openrouter-turn.log
ev=$(uplog | tail -5 | grep openrouter.ai | grep gpt-4o-mini | head -1 | sed "s/$KO/<key>/")
ok=1
chk_env openrouter https://openrouter.ai/api/v1 openai openai/gpt-4o-mini "$KO" >/dev/null || ok=0
sw=$(sweep openrouter "$KO"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no openrouter.ai line at the upstream)"; }
row openrouter $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case anthropic"
mkcase anthropic
typed anthropic "$(printf '3\n%s\n\n' "$KA")" anthropic-install.log
turn anthropic anthropic-turn.log
ev=$(uplog | tail -5 | grep api.anthropic.com | grep claude-fable-5-2 | head -1 | sed "s/$KA/<key>/")
ok=1
chk_env anthropic https://api.anthropic.com anthropic claude-fable-5-2 "$KA" >/dev/null || ok=0
sw=$(sweep anthropic "$KA"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no api.anthropic.com line at the upstream)"; }
row anthropic $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case openai"
mkcase openai
typed openai "$(printf '4\n%s\n\n' "$KW")" openai-install.log
turn openai openai-turn.log
ev=$(uplog | tail -5 | grep api.openai.com | grep gpt-4o-mini | head -1 | sed "s/$KW/<key>/")
ok=1
chk_env openai https://api.openai.com/v1 openai gpt-4o-mini "$KW" >/dev/null || ok=0
sw=$(sweep openai "$KW"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no api.openai.com line at the upstream)"; }
row openai $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case other-key"
mkcase other-key
typed other-key "$(printf '5\nhttps://other.tree.test/v1\nanthropic\nmymodel-7\n%s\n' "$KX")" other-key-install.log
turn other-key other-key-turn.log
ev=$(uplog | tail -5 | grep other.tree.test | grep mymodel-7 | head -1 | sed "s/$KX/<key>/")
ok=1
chk_env other-key https://other.tree.test/v1 anthropic mymodel-7 "$KX" >/dev/null || ok=0
sw=$(sweep other-key "$KX"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no other.tree.test line at the upstream)"; }
row other-key $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case other-local (http :8080, empty key)"
mkcase other-local
typed other-local "$(printf '5\nhttp://msm-upstream:8080/v1\n\nlocalmodel-1\n\n' "")" other-local-install.log
turn other-local other-local-turn.log
ev=$(uplog | grep msm-upstream | grep localmodel-1 | head -1)
ok=1
chk_env other-local http://msm-upstream:8080/v1 openai localmodel-1 "" >/dev/null || ok=0
[ -n "$ev" ] || { ok=0; ev="(no localmodel-1 request at the upstream)"; }
ifhead=$(printf '%s' "$ev" | grep -o '"x_api_key": [^,]*')
row other-local $([ $ok = 1 ] && echo PASS || echo FAIL) "arrived over http 8080, $ifhead"

say "case flag-zai (no terminal)"
mkcase flag-zai
docker exec -u "$HU" -e HOME=$HH -e YGG_UPSTREAM_API_KEY=$KZ msm-flag-zai \
  bash -c "cd ~/yggdrasil-$VER/root/install && YGG_UPSTREAM_API_KEY=$KZ bash install.sh --brain-only --now </dev/null" \
  >"$STATE/log/flag-zai-install.log" 2>&1
turn flag-zai flag-zai-turn.log
ev=$(uplog | tail -5 | grep api.z.ai | grep glm-5.3-flash | head -1 | sed "s/$KZ/<key>/")
ok=1
chk_env flag-zai https://api.z.ai/api/anthropic anthropic glm-5.3-flash "$KZ" >/dev/null || ok=0
sw=$(sweep flag-zai "$KZ"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no api.z.ai line at the upstream)"; }
row flag-zai $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case flag-model (--model-provider anthropic --model claude-haiku-5-5)"
mkcase flag-model
docker exec -u "$HU" -e HOME=$HH bash -c "cd ~" >/dev/null 2>&1
docker exec -u "$HU" -e HOME=$HH -e YGG_UPSTREAM_API_KEY=$KA msm-flag-model \
  bash -c "cd ~/yggdrasil-$VER/root/install && YGG_UPSTREAM_API_KEY=$KA bash install.sh --brain-only --now --model-provider anthropic --model claude-haiku-5-5 </dev/null" \
  >"$STATE/log/flag-model-install.log" 2>&1
turn flag-model flag-model-turn.log
ev=$(uplog | tail -5 | grep api.anthropic.com | grep claude-haiku-5-5 | head -1 | sed "s/$KA/<key>/")
ok=1
chk_env flag-model https://api.anthropic.com anthropic claude-haiku-5-5 "$KA" >/dev/null || ok=0
sw=$(sweep flag-model "$KA"); case "$sw" in "mode=600 inenv=1 elsewhere=[]") ;; *) ok=0; ev="$sw";; esac
[ -n "$ev" ] || { ok=0; ev="(no claude-haiku-5-5 line at the upstream)"; }
row flag-model $([ $ok = 1 ] && echo PASS || echo FAIL) "$ev"

say "case flag-nokey (openai, no key in the environment: refuse, nothing written)"
mkcase flag-nokey
docker exec -u "$HU" -e HOME=$HH msm-flag-nokey \
  bash -c "cd ~/yggdrasil-$VER/root/install && bash install.sh --brain-only --now --model-provider openai </dev/null; echo RC=\$?" \
  >"$STATE/log/flag-nokey-install.log" 2>&1
n=$(uplog | grep -c api.openai.com || true)
ev=$(grep -o 'YGG_UPSTREAM_API_KEY[^;]*' "$STATE/log/flag-nokey-install.log" | head -1)
rc=$(sed -n 's/.*RC=\([0-9]*\).*/\1/p' "$STATE/log/flag-nokey-install.log" | tail -1)
nowritten=$(docker exec -u "$HU" msm-flag-nokey bash -c '[ ! -e ~/.config/yggdrasil/yggdrasil.env ] && echo none || grep -c "YGG_UPSTREAM_API_KEY=." ~/.config/yggdrasil/yggdrasil.env' 2>&1)
ok=1
[ "$rc" = 64 ] || ok=0
[ -n "$ev" ] || { ok=0; ev="(no YGG_UPSTREAM_API_KEY in the message)"; }
[ "$n" = 0 ] || { ok=0; ev="$ev (+a request DID reach the upstream)"; }
[ "$nowritten" = none ] || { ok=0; ev="$ev (env file has a key)"; }
row flag-nokey $([ $ok = 1 ] && echo PASS || echo FAIL) "exit $rc, \"$ev\", $nowritten key written, $n requests"

# ------------------------------------------------------------------------ the CA fact
say "CA probe: does the brain (reqwest 0.13) trust the system store?"
mkcase caprobe
docker exec -u "$HU" msm-caprobe bash -c '
  mkdir -p ~/.config/yggdrasil
  printf "YGG_UPSTREAM_BASE_URL=https://api.z.ai/api/anthropic\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY=sk-test-zai-0123456789abcdef\nYGG_UPSTREAM_MODEL=glm-5.3-flash\nYGG_LISTEN=127.0.0.1:4196\n" >~/.config/yggdrasil/yggdrasil.env
  cd ~/yggdrasil-0.9.1-rc.2-linux-x86_64
  (setsid nohup env $(cat ~/.config/yggdrasil/yggdrasil.env | xargs) ./bin/yggdrasil >~/brain-ca.log 2>&1 </dev/null & echo $! >~/brain.pid)
  for i in $(seq 40); do curl -sf http://127.0.0.1:4196/session >/dev/null 2>&1 && break; sleep 0.5; done
  S=$(curl -sf -X POST http://127.0.0.1:4196/session -H "content-type: application/json" -d "{\"title\":\"ca\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"id\"])")
  curl -s -X POST http://127.0.0.1:4196/session/$S/message -H "content-type: application/json" -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}" >/dev/null
  sleep 4; kill $(cat ~/brain.pid) 2>/dev/null; exit 0' >"$STATE/log/caprobe.log" 2>&1
caev=$(uplog | grep -c api.z.ai || true)
if [ "$caev" -gt 0 ]; then CA_RESULT="YES: with the CA in the container's system store (update-ca-certificates), the brain reached https://api.z.ai — reqwest reads the system store (no SSL_CERT_FILE needed)."
else
  # retry with SSL_CERT_FILE to find what it honours
  docker exec -u "$HU" msm-caprobe bash -c '
    cd ~/yggdrasil-0.9.1-rc.2-linux-x86_64
    (setsid nohup env SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt $(cat ~/.config/yggdrasil/yggdrasil.env | xargs) ./bin/yggdrasil >~/brain-ca2.log 2>&1 </dev/null & echo $! >~/brain2.pid)
    sleep 5; kill $(cat ~/brain2.pid) 2>/dev/null; exit 0' >>"$STATE/log/caprobe.log" 2>&1
  caev2=$(uplog | grep -c api.z.ai || true)
  [ "$caev2" -gt 0 ] && CA_RESULT="NO by system store alone; YES with SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" \
                    || CA_RESULT="NO with the system store and NO with SSL_CERT_FILE — see $STATE/log/caprobe.log and brain-ca*.log in msm-caprobe"
fi
say "CA: $CA_RESULT"

# ---------------------------------------------------------------------------- the table
echo; echo "================== model-step matrix ==================" | tee -a "$LOG"
printf '%s\n' "${ROWS[@]}" | tee -a "$LOG"
echo "CA: $CA_RESULT" | tee -a "$LOG"
echo "full log: $LOG" | tee -a "$LOG"
exit $FAIL
