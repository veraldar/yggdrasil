#!/usr/bin/env bash
# context-e2e.sh — G1 proof on a scratch brain + the mock upstream (root/mock/mock_upstream.py,
# the lat-law-e2e.sh way; scratch ports 14110/18110, NEVER a live one). BOTH dialects:
#   1. a turn through the real agent_loop, captured by context::capture
#   2. GET /session/{id}/context: totals.bytes == the wire body the mock received
#   3. the sheet's blocks (part=block&i=N) rebuild the body — equal to the mock's, masked
#   4. CTX-CAPTURE bytes= in brain.log == totals.bytes
# The verdict is the last line: == CONTEXT-E2E: GREEN|RED
set -u
D=/tmp/ctx-e2e; rm -rf $D; mkdir -p $D
MOCK=18110; Y=127.0.0.1:14110; U=http://$Y
BIN="$(cd "$(dirname "$0")/.." && pwd)/target/release/yggdrasil"
[ -x "$BIN" ] || { echo "no brain binary ($BIN) — cargo build --release in root/"; exit 1; }
FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1: got '$2' want '$3'"; FAIL=1; fi; }

for STYLE in openai anthropic; do
  echo "== dialect $STYLE"
  rm -rf $D/data $D/*.log $D/reply.json
  python3 "$(dirname "$0")/mock_upstream.py" $MOCK >$D/mock.log 2>&1 & MOCKPID=$!
  if [ "$STYLE" = openai ]; then BASE="http://127.0.0.1:$MOCK/v1"; else BASE="http://127.0.0.1:$MOCK"; fi
  YGG_DATA_DIR=$D/data YGG_LISTEN=$Y YGG_UPSTREAM_BASE_URL=$BASE YGG_UPSTREAM_STYLE=$STYLE \
   YGG_UPSTREAM_API_KEY=mock-key YGG_UPSTREAM_MODEL=mock YGG_MAX_STEPS=3 \
   YGG_PROJECT_DIR=$D $BIN 2>$D/brain.log & SRVPID=$!
  trap 'kill $MOCKPID $SRVPID 2>/dev/null' EXIT
  for _ in $(seq 60); do curl -sf $U/session >/dev/null 2>&1 && break; sleep 0.2; done

  S=$(curl -sf -X POST $U/session -H 'content-type: application/json' -d '{"title":"ctx proof"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  # the turn: an api_key= assignment rides it — the SERVED views must hide it
  curl -s -X POST $U/session/$S/message -H 'content-type: application/json' \
    -d '{"parts":[{"type":"text","text":"Reply with one word. api_key=supersecret123 must never appear in your context views."}]}' \
    -o $D/reply.json
  for _ in $(seq 200); do [ "$(python3 -c 'import json;d=json.load(open("'$D'/reply.json"));print(bool(d.get("parts")))' 2>/dev/null)" = "True" ] && break; sleep 0.3; done

  python3 - "$U" "$S" "$STYLE" "http://127.0.0.1:$MOCK" <<'PY'
import json, sys, urllib.request
U, S, STYLE, MOCK = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def mask_txt(t):
    import re
    t = re.sub(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", lambda m: "[image]", t)
    t = re.sub(r"(?i)(key|token|secret|password)(\s*[=:]\s*)\S+", r"\1=…", t)
    t = re.sub(r"Bearer \S+", "Bearer …", t)
    t = re.sub(r"sk-[A-Za-z0-9_-]{16,}", "sk-…", t)
    return t

def get(p):
    try:
        return json.load(urllib.request.urlopen(f"{U}{p}"))
    except Exception as e:
        print(f"FAIL get {p}: {e}")
        raise
summary = get(f"/session/{S}/context?part=summary")
wire = get(f"/session/{S.rsplit('_',1)[0] and '/x'}") if False else None
last = json.load(urllib.request.urlopen(f"{MOCK}/last"))  # the mock's record of the body it received
assert last, "mock received nothing"
tot = summary["totals"]["bytes"]
# 1. totals.bytes == the wire body size (exactly what the mock got)
wire_len = len(json.dumps(last, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))  # the wire is compact UTF-8
assert tot == wire_len, f"totals.bytes {tot} != wire {wire_len}"
# 2. rebuild from blocks and compare (normalized + masked)
n = len(summary["blocks"])
msgs, system = [], []
for i in range(n):
    b = get(f"/session/{S}/context?part=block&i={i}")
    assert "supersecret123" not in b["text"], f"seeded secret leaked in block {i}"
    if b["kind"] == "tools":
        continue
    if b["role"] == "system":
        system.append(b["text"])
        continue
    slot = next((k for k, m in enumerate(msgs) if m.get("_msg") == b["msg"]), None)
    if slot is None:
        msgs.append({"role": b["role"], "content": b["text"], "_msg": b["msg"]})
        slot = len(msgs) - 1
    elif b["text"]:
        msgs[slot]["content"] = (msgs[slot]["content"] + "\n" + b["text"]).strip("\n")
norm_wire = [m for m in json.loads(json.dumps(last)).get("messages", []) if m.get("role") != "system"]
wire_system = "\n\n".join(m["content"] for m in last.get("messages", []) if m.get("role") == "system")
mine_system = "\n\n".join(system)
if STYLE == "openai":
    wsys = [m["content"] for m in last.get("messages", []) if m.get("role") == "system"]
    assert system == wsys or "\n\n".join(system) == "\n\n".join(wsys), f"system differs:\n{system}\nvs\n{wsys}"
    wmsgs = [m for m in last.get("messages", []) if m.get("role") != "system"]
    assert len(msgs) == len(wmsgs), f"message count {len(msgs)} != wire {len(wmsgs)}"
    for a, b in zip(msgs, wmsgs):
        assert a["role"] == b["role"], (a["role"], b["role"])
        assert a["content"] == mask_txt(b["content"]), f"content differs:\n{a['content'][:200]}\nvs masked\n{mask_txt(b['content'])[:200]}"
else:
    assert mine_system == last.get("system", ""), f"anthropic system differs:\n{mine_system[:200]}\nvs\n{str(last.get('system'))[:200]}"
    assert len(msgs) == len(last.get("messages", [])), "anthropic message count differs"
    for a, b in zip(msgs, last.get("messages", [])):
        assert a["role"] == b["role"]
        at = "".join(x.get("text", "") + (x.get("content") or "") for x in b["content"])
        assert a["content"] == mask_txt(at), f"content differs:\n{a['content'][:200]}\nvs masked\n{mask_txt(at)[:200]}"
print("PASS block-rebuild equals the wire body (normalized, masked)")
PY
  [ $? = 0 ] || FAIL=1

  B=$(grep -o 'CTX-CAPTURE session='$S' step=1 bytes=[0-9]*' $D/brain.log | head -1 | grep -o 'bytes=[0-9]*' | cut -d= -f2)
  T=$(curl -s $U/session/$S/context | python3 -c 'import sys,json;print(json.load(sys.stdin)["totals"]["bytes"])')
  chk "CTX-CAPTURE bytes == totals.bytes ($STYLE)" "$B" "$T"
  kill $MOCKPID $SRVPID 2>/dev/null; wait $MOCKPID $SRVPID 2>/dev/null
done
trap - EXIT
[ $FAIL = 0 ] && echo "== CONTEXT-E2E: GREEN" || echo "== CONTEXT-E2E: RED"
exit $FAIL
