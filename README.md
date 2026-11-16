# yggdrasil — your personal AI tree

Run your own AI assistant at home, reach it from your phone anywhere, and keep your files, models, and conversations on hardware you control.

```
veraldar/              all your trees                         → veraldar.org
└─ yggdrasil/          the tree: your computers working for you (this repository)
   ├─ root/            the brain on each computer (Rust binary `yggdrasil`)
   │  ├─ extensions/   optional plugins outside the core (such as `librarian` memory)
   │  └─ install/      home and multi-machine installers (`install.sh`, `join.sh`)
   ├─ trunk/           your private line (Rust binary `bifrost-net`)
   └─ branch/          bifrost, the phone app (Next.js PWA) + `branch/voice/` agent
```

In plain words: **root** thinks and runs tools on your home computer, **branch** (`bifrost`) is the app in your hand that lets you type or talk to it, and **trunk** (`bifrost-net`) is a tiny relay you run on a rented server so your phone and extra computers can find home without opening ports on your home router or needing a third-party VPN.

## How the pieces fit

```
Phone (branch: bifrost PWA)
  │
  │  WebRTC data channel (QR-pinned DTLS) + LiveKit ICE-TCP voice
  ▼  all over TCP 443 through your rented VPS
VPS (trunk: bifrost-net ap)  ── only relays bytes it cannot read after pairing
  ▲
  │  dials OUT (no open port at home)
  │
Home computer (root: yggdrasil + bifrost-net bridge/wg + app + voice)
  ▲
  │  WireGuard inside the root-link (through the trunk)
  │
Other computers (additional roots: Linux; macOS from a checkout)
```

- **root (`root/`, binary `yggdrasil`)** — A coordinator called `MAIN` that you talk to through one conversation. When work takes multiple steps, `MAIN` starts and follows child sessions (`lead`, `build`, `fix`, `research`, `review`), or delegates to coding harnesses (`claude` for Claude Code, `agy` for Antigravity, `opencode`, `codex`). Multiple machines form one tree of roots.
- **trunk (`trunk/`, binary `bifrost-net`)** — An access point on a small VPS with only TCP port 443 open (plus port 80 for Let's Encrypt certificate checks). Your home computer dials out to it. Once paired, your phone connects straight to your home bridge over WebRTC whose DTLS key is pinned by the pairing QR code, and roots talk to each other over WireGuard (`bifrost-net wg`). The VPS forwards encrypted bytes it cannot read.
- **branch (`branch/`)** — The phone web app (Next.js 15 PWA) served from your home computer. Its `/api/*` proxy is the single seam to the brain, which never listens publicly. `branch/voice/` runs a Python `livekit-agents` worker (speech-to-text → `yggdrasil` → text-to-speech, push-to-talk and hands-free).

## What you need

**To use at home (same Wi-Fi):**
- One Linux `x86_64` computer with glibc 2.31 or newer (Debian 11+, Ubuntu 20.04+; voice needs Python ≥ 3.10 with `venv`: Debian 12+, Ubuntu 22.04+), a systemd user session, `curl`, `ssh-keygen` (to check the release signature), `libopus0`, `bzip2` and about 2 GB of free disk with voice (about 0.5 GB without). The release brings everything else prebuilt, its own Node included — no git, compilers or npm. (macOS and `aarch64` build from a checkout for now.)
- A phone on the same Wi-Fi.
- An AI model key or local model server: any OpenAI-compatible `/v1` API (OpenAI, OpenRouter, Ollama, `llama.cpp`, vLLM) or Anthropic-style API (Anthropic, Z.ai), plus optional Claude Code or Antigravity CLI installs.
- Optional speech upgrade: a Mac on the same LAN serving MLX speech (`SPEACHES_URL`). Without it, `bifrost-voice` runs local CPU speech (`sherpa-onnx`, ~200 MB of models downloaded on first start).

**To reach your tree from anywhere (mobile data or other Wi-Fi):**
- A small rented VPS (Linux `x86_64` with systemd and glibc 2.31+: Debian 11+ or Ubuntu 20.04+, tested on Debian 12; 1 CPU / 512 MB RAM is enough) with a domain name pointing to it and TCP ports 443 and 80 open.
- Optional extra computers (Linux; macOS from a checkout) to join as additional roots on your tree.

## How to install

Each machine gets one script from a release. Before anything runs, the script checks the release's signed checksums against the yggdrasil release key written into the script ([RELEASE-KEY.pub](RELEASE-KEY.pub)), then the archive against them; anything that does not match is refused. Secrets (your model key, the trunk's connect line) are asked for and pasted — never typed on a command line.

