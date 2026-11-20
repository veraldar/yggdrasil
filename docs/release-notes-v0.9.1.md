<!-- DRAFT — the GitHub release body for v0.9.1. The installer part (package 4) is written; the parts of
     packages 1–3 are added when they are merged into tree-next. Proof status per system is filled in from the
     runs, never ahead of them. -->
**yggdrasil v0.9.1** — every computer a root in your tree: Linux, Apple-silicon Macs, and Windows (beta).

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
address, and shows a code to approve on your phone. It is not code-signed yet: Windows shows "Windows protected your
PC" — tap **More info → Run anyway**.

Verify by hand: `ssh-keygen -Y verify -f allowed_signers -I release@yggdrasil -n yggdrasil-release -s SHA256SUMS.sig < SHA256SUMS && sha256sum --ignore-missing -c SHA256SUMS`.

### Installers (`root/install/`, `trunk/install/`, `win/`, `scripts/`)
- **Apple-silicon Macs get a prebuilt root:** `yggdrasil-0.9.1-macos-aarch64.tar.gz` (the brain and the node's root
  build, compiled on a Mac, signed with the rest). `join.sh` picks it the way it picks the Linux archive and installs
  launchd agents; no Rust, no Xcode project, no git. Intel Macs: `join.sh --build` from a checkout.
- **Windows in one file:** `Veraldar-Setup-0.9.1.exe` — checks Windows 10 2004+/11, installs WSL2 when missing
  (one admin prompt, continues by itself after the restart), runs this release's own `join.sh` inside WSL, shows the
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
