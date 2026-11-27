# yggdrasil — install on your own Linux computer (native, no docker)

One command installs the whole stack as **systemd user services**. It needs no admin rights
(sudo), no docker, no developer tools and no accounts other than the model provider you already
have. You talk to it from your phone over your own Wi-Fi, or from anywhere through
[your own trunk](../../docs/own-trunk.md).

## One command

```sh
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.2/install.sh
bash install.sh
```

The first time, it asks for your **model provider**: Z AI, OpenRouter, Anthropic, OpenAI or Other. A
provider asks only for its API key: its address is filled in and its default model is shown (press
Enter, or type another). *Other* asks for the address (any OpenAI-compatible `/v1` endpoint or an
Anthropic-shaped one: a local Ollama at `http://127.0.0.1:11434/v1`, llama.cpp, vLLM), its kind, the
model and the key (none for a model on your own network). The key is read without showing it and
written only to `~/.config/yggdrasil/yggdrasil.env` (mode 600), never to a command line or your
shell's history. Not at a terminal? `--model-provider zai` (or `openrouter`, `anthropic`, `openai`)
with the key in the environment variable `YGG_UPSTREAM_API_KEY`, and `--model NAME` for another model;
or `--upstream-env FILE` with lines like `YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1`,
`YGG_UPSTREAM_API_KEY=…`, `YGG_UPSTREAM_MODEL=gpt-4o-mini` (and `YGG_UPSTREAM_STYLE=anthropic` for an
Anthropic-shaped API).

**What it downloads, and how it checks it.** `install.sh` belongs to one release (here `v0.9.2`).
It fetches that release's list of checksums (`SHA256SUMS`) and its signature, and checks the
signature against the yggdrasil release key written into the script itself (`ssh-keygen -Y verify`).
Then it downloads the release archive and checks it against the list. Anything that does not match
is refused before it runs. The archive brings everything prebuilt: the brain, the bridge, LiveKit,
the app and its own Node 24. It is unpacked in `~/.local/share/yggdrasil/release/<version>/`.

**You need:** Linux x86_64 with glibc 2.31 or newer (Debian 11+, Ubuntu 20.04+) and a systemd user
session, curl, ssh-keygen, libopus, bzip2, python ≥ 3.10 with venv for voice (Debian 12+, Ubuntu
22.04+; older systems: `--skip voice,agent`), and about 2 GB of free disk with voice (about 0.5 GB
without: measured on Debian 12, the install takes 1.9 GB: the release 310 MB, the voice agent 720 MB, speech models 360 MB, the speech server 160 MB, pip cache 260 MB, binaries 80 MB). On Debian/Ubuntu:
`sudo apt install curl ca-certificates openssh-client libopus0 python3-venv bzip2`. On Arch:
`sudo pacman -S curl openssh opus python bzip2`. `install.sh` checks all of this before it downloads
anything and prints the line to run when something is missing. It also turns on lingering
(`loginctl enable-linger`), so the services keep running after you log out and start at boot; when it
may not, it says so (`sudo loginctl enable-linger $USER` does it).

