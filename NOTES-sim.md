# NOTES-sim — package 2 rigs (branch p2-reach-sim)

State + temp: /home/dweeb_xyz/.cache/p2-reach/sim-tmp (TMPDIR too). Never /tmp.
Brain: `CARGO_TARGET_DIR=/home/dweeb_xyz/.cache/p2-reach/target cargo build --release --offline` (root/).

## Done
- tree-e2e.py package 2 (`--only reach`, `--long`, `--port-base`): done + GREEN (coordinator, 3c97fd7c).
- Baseline before p2 code: tree-e2e GREEN, 95 checks, ~10 s (--port-base 4260).
- sim/reach/make_pdf.py: a real 2-page PDF of N MB, marker word in page-1 text, random-pixel image
  on page 2 (incompressible). Checked with pdfinfo / pdftotext / qpdf --check.

## Facts: what the namespace rigs can reach (measured 2026-11-19)
- Both rigs (`unshare --user --map-root-user --net --mount --pid`): NO route out. A TCP connect to
  api.anthropic.com:443 fails at once (names still resolve via the host resolver socket; nothing
  connects). The model upstream inside = root/mock/mock_upstream.py on loopback (scripted).
- trunk-rtc: speech is local and real — ~/.cache/trunk-rtc/{livekit-server, voice (sherpa-onnx
  whisper-tiny.en STT + piper TTS: lessac en, siwis fr), agent-venv}; the real voice agent.
- trunk-full: no voice stack (no LiveKit: the app says voice isn't set up). Roots join through
  sim/trunk-full-joiner.py over WireGuard via the hub's relay (real root↔root transport).
- `claude` (2.1.328, mise path) IS on the PATH the rigs pass in, but:
  - everything in the rig runs as uid 0, and Claude Code refuses `--dangerously-skip-permissions`
    as root — the flag the brain's harness passes. Works with `IS_SANDBOX=1` in the brain's env, or
    under a nested user namespace mapped to uid 1000 (both tried).
  - no login and no network: it needs `ANTHROPIC_BASE_URL` → a sim-side fake model. With
    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` it makes exactly one /v1/messages call per step.
  - its Read tool on a 5.7 MB PDF sends the whole PDF as a base64 `document` block inside the
    tool_result (an 8 MB request). So a fake model can decode it and pdftotext it: the marker only
    reaches the reply if the bytes came through Claude Code's own Read tool.
- No reportlab/pypdf/fpdf installed; pdftotext, pdfinfo, qpdf are.

## Plan (S16, S17)
- S16 → `sim/trunk-rtc-e2e.sh --scenario s16`: a lab brain in the home machine's namespace
  (loopback; static YGG_PEERS both ways + peer token), a proxy on home for a lab session; driver
  sim/reach/s16.mjs (Playwright lib, Pixel 7, phone in its own netns, fake-mic WAV rendered by the
  rig's piper). Holds composer-mic in the proxy's session page. Checks: lab holds exactly one user
  message with the words (modality voice); the reply arrives as room audio, STT of it matches.
  Substitution (said plainly): lab reaches home over loopback, not WireGuard — S10/trunk-full proves
  the tunnel; the real omarchy-lab is on the same machine too.
- S17 → `sim/trunk-full-e2e.sh --scenario s17`: lab joined by the joiner (WireGuard), its brain
  with `--brain-env` (ANTHROPIC_BASE_URL → sim/reach/cc_model.py, IS_SANDBOX=1, no traffic). A
  Claude Code session on lab (proxy on home). Phone attaches a 6.4 MB PDF in the composer + "what is
  the marker word in this pdf" → reply holds the marker; then "write marker.html … link it" → phone
  taps the link → 200 text/html with the marker. Substitution: the MODEL is scripted (offline);
  Claude Code itself (Read, Write, its prompt line) is real.

## Half done / next
- (see git log)