1. **On your rented VPS (optional, for remote access):** `trunk.sh` sets up the access point on port 443, its Let's Encrypt certificate, the firewall, security updates and a weekly signed update, then prints the connect line for your home computer.
2. **At home:** `install.sh` (with `--trunk` it asks you to paste that connect line).
3. **On your phone:** `install.sh pair` shows a QR code on the home computer; scan it.
4. **On a second computer (optional):** `join.sh --hub https://<your trunk>`, then approve its QR code on your paired phone.

`--uninstall` undoes each of them. The exact commands are in [root/install/README.md](root/install/README.md) (home, phone, second computer) and [docs/own-trunk.md](docs/own-trunk.md) (the VPS). **Windows is not part of v0.9.0:** the launcher in `win/` has never run on a real Windows PC and still clones the repository instead of fetching the signed release — untested, use at your own risk.

Read [root/install/README.md](root/install/README.md) for home and multi-machine installation options, and [docs/own-trunk.md](docs/own-trunk.md) for setting up your VPS trunk (including sharing port 443 with an existing website).

## What it does today

- **One conversation, managed work behind it:** Talk or type to `MAIN`; it answers simple questions directly, starts sub-sessions with role-scoped tool rules (`build`, `fix`, `research`, `review`, `lead`), and summarizes finished or blocked reports back to you.
- **Multiple AI engines and editable agents:** Built-in `yggdrasil` tool loop plus `claude` (Claude Code), `agy` (Antigravity), `opencode`, and `codex` harnesses; edit agent prompts, models, thinking levels, and shared instructions in the app.
- **Terminal sessions both ways (`root/cc-live/`, `branch/app/cc/[id]/`):** Browse and watch active terminal conversations (Claude Code, Antigravity, `opencode`) from your phone, send input into `tmux` or Claude Code background sessions (including answering interactive prompts), or continue closed sessions through the brain with single-writer safety.
- **Multi-machine trees over WireGuard:** Join extra Linux (or, from a checkout, macOS) machines via phone-approved QR (`docs/spec-join.md`). `MAIN` can start sessions on any linked root (`session_start … root=<name>`), and root-to-root brain traffic travels inside WireGuard (`boringtun` + `smoltcp`) without opening ports or needing root privileges.
- **End-to-end encrypted trunk transport:** After QR pairing, `/api/*` app traffic (outside `/api/pair/*`) and `/rtc` LiveKit signaling ride a DTLS-pinned WebRTC data channel (`branch/lib/pinned.ts`); voice media rides LiveKit ICE-TCP over port 443 with end-to-end DTLS-SRTP.
- **Push-to-talk and hands-free voice:** Speak and hear replies with barge-in echo filtering, session-pinned TTS language, spoken playback controls (`stop`, `faster`, `slower`, `pause`, `resume`), and local CPU or LAN MLX speech models.
- **Phone PWA and extensions:** Streaming markdown transcripts, image/file attachments, sandboxed HTML artifact previews, per-device revocation and emergency kill-switch (`/devices`), and process-isolated extensions (`root/extensions/librarian/` for SQLite FTS5 cross-session search and memory).

## What it does not do yet

