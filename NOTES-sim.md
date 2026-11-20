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

## Baselines (current code, p2 brain merged)
- trunk-full-e2e.sh: GREEN 19/19 steps, 89 s. trunk-rtc-e2e.sh: GREEN 10/10, 90 s (61 s rerun on
  the edited script, default scenario `rtc`).

## Built (how to run; all state under sim-tmp)
    export TMPDIR=/home/dweeb_xyz/.cache/p2-reach/sim-tmp
    YGG_BIN=/home/dweeb_xyz/.cache/p2-reach/target/release/yggdrasil TRUNK_RTC_STATE=$TMPDIR/s16 \
      sim/trunk-rtc-e2e.sh --scenario s16          # S16; S16_ROOT=home = the control; S16_WAYS=hold|free
    YGG_BIN=… TRUNK_FULL_STATE=$TMPDIR/s17 sim/trunk-full-e2e.sh --scenario s17     # S17
  Both rigs take APP_DIR=<built app> (default branch/). Drivers: sim/reach/{s16,s17}.mjs + rig-lib.mjs.
  sim/reach/cc_model.py = the scripted model for lab's real Claude Code; joiner --brain-env.

## Results (p2-reach ac6ecf28 merged: brain + app; logs under sim-tmp/)
- Defaults on the merged app: trunk-full GREEN 19/19 (55 s), trunk-rtc GREEN 10/10 (50 s).
- S16 (s16-lab-3.log, 194 s): hands-free on lab 5/5 PASS (words once on lab, modality voice, the
  answer spoken: 1.9 MB of room audio = the box's TTS bytes, STT 88 % lab's reply; still once 20 s
  later). Hold: words once PASS; modality FAIL; spoken FAIL — the CONTROL on a local session
  (s16-home-2.log) fails the same "spoken" step: app behaviour, not package 2.
- S17 (s17-run4.log, 30 s, S17_HARNESS_UPLOAD=1): S17.4 FAIL (the phone's upload); everything after
  PASS on the harness upload: lab pulled 6.1 MiB from home over WireGuard (a whole-file call through
  the tunnel → 502 "body over 4194304 bytes", a 1 MiB piece → 200), the real Claude Code got the path,
  its Read sent the model the exact PDF (6395995 bytes, sha equal), marker named, marker.html written,
  the phone tapped /api/artifact/marker.html?root=lab&session=… → 200 text/html, marker on the page.

## Findings
- APP (p2-reach-app): the phone's upload over the pinned channel fails on a piece, intermittently:
  run 2 piece 2, run 4 piece 5 → 500 from Next before the route runs ("TypeError: Response body
  object should not be disturbed or locked … fromNodeNextRequest … api/file/upload/[upload]/route").
  The same three 1 MiB PUTs straight to the app on loopback pass, devices AND tailnet mode → it is the
  trunk path (phone SW → pinned data channel → bridge → server.mjs). Then the composer sends the
  question WITHOUT the file when send is tapped while/after the upload fails (runs 2 and 4); when the
  error shows first it reads "could not send report.pdf (500)" (run 3).
- Brain wording: the harness line is "[attached: NAME (MIME, SIZE) — path — open it with your file
  tools]" (files.rs:692); the contract said "[attached by the owner: …]".
- S16 hold (push to talk, text mode) on a SESSION page: the words reach lab once (PASS), but
  (a) the agent marks the turn `modality: voice` only in hands-free (agent.py `voice = mode == "free"`)
      — run 1 without "over": modality absent; and a hold whose speech ends in "over" is committed as a
      keyword turn mid-hold (then it IS voice): the hold WAV must not say "over";
  (b) the session page never speaks a text-mode hold's reply (it speaks only in hands-free or the
      first-turn walk). The CONTROL (S16_ROOT=home, a local session, no package 2) fails the same
      step → an app behaviour, not package 2. The rtc spec's R3 covers the home-screen roots hold only.
- S16 hands-free on a local session: all PASS (control). On lab: see the latest run.
- Claude Code on a resumed session with the 6 MB PDF in its history auto-compacts (8.5 MB context):
  the scripted model answers the compaction calls "OK."; harmless here, worth knowing for real runs.

## Half done / next
- S17 strict (no S17_HARNESS_UPLOAD) goes green only when the phone's pinned-channel upload is fixed.
- S16 hold: needs a product decision (should a held turn be voice + spoken on a session page?).
