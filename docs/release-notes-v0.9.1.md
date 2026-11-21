**yggdrasil v0.9.1** — every computer a root in your tree, one phone for all of them: Linux, Apple-silicon Macs, and Windows (beta).

Install (each script checks the release's signed SHA256SUMS against the key written into it before anything runs):

```
# your own trunk, on a small server
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/trunk.sh && sudo bash trunk.sh --name trunk.example.org
# your home computer
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/install.sh && bash install.sh --trunk
# another computer (Linux, WSL2, or a Mac with Apple silicon)
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/join.sh && bash join.sh --hub https://trunk.example.org
```

Windows: download `Veraldar-Setup-0.9.1.exe` and open it. It sets up WSL2 if needed, asks for your trunk's
address and the model, and shows a code to approve on your phone. It is not code-signed yet: Windows shows "Windows protected your
PC" — tap **More info → Run anyway**.

Verify by hand: `ssh-keygen -Y verify -f allowed_signers -I release@yggdrasil -n yggdrasil-release -s SHA256SUMS.sig < SHA256SUMS && sha256sum --ignore-missing -c SHA256SUMS`.

### The whole tree (`root/src/roots.rs`, `branch/`)
- **Every computer has its own MAIN, all on one phone.** The home screen has a roots key: one row per computer
  with its state; tap one for its own MAIN and its sessions, start a session there, hold to remove it.
- **Any MAIN may place work on any root.** Work handed on more than twice is refused (no two MAINs passing a job
  back and forth), and the home root is told about work placed between two other roots, so the phone lists it.
- **Calls between roots carry the tree's peer token on every route**, and ride a WireGuard tunnel end to end
  (the home root runs its own node: `hub-units.sh wg-on`).

### Sessions on other computers, and files (`root/src/`, `branch/`)
- **A session on another root is a full session:** its text arrives live, cancel works, and the mic works
  (speech stays on the home root; other roots need nothing for voice).
- **Files are files:** the paperclip takes any file, for any session on any root; a file a session makes opens
  on the phone wherever it was made. A file is stored once, on the root that receives it; messages carry a
  reference.
- **Answered the way you asked:** a turn you speak is answered aloud, a turn you type in writing.

### The home root (`scripts/hub-units.sh`, `root/src/`, `branch/voice/`)
- **Services that survive a reboot, from a frozen release folder:** brain, apps, bridge, librarian, voice agent.
  A deploy backs the data up, lets short turns finish, checks health and goes back by itself when the check fails.
- **A turn cut by a restart comes back once**, rebuilt from what is true now, never re-sent as its old text.
- **Voice:** one agent job serves a room and says so; the same words said again are a new turn; a page change no
  longer drops the job mid-hold.
- **No step cap by default** (a session can set one); the session list is in your order; a message from another
  session names its sender.

### Installers (`root/install/`, `trunk/install/`, `win/`, `scripts/`)
- **The model step, the same on every system** (`install.sh`, `join.sh`, the Windows installer): *Model provider* —
  Same as the home root · Z AI · OpenRouter · Anthropic · OpenAI · Other. A provider asks only its key; its
  address is filled in and its default model can be changed. *Other* takes any OpenAI- or Anthropic-compatible
  address, with no key for a model on your own network. Without a terminal: `--model-provider NAME [--model M]`
  with the key in `YGG_UPSTREAM_API_KEY` (never on the command line).
- **Same as the home root** (the default for a computer that joins): nothing is typed. When you approve the
  computer on your phone, your home computer hands it its model settings inside the root link (WireGuard, end to
  end — the trunk server carries ciphertext). The new computer then calls the provider itself, so it keeps
  thinking when the home computer is off. Removing a computer does not take back a key it was given: change the
  key at the provider for that.
- **Apple-silicon Macs get a prebuilt root:** `yggdrasil-0.9.1-macos-aarch64.tar.gz` (the brain and the node's root
  build, compiled on a Mac, signed with the rest). `join.sh` picks it the way it picks the Linux archive and installs
  launchd agents; no Rust, no Xcode project, no git. Intel Macs: `join.sh --build` from a checkout.
- **Windows in one file:** `Veraldar-Setup-0.9.1.exe` — checks Windows 10 2004+/11, installs WSL2 when missing
  (one admin prompt, continues by itself after the restart), asks the model step above, runs this release's own
  `join.sh` inside WSL, shows the
  code and the QR in its window, starts the root at every log-on. A failure ends on a short step code
  (`W-OS`, `W-WSL`, `W-NET`, `W-SIG`, `W-JOIN`, `W-MODEL`, `W-RUN`) and `%LOCALAPPDATA%\Veraldar\install-report.txt`
  (no secrets in it). Uninstall leaves WSL alone.
- **`trunk.sh --adopt DIR`** takes over an access point set up by hand: its key (so the pin your hub trusts), the
  hub's token (so the connect line), its certificate, port and :443 router are kept; the old service is stopped only
  when the new one answers, and put back when it does not.
- **`trunk.sh` behind a :443 router** now really checks that a new trunk answers (the check could not fail before,
  so a broken update was never rolled back there).
- **The release itself:** the `v0.9.1` tag is made by `scripts/release.sh` at the commit the release is built from;
  it refuses a tag that points elsewhere and a tree holding a private key.

Tag `v0.9.0` predates the v0.9.0 release: its assets were built from `0c4ede5c`, not from the commit the tag names.

### Proven on
| System | How | Status |
|---|---|---|
| Linux (Debian 12, only TCP 443 out) | the release in a clean container, approved on a phone | _filled in from the run_ |
| macOS (Mac Studio, macOS 26) | the release over ssh, approved on the phone | _filled in from the run_ |
| Windows | the owner's own run | beta until then |