- **No phone microphone over plain LAN HTTP:** Browsers block microphone access on insecure `http://<LAN IP>` origins; typing and hearing replies work on LAN HTTP, while speaking from the phone requires HTTPS (such as your own trunk).
- **The VPS still serves the web app shell and sees pairing:** Your rented VPS terminates TLS for the web page HTML/JS, the pairing exchange (`/api/pair/*`), and WebRTC `POST /offer` signaling. See [SECURITY.md](SECURITY.md) for the exact trust boundary.
- **First-contact WebRTC fallback:** If a strict network blocks WebRTC on initial page load before the pinned channel connects, the app falls back to the trunk's TLS (`via the trunk's TLS`). Once pinned in a session, a dropped connection pauses in `reconnecting` rather than falling back.
- **No direct root-to-root UDP leg:** WireGuard packets between roots travel inside the WebSocket root-link through the hub's relay (TCP inside TCP), so lossy paths can stack retransmits.
- **Phone-to-root `/branch` turns:** Direct phone turns targeting a specific joined root via `/branch` still cross the hub's bridge as frames rather than inside the WireGuard tunnel.
- **No per-root revoke UI or key rotation yet:** Revoking the approving phone cuts its joined roots' WireGuard tunnels within ~1–2 s, while revoking or rotating an individual root uses `roots.json` / `join.sh --rejoin` (`docs/spec-join.md`).
- **Single-user and platform scope:** Designed for one owner per tree (no multi-user accounts); prebuilt release binaries focus on Linux `x86_64` (other Linux architectures and macOS compile with Cargo; Windows via WSL2 is untested); mobile OS background/screen-off microphone limits vary by device; short replies containing symbols can occasionally misdetect TTS language.

## How it is tested

Verification relies on deterministic simulations and isolated network-namespace suites in `sim/` alongside crate and Playwright tests:

- `sim/trunk-e2e.sh` — Full end-design world in private Linux namespaces (`unshare` + `nftables` blocking all UDP so only TCP 443 reaches the simulated VPS): tests QR pairing, pinned app data, voice over ICE-TCP, multi-root WireGuard delegation, hub restarts, active MITM rejection, traffic inspection at the VPS (`vps-eye.py`), and ~1 s revocation.
- `sim/trunk-rtc-e2e.sh` & `sim/trunk-full-e2e.sh` — Isolated WebRTC voice-over-trunk and full phone→VPS→hub→joined-root Playwright runs (`branch/e2e/trunk-*.spec.ts`).
- `sim/trunk-roots-e2e.py` — Multi-root WireGuard relay, directory push, replay/tamper/impostor rejection, rekeying, and revocation checks.
- `sim/own-trunk-e2e.sh` — Boots clean Debian 12 and Ubuntu 24.04 systemd containers with Pebble (test ACME) and runs the real `trunk.sh`, `install.sh`, `join.sh`, and a Chromium phone.
- `sim/tree-e2e.py`, `sim/hsim.py`, & `sim/voice/` — Deterministic coordinator tree tests, LLM-persona end-to-end runs, and voice persona barge-in/echo/latency suites (`sim/voice/suite.py`).
- Unit & suite checks: `cargo test` in `root/` and `trunk/`, `root/verify.sh`, `branch/` Playwright e2e specs.

## Further reading

- [SECURITY.md](SECURITY.md) — Trust boundaries, token storage, key pinning, revocation, and vulnerability reporting.
- [VERSIONS.md](VERSIONS.md) — Release changelog (`v0.8.0`, `v0.8.1`, and `Unreleased (v0.9.0)`).
- [docs/own-trunk.md](docs/own-trunk.md) & [root/install/README.md](root/install/README.md) — Step-by-step installation and VPS setup.
- [root/ROOT-COORD.md](root/ROOT-COORD.md) & [root/extensions/README.md](root/extensions/README.md) — Coordinator tree model, harnesses, and extension protocol.

## License

yggdrasil is licensed under [AGPL-3.0](LICENSE) — copyleft including network use: modified versions offered as a network service must make their source code available. Talking to yggdrasil over its API does not make your client a derivative work.

Attributions: the web app in `branch/` derives from [livekit-examples/agent-starter-react](https://github.com/livekit-examples/agent-starter-react) (MIT, see [branch/LICENSE](branch/LICENSE)); icons from [pixelarticons](https://github.com/halfmage/pixelarticons) (MIT).
