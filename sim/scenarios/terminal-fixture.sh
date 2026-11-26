#!/usr/bin/env bash
# terminal-fixture.sh — the host fixture of sim/scenarios/terminal.json (G5.2), made by the run itself.
#
#   terminal-fixture.sh up      a DEDICATED tmux server (its own TMUX_TMPDIR, so the owner's tmux is never seen or touched)
#                               with Claude Code resumed on conversation 070d6b89… in ~/Work/cc-live-scratch, the cc-live
#                               helper on 127.0.0.1:4322 that sees only that server (--cwd-prefix cc-live-scratch), and the
#                               evidence baselines (how many SIM-TYPED-OK / CC-CONT-OK lines the transcripts hold NOW)
#   terminal-fixture.sh down    kills only what `up` started (the helper by its PID, the dedicated tmux server)
#   $S/delta.sh typed|cont      lines written since `up` (a check counts only this run's evidence, never an older run's)
#
# State: ~/.cache/root-sim/hsim-term-fixture ($TERM_FIXTURE_DIR). Needs: tmux, claude (logged in), the conversation files.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
S=${TERM_FIXTURE_DIR:-$HOME/.cache/root-sim/hsim-term-fixture}
SCR=$HOME/Work/cc-live-scratch
CID=070d6b89-df88-495a-b061-1a0a80cfbea0
TOKEN=sim-term-token-1115-7f3a9c       # the scenario's YGG_HARNESS_HELPER_TOKEN (a test token)
PORT=4322
TX=(env TMUX_TMPDIR="$S/tmux" tmux)
PROJ=$(ls -d "$HOME"/.claude/projects/*cc-live-scratch 2>/dev/null | head -1 || true)

down() {
  [ -f "$S/helper.pid" ] && kill "$(cat "$S/helper.pid")" 2>/dev/null || true
  rm -f "$S/helper.pid"
  [ -d "$S/tmux" ] && "${TX[@]}" kill-server 2>/dev/null || true
  rm -f "$S/harness-live.json"
}

case "${1:-}" in
  up)
    command -v tmux >/dev/null || { echo "terminal fixture: tmux missing"; exit 2; }
    command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || { echo "terminal fixture: claude missing"; exit 2; }
    [ -n "$PROJ" ] && [ -f "$PROJ/$CID.jsonl" ] || { echo "terminal fixture: conversation $CID not found under ~/.claude/projects (…cc-live-scratch)"; exit 2; }
    ss -ltn | grep -q ":$PORT " && { echo "terminal fixture: port $PORT is busy"; exit 2; }
    mkdir -p "$S/tmux" && chmod 700 "$S" "$S/tmux"
    down
    # the evidence baselines
    grep -c SIM-TYPED-OK "$PROJ/$CID.jsonl" >"$S/baseline-typed" || true
    cat "$PROJ"/*.jsonl | grep -c CC-CONT-OK >"$S/baseline-cont" || true
    grep -c AGY-CONT-OK "$HOME/.gemini/antigravity-cli/brain/1a289121-819e-47e3-b617-d9979520bf50/.system_generated/logs/transcript.jsonl" >"$S/baseline-agy" 2>/dev/null || echo 0 >"$S/baseline-agy"
    cat >"$S/delta.sh" <<DELTA
#!/usr/bin/env bash
case "\$1" in
  typed) n=\$(grep -c SIM-TYPED-OK "$PROJ/$CID.jsonl" || true); echo \$((n - \$(cat "$S/baseline-typed"))) ;;
  cont)  n=\$(cat "$PROJ"/*.jsonl | grep -c CC-CONT-OK || true); echo \$((n - \$(cat "$S/baseline-cont"))) ;;
esac
DELTA
    chmod 755 "$S/delta.sh"
    # Claude Code, resumed, in a dedicated tmux server (a clean environment: it must not think it is nested in a session)
    CLAUDE_BIN=$(command -v claude || echo "$HOME/.local/bin/claude")
    "${TX[@]}" new-session -d -s hsim-term -x 180 -y 50 -c "$SCR" \
      "env -i HOME=$HOME PATH=$PATH TERM=xterm-256color LANG=${LANG:-C.UTF-8} $CLAUDE_BIN --resume $CID"
    # the owner's terminal waits at a folder-trust / resume prompt sometimes: look at the screen
    for _ in $(seq 60); do
      scr=$("${TX[@]}" capture-pane -p -t hsim-term 2>/dev/null || true)
      case "$scr" in *"trust this folder"*|*"Yes, proceed"*) "${TX[@]}" send-keys -t hsim-term Enter ;; esac
      echo "$scr" | grep -q -E '^[[:space:]]*(>|❯|╭)|\? for shortcuts|bypass permissions|esc to interrupt' && break
      sleep 1
    done
    ( umask 077; printf %s "$TOKEN" >"$S/helper.token" )
    ( cd "$REPO" && exec env TMUX_TMPDIR="$S/tmux" python3 root/cc-live/cc_live.py --port $PORT --token-file "$S/helper.token" \
        --live-file "$S/harness-live.json" --cwd-prefix "$SCR" >"$S/helper.log" 2>&1 ) &
    echo $! >"$S/helper.pid"
    ok=0
    for _ in $(seq 90); do
      if [ -f "$S/harness-live.json" ] && grep -q "claude:$CID" "$S/harness-live.json" && grep -q '"how": "tmux"' "$S/harness-live.json"; then ok=1; break; fi
      sleep 1
    done
    if [ "$ok" != 1 ]; then
      echo "terminal fixture: conversation $CID never showed as open in tmux"; cat "$S/harness-live.json" 2>/dev/null || true
      "${TX[@]}" capture-pane -p -t hsim-term | tail -15 || true
      down; exit 2
    fi
    echo "terminal fixture up: tmux (TMUX_TMPDIR=$S/tmux) claude --resume $CID in $SCR · cc-live :$PORT · baselines typed=$(cat "$S/baseline-typed") cont=$(cat "$S/baseline-cont")"
    ;;
  down) down; echo "terminal fixture down" ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