**Developers** (a git checkout): `./install.sh` in `root/install` uses what is built there
(`yggdrasil`, `bifrost-net`, the app's `.next`). With nothing built it installs the signed release
instead. `./install.sh --from-source` builds what is missing with cargo and npm (Node 24).
`scripts/release.sh VERSION` builds and signs a release (`dist/VERSION/`).

## What starts

| unit | what | listens on |
|---|---|---|
| `yggdrasil` | **brain**: chat sessions, relays to your model provider | `127.0.0.1:4100` |
| `bifrost-app` | **app**: the phone UI and its `/api` seam (`node server.mjs`) | `0.0.0.0:8082` |
| `bifrost-bridge` | **bridge**: pairing identity + direct phone↔box transport | `:7890` tcp, `<LAN IP>:7891` udp |
| `bifrost-wg` | **WireGuard node** (with a trunk only): brain calls between your roots, inside WireGuard | `127.0.0.1:7893` tcp, `127.0.0.1:7894-7895` udp |
| `bifrost-voice` | **voice**: local speech-to-text + text-to-speech (sherpa-onnx, CPU) | `127.0.0.1:8000` |
| `bifrost-livekit` | **livekit**: the realtime voice transport (`LIVEKIT_MODE=binary`) | `:7880`, `:7881` tcp, `:7882` udp |
| `bifrost-agent` | **voice agent**: speech in → brain → speech out | `:8081` (health) |

The script installs, enables and (re)starts each unit. Then it health-checks each one and
prints the result. Re-running it is safe. Your config, keys, paired phones and chats are
kept, and a unit is restarted only if something it uses changed.

## Pair your phone

1. **On the computer itself**, open **http://127.0.0.1:8082/pair**, or run `bash install.sh pair`. A QR code appears.
   Only the box's own console may show it.
   - Headless box? From your laptop, run `ssh -L 8082:127.0.0.1:8082 <box>` and open the
     same URL there.
2. **Scan the QR with the phone's camera.** The phone must be on the same Wi-Fi. It opens
   `http://<box LAN IP>:8082/pair`, redeems the one-time code, pins the bridge's fingerprint
   and opens bifrost: the first time, the door walks you in (it ends in your **main** session);
   after that, your sessions. There's nothing to type.
3. **Add it to the home screen** from the browser menu.

Pairing is the lock (`BIFROST_AUTH=devices`). A device that hasn't paired gets `401` on every
`/api` call. You can list or revoke phones at `/devices`.

**From anywhere, not just your Wi-Fi:** connect this computer to [your own trunk](../../docs/own-trunk.md),
a small server you rent. `trunk.sh` on that server prints one connect line. Here you run
`bash install.sh --trunk` and paste the line when it asks (it is not shown, and it never lands in a
command line or your shell's history: it holds a secret). Then `bash install.sh pair` shows the
phone's QR right in the terminal. The phone opens `https://<your trunk>` on Wi-Fi or mobile data,
and the app listens only on `127.0.0.1`. `bash install.sh pair --list` / `--revoke NAME` / `--kill`
manage paired devices from the terminal.

## Where things live

| path | what |
|---|---|
| `~/.config/bifrost/bifrost.env` (600) | **the stack config you edit**: ports, LAN IP, pairing, voice, LiveKit |
| `~/.config/yggdrasil/yggdrasil.env` (600) | the brain: upstream URL, key, model |
| `~/.config/bifrost/{app,agent,voice}.env`, `bridge.toml`, `livekit.yaml` (600) | generated from `bifrost.env` on every run. Don't edit these |
| `~/.config/bifrost/install-manifest.txt` | every file, unit, env key **name** and network call of the last run |
| `~/.config/systemd/user/{yggdrasil,bifrost-*}.service` | the units (644, no secrets inside) |
| `~/.local/state/bifrost/devices.json` | paired phones (the app and bridge share it) |
| `~/.local/state/bifrost/pair-qr.png` (600) | the last pairing QR from `install.sh pair` (one use, 5 minutes) |
| `~/.local/share/bifrost/voice/models/` | speech models (downloaded on first start) |
| `~/.local/bin/{yggdrasil,bifrost-net,livekit-server}` | the binaries |
| `~/.local/share/yggdrasil/release/<version>/` | the unpacked, checked release: the app, its Node, the scripts (the newest two are kept) |

To change something, edit `bifrost.env` and re-run `bash install.sh`. You can also put a setting
on the command line, for example `BIFROST_APP_PORT=8090 bash install.sh`. It is saved to
`bifrost.env`.

**Voice choices** (in `bifrost.env`):
- `SPEACHES_URL=` empty (the default) uses the local `bifrost-voice`. Set it to a Mac MLX
  speech server on your LAN (`http://<mac-ip>:8001/v1`) and the local one isn't installed.
- `LIVEKIT_MODE=binary` (the default) runs the release's `livekit-server` and generates an API key
  and secret. `LIVEKIT_MODE=cloud` uses your LiveKit Cloud project: set
  `LIVEKIT_URL=wss://….livekit.cloud`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

Options: `--no-start` (install only), `--skip voice,agent` (leave components out),
`--direct` (no systemd, see failure 2), `--brain-only` (the brain alone, below),
`--trunk` (your own trunk: paste the line when asked; `--trunk off` removes it; kept as `BIFROST_TRUNK`
in `bifrost.env`), `--upstream-env FILE` (the model, from a file), `--update`, `--uninstall`.

## When it fails

**1. A port is taken.** The script stops *before installing anything* and names the port and
its owner, for example `port t/8082 (wanted by bifrost-app.service) is taken users:(("node",…))`.
Pick a free one in `~/.config/bifrost/bifrost.env` (`BIFROST_APP_PORT`, `BIFROST_BRIDGE_PORT`,
`BIFROST_MEDIA_PORT`, `BIFROST_VOICE_PORT`, `LIVEKIT_PORT` / `_TCP_PORT` / `_UDP_PORT`,
`AGENT_HTTP_PORT`; the brain's is `YGG_LISTEN` in `yggdrasil.env`). Then re-run. A port
held by this install's own running unit is fine.

**2. No systemd user session.** This happens over a bare `ssh`/`su`, in a container, or in
WSL without systemd. The script says `no systemd user session here`, writes the units and
starts nothing.
- On a normal box, log in properly once and run `sudo loginctl enable-linger $USER`, so the
  services also run while you're logged out and after a reboot. Then re-run `bash install.sh`.
- Without systemd at all, run `bash install.sh --direct`. It runs each unit's own command under
  `nohup`, with logs in `~/.local/state/bifrost/log/`. Re-run it after every reboot.

**3. Voice models.** `bifrost-voice` downloads its speech models (~200 MB, from the
sherpa-onnx GitHub releases) on its **first start**. Until then the health check shows it as
starting. Follow it with `journalctl --user -u bifrost-voice -f`.
- If python is missing, the script says `voice skipped — needs python ≥ 3.10`. Install it
  (`sudo pacman -S python` / `sudo apt install python3-venv`) and re-run. Everything else
  works without voice.
- On an offline box, copy `~/.local/share/bifrost/voice/models/` from a box that has it.

**4. Firewall: the phone can't reach the box.** The QR opens but the page never loads, or
pairing hangs. Allow the LAN in, then reload the page on the phone:

```sh
# ufw
sudo ufw allow from 192.168.0.0/16 to any port 8082,7890,7880,7881 proto tcp
sudo ufw allow from 192.168.0.0/16 to any port 7891,7882 proto udp
# firewalld
sudo firewall-cmd --permanent --add-port={8082,7890,7880,7881}/tcp --add-port={7891,7882}/udp && sudo firewall-cmd --reload
```

Also check that the phone is on the same Wi-Fi (not a guest network with client isolation)
and that the QR's address is the box's real LAN IP. If the box has several addresses, set
`BIFROST_LAN_IP` in `bifrost.env` and re-run.

**Known limits (v0.9):**
- **Talking from the phone needs https.** Browsers only open the microphone on a secure
  origin, and `http://<LAN IP>` isn't one. On the LAN you can type and hear replies; to talk,
  put the app behind https, for example `tailscale serve`.
- **LiveKit voice in `devices` mode is for paired phones only.** The app's `/api/token` route
  mints a voice token for a paired device (the box's own console gets none). Through
  [your own trunk](../../docs/own-trunk.md#voice-through-the-trunk) the phone's audio rides port
  443 of the trunk (ICE over TCP) to LiveKit here; on your own Wi-Fi it needs https first (above).

Logs: `journalctl --user -u yggdrasil -u 'bifrost-*' -f`. Status:
`systemctl --user status yggdrasil 'bifrost-*'`.

## Brain only

`bash install.sh --brain-only` installs only yggdrasil, as before. That means the binary,
`~/.config/yggdrasil/yggdrasil.env`, the unit and the session store. It starts nothing unless
you add `--now`. Use it to put yggdrasil under an existing bifrost: set
`OPENCODE_URL=http://127.0.0.1:4100` for the app and the agent. **Arch package instead:**
`makepkg -si` in this directory (brain only; see `PKGBUILD`).

Brain settings (`yggdrasil.env`, documented inline): `YGG_UPSTREAM_BASE_URL` (required),
`YGG_UPSTREAM_API_KEY`, `YGG_UPSTREAM_MODEL`, `YGG_UPSTREAM_STYLE=anthropic` (for example
`https://api.z.ai/api/anthropic`), and `YGG_LISTEN` (keep it on 127.0.0.1: it has no
authentication). Check the brain alone:

```sh
curl -s http://127.0.0.1:4100/session        # 200 + a JSON list
```

## Join an existing tree

`join.sh` makes another machine (Linux; macOS from a checkout) one more **root** of a tree that
already runs: the hub is up and your phone is paired with it. The new root only **dials out**,
to the hub's public access point (`wss://<hub>/rootlink`). It needs no open port, no public IP
and no certificate, and the phone doesn't have to be on the same Wi-Fi. No sudo.

```sh
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.2/join.sh
bash join.sh --hub https://tree.example.org
```

In a terminal it asks for this computer's **model provider**, the same step as on the home computer
with one more choice, the first: **Same as the home root**. With it nothing is typed: when you
approve the computer on your phone, your home computer hands it its model settings inside the root
link (WireGuard, end to end; the trunk carries ciphertext), and the new computer then calls the
provider itself. It is also what a join without a terminal does when no model is given. Removing a
computer later does not take back a key it was given: change the key at the provider for that.
Otherwise pick a provider and type its key (read without echo), or pass `--model-provider NAME` with
`YGG_UPSTREAM_API_KEY` in the environment, or `--upstream-env FILE` in the same format as
`yggdrasil.env`. The key is written only to `brain.env` (mode 600) and is never printed.
Like `install.sh`, the `join.sh` you download fetches its release, checks the signature and the
checksum, unpacks it and runs that release's `join.sh`: the brain and the node come prebuilt.

What happens:
1. **Brain binary.** It uses `--brain-bin`, then `bin/yggdrasil` from an earlier run, then the
   release's, a checkout's `root/target/release/yggdrasil`, `~/.local/bin` or `PATH`. If none is
   there, it fetches the signed release (Linux/WSL x86_64). **The tunnel's node** (`bifrost-net`):
   `--net-bin`, then `bin/bifrost-net`, the release's root build (`bin/bifrost-net-root`: no libopus
   needed), a checkout's build, `~/.local/bin` or `PATH`; else the signed release's asset. macOS and
   other CPUs have no release yet: from a git checkout, `--build` builds both with cargo (the node's
   **root build**, `--no-default-features`: no cmake, no libopus). It makes the WireGuard key `wg.key`
   (mode 600).
2. **Join request.** `POST <hub>/api/roots/join {name, os, host, wg_pub}`. A **QR of the approve URL**
   appears in the terminal (`qrencode -t ANSIUTF8` if it's installed, otherwise a built-in
   encoder). It's also saved as a PNG (`--qr-png`, opened with `--open-qr`). The code, the tunnel
   key's fingerprint and the URL are printed below it.
3. **Approve.** Scan the QR with the paired phone, check that the code (and the tunnel key) on the
   phone matches, and approve: that pins this machine's key on the hub. `join.sh` polls until the request is approved, refused or expired. Ctrl-C keeps the
   request, and re-running resumes it with the same QR.
4. **Save.** It stores `root_secret`, the single-use **link tokens** (mode 600) and `rootlink_url`.
   Then it writes `brain.env`: loopback `YGG_LISTEN`, `YGG_DATA_DIR`,
   `YGG_ROOT_NAME=<root_id>`, `YGG_PEERS=<hub>=http://127.0.0.1:<peer port>/_wg/local`,
   `YGG_PEERS_FROM=…/_wg/_roots`, `YGG_PEERS_VIA=…/_wg/{id}` and `YGG_PEER_TOKEN`. `<hub>` is
   the hub brain's root name, from the approval's `hub` (`hub` when an older hub sends none). The
   joined root's reports go home to that name, inside WireGuard; the other roots of the tree come
   from the hub's directory. And `wg.toml`: this root's node, with the hub's key from the approval.
   (An older hub that grants no tunnel: `YGG_PEERS=<hub>=http://127.0.0.1:<peer port>/local`, the
   old plaintext path, and no node.)
5. **Start.** It runs the brain, `bifrost-net wg -c wg.toml`, and
   `root-dial.py --tls --host --port --path --token-file --brain --wg-udp --wg-node`. Before every dial,
   and every 5 minutes, it tops up the link tokens through
   `POST <hub>/api/roots/<root_id>/tokens` when fewer than 5 are left.

| supervisor (`--supervisor auto` picks) | units |
|---|---|
| **systemd --user** (Linux, or WSL with systemd) | `yggdrasil-root-brain.service`, `yggdrasil-root-dial.service`, `yggdrasil-root-wg.service`, `yggdrasil-root-refill.timer` (+ linger, best effort) |
| **launchd** (macOS) | `~/Library/LaunchAgents/org.veraldar.yggdrasil-root.{brain,dial,wg,refill}.plist` |
| **nohup** (no user manager: containers, WSL without systemd) | `bin/supervise` restarts all of them. Logs are in `log/`. After a reboot, run `join.sh` again or `bin/start` |

Everything lives in `~/.local/share/yggdrasil-root` (`--dir`, mode 700): `root.json` (root id, root
secret, hub, the hub brain's name, rootlink URL), `link-tokens`, `brain.env`, `root.conf` (ports, name; no secrets),
`wg.key` (+ `.pub`) and `wg.toml` (the node), `bin/` (`yggdrasil`, `bifrost-net`, `root-dial.py`,
`rootjoin.py`, `run-brain`, `run-wg`, `run-dialer`, `start`, `stop`),
`data/`, `log/`.

**Re-running is safe.** With an existing join, `join.sh` (no options needed) sends no new request.
It refreshes the files and restarts only if something changed. `--rejoin` asks the hub again; the
old join stays until the new one is approved, and so does its key (the new join brings a fresh one).
A root that joined before the tunnel (no key in `root.json`) joins again by itself, with a key:
approve it on the phone once more. A different `--hub` without `--rejoin` is refused.
`--stop` stops the services; `--uninstall` stops them and removes the root (it lists what goes and
asks first; `-y` skips the question). Other options: `--name` (default: the hostname),
`--brain-port`/`--peer-port` (default 4180/4181, or the next free pair), `--project-dir` (default
`$HOME`), `--no-start`, `--build`. `--cacert` is only for tests against a self-signed hub.
Exit codes: `0` joined and running · `3` refused on the phone · `4` expired · `64` usage · `1` other.

**Windows: `Veraldar-Setup-<version>.exe`** (built by `scripts/build-win.sh`, see `win/README.txt`).
One window, no terminal: it checks Windows and WSL2 (installing WSL with one UAC prompt and a
restart when it is missing), sets up the Linux user and packages without a question, asks for the
trunk address, runs this release's stamped `join.sh` (embedded byte for byte) inside WSL through
`win/wsl-bootstrap.sh`, and shows the code and the QR in its own window until the phone approves.
`keepalive.vbs` -> `launcher.bat` starts the root and keeps WSL awake, at logon too. Failures end
with a step code (W-OS, W-WSL, W-NET, W-SIG, W-JOIN, W-MODEL, W-RUN) and
`%LOCALAPPDATA%\Veraldar\install-report.txt`. Tested under wine with a fake `wsl.exe`; not yet run
on a real Windows PC (`win/NOTES-win.md`).

**Tests:**
- `./join-test.sh` runs locally; `./join-test.sh --docker` runs in a clean `ubuntu:24.04`. Both
  use a fake hub that speaks the contract above and a fake trunk on `/rootlink` that needs the
  real `root-dial.py` to link and earn a pong. They need `python3 openssl zbar-tools`.
- `win/launcher-test.sh` runs the installer under wine (Xvfb, xdotool) with a scripted fake
  `wsl.exe` that runs the real `wsl-bootstrap.sh`: a case per step code. `win/bootstrap-test.sh`
  runs `wsl-bootstrap.sh` in a fresh Ubuntu container.

## Upgrade / uninstall

Upgrade: `bash install.sh --update`. It fetches the newest release, checks it like the first one
(never an older one), installs it, and restarts only what changed. Your config, keys, paired phones
and chats are kept.

Uninstall: `bash install.sh --uninstall`. It lists everything it removes (the units, the binaries,
`~/.config/{bifrost,yggdrasil}`, `~/.local/share/{bifrost,yggdrasil}` with your chats,
`~/.local/state/bifrost` with the paired phones and keys) and asks first; `-y` skips the question.
The unpacked release (`~/.local/share/yggdrasil/release/`: the app, its Node, the scripts) goes too —
to install again, download `install.sh` again. A computer that also joined another tree keeps that join (`bash join.sh --uninstall`).
