#!/usr/bin/env bash
# repro.sh — reproduce the step-cap death on a scratch brain (NEVER the live one).
# mock upstream :18190, brain :14110 (or $1). Usage: repro.sh [port] [agent] [steps]
set -u
cd "$(dirname "$0")"
PORT=${1:-14110}; AGENT=${2:-lead}; NSTEPS=${3:-130}
BIN=./target/release/yggdrasil
D=/tmp/cap-repro-$$; mkdir -p "$D/data/session" "$D/proj"
python3 mock/mock_upstream.py 18190 >"$D/mock.log" 2>&1 & MOCK=$!
YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18190/v1 YGG_UPSTREAM_STYLE=openai YGG_UPSTREAM_API_KEY=dummy \
 YGG_UPSTREAM_MODEL=mock YGG_DATA_DIR="$D/data" YGG_PROJECT_DIR="$D/proj" YGG_LISTEN=127.0.0.1:$PORT \
 "$BIN" >"$D/brain.out" 2>"$D/brain.log" & SRV=$!
trap 'kill $MOCK $SRV 2>/dev/null' EXIT
for _ in $(seq 60); do curl -sf -m1 http://127.0.0.1:$PORT/session >/dev/null && break; sleep 0.2; done
SID=$(curl -sf -X POST http://127.0.0.1:$PORT/session -H 'content-type: application/json' \
  -d "{\"title\":\"cap-$AGENT\", \"agent\":\"$AGENT\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "session $SID (agent=$AGENT), asking for $NSTEPS tool steps…"
SCRIPT=$(python3 -c 'import json,sys;n=int(sys.argv[1]);print(json.dumps([[["bash",{"command":"echo s%d >> ran.txt"%i}]] for i in range(n)]))' $NSTEPS)
T0=$(date +%s)
OUT=$(curl -s -m 300 -X POST "http://127.0.0.1:$PORT/session/$SID/message?async=1" -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"parts":[{"type":"text","text":"tool:"+sys.argv[1]}]}))' "$SCRIPT")")
T1=$(date +%s)
echo "post returned in $((T1-T0))s"
# async=1 returns immediately; poll the transcript until the assistant message completes or 240s
for _ in $(seq 480); do
  DONE=$(curl -sf "http://127.0.0.1:$PORT/session/$SID/message" | python3 -c '
import sys,json
ms=json.load(sys.stdin); a=ms[-1]
if a["info"]["role"]=="assistant" and a["info"]["time"].get("completed"): print("DONE"); print(a["info"].get("error",{}).get("data",{}).get("message","(no error)")); print("".join(p.get("text","") for p in a["parts"] if p.get("type")=="text")[:300])
else: print("WAIT")' 2>/dev/null | head -1)
  [ "$DONE" = DONE ] && break; sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/session/$SID/message" | python3 -c '
import sys,json
ms=json.load(sys.stdin); a=ms[-1]
err=a["info"].get("error",{}).get("data",{}).get("message","")
tools=sum(1 for p in a["parts"] if p.get("type")=="tool")
print("VERDICT:", ("DIED: "+err) if err else "COMPLETED")
print("tool steps recorded:", tools)
print("final text:", "".join(p.get("text","") for p in a["parts"] if p.get("type")=="text")[:200])'
