# Changelog

For releases before v0.8.0 (`v0.1.0`–`v0.7.0`), see the git tag history.

## Unreleased (v0.9.0)

Adds the end-design trunk, voice fixes, two-way terminal sessions, and `claude` / `agy` agents on top of `v0.8.1`.

### End-design trunk (`trunk/`, `branch/`, `root/install/`, `sim/`)
- **WebRTC `root` ↔ `branch` over TCP 443:** After QR pairing, `/api/*` app traffic (outside `/api/pair/*`) and `/rtc` LiveKit signaling ride a DTLS-pinned WebRTC data channel (`tun`) straight to the home bridge; voice media rides ICE over TCP on port 443 (`livekit-ice`) with end-to-end DTLS-SRTP and spoken TTS audio streamed over the voice room.
- **Pin persistence across restarts & MITM fail-closed:** A pinned session that loses its channel enters `reconnecting` instead of falling back to the VPS's TLS; DTLS fingerprint mismatches abort before any app byte is sent.
- **WireGuard `root` ↔ `root` (`bifrost-net wg`):** Brain-to-brain calls between roots run inside a userspace WireGuard tunnel (`boringtun` + `smoltcp`, no TUN device or root privileges) whose public keys are pinned when approved on the phone.
- **Lightweight root build (`--no-default-features`):** Joined roots can build `bifrost-net` without `str0m`/`libopus`/`cmake` (`cargo build --release --no-default-features`).
- **Live directory & ~1 s revocation:** The hub's WireGuard node pushes directory updates into active root tunnels and drops revoked devices/roots in about a second; `install.sh --trunk` and `join.sh` wire `bifrost-wg` / `yggdrasil-root-wg` automatically.
- **VPS port 443 sharing kit (`trunk/deploy/vps-443/`) & end-to-end sims:** Added `sni-443.py` config templates for sharing port 443 with an existing site plus ICE-TCP, verified by `sim/trunk-e2e.sh` and `sim/trunk-rtc-e2e.sh`.

### Voice fixes & simulation (`branch/voice/`, `branch/`, `sim/voice/`)
- **Barge-in & echo handling:** Filtered TTS playback echo while preserving user speech that starts over playback and finishes after; tuned Silero VAD activation (`0.35`) for softer voices.
- **Hands-free & TTS reliability:** `MAIN` inbox reports are read aloud in hands-free mode, TTS language is pinned to the session rather than guessed from short replies, paused browser TTS playback recovers cleanly, and spoken session names match existing names safely without extra upstream calls before dispatch.
- **Voice persona simulation (`sim/voice/`):** Automated multi-turn voice test suite (`suite.py`, `vsim.py`) measuring WER, barge-in cut latency, echo bleed, and first-audio timing.

### Terminal sessions both ways (`root/cc-live/`, `branch/app/cc/[id]/`)
- **Live view & continuation across harnesses:** Browse and stream active or recent Claude Code, Antigravity (`agy`), and `opencode` terminal sessions from the phone with single-writer safety: watch-only when open in a plain terminal, interactive typing and prompt answers when running inside `tmux` or Claude Code background mode, or continued through `yggdrasil` when not open elsewhere.

### `claude` and `agy` agents (`root/`, `branch/`)
- **Built-in `claude` and `agy` agents:** Replaced `agi` with built-in `claude` (Claude Code) and `agy` (Antigravity) agents in `yggdrasil` and the app's agent picker/editor.
- **Cross-root reporting fix:** Sessions started by another root now report back to the root that dispatched them.

---

## v0.8.1 (2026-11-14)

- **Your own trunk (`docs/own-trunk.md`):** Added `trunk/install/trunk.sh` for Debian/Ubuntu VPS setup (Let's Encrypt with pinned SPKI key, systemd unit, `--behind-proxy` + `sni-443.py` sharing on port 443, `--rotate-token`), `install.sh --trunk` at home, and `install.sh pair` (`--list`, `--revoke`, `--kill`) for terminal QR pairing; fixed `install.sh` app/voice unit paths after the `branch/` rename; added Docker simulation `sim/own-trunk-e2e.sh`.
- **Continue terminal Claude Code sessions:** Added `GET /harness/claude/sessions` and fork-based continuation from the phone (`claude -p --resume <id> --fork-session --permission-mode auto`) so terminal transcripts stay untouched and permission guards stay active.
- **Antigravity CLI (`agy`) harness:** Replaced Gemini CLI with `agy` as Google's harness, with live model discovery via `agy models` (refreshed every 10 minutes) and fallback floor models.
- **Pairing & UI fixes:** QR pairing now lands cleanly on the tree door for first-time devices or the session list for returning phones; voice over the trunk reports unavailable as a calm state rather than an error; artifact and Claude Code session lists show timestamps for earlier days.

---

## v0.8.0 (2026-11-13) — The tree (`root` · `trunk` · `branch`)

- **Repository reshaped around the tree:** Organized into `root/` (`yggdrasil` brain, `root-coord` session coordinator + `librarian` extension), `trunk/` (`bifrost-net`), `branch/` (PWA + `branch/voice/`), and `sim/`.
- **Device-token pairing & merged `bifrost-net`:** Added `BIFROST_AUTH=devices` (QR pairing with DTLS pinning, short-lived region-bound access tokens, rotating refresh tokens with theft detection, `/devices` revocation, and kill-switch) alongside the access point (`bifrost-net ap`) and root-link switchboard.
- **Multi-machine join by QR (`join.sh` & Windows installer):** Join Linux, macOS, and Windows (WSL2 / `win/Veraldar-Setup.exe`) roots via phone approval at `/join`; the hub brain discovers linked roots automatically via `/_roots` (`YGG_PEERS_FROM`), and joined roots report back using the hub's root name.
- **End-to-end simulations:** Added `sim/trunk-full-e2e.sh` (namespace-isolated phone → AP → hub → joined root) and `sim/tree-e2e.py`.
