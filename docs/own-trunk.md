# Your own trunk — reach your tree from anywhere

Your phone talks to your home computer from anywhere, on Wi-Fi or mobile data, through a small
server **you** rent. Nothing at home opens a port: your home computer dials out to the server and
keeps that line open. No Tailscale, no account with us.

```
phone ──https──▶ your server (the trunk) ◀──dials out── your home computer (the hub: brain + app)
                         ▲
other computers ─────────┘  (they dial out too, and join your tree)
```

## What you need

- **A small server (VPS)** from a provider you choose, in the country you choose: Linux x86_64 with
  systemd and glibc 2.31 or newer — Debian 11 or newer, or Ubuntu 20.04 or newer (tested on Debian 12).
  `trunk.sh` checks this before it installs anything. The smallest plan is enough (1 CPU, 512 MB). You need its admin access
  (`sudo`).
- **A name for it**, for example `trunk.example.org`: a DNS record (type A, plus AAAA if the server
  has IPv6) on a domain you own, pointing at the server's address.
- **Ports 80 and 443 open** on the server, including in your provider's firewall panel. Port 443
  carries everything. Port 80 is only for Let's Encrypt, which checks that the name is yours.
- **Your home computer** with yggdrasil installed, or about to be (`root/install/README.md`).

Every file comes from a **release** of github.com/veraldar/yggdrasil (this guide: `v0.9.1`; the newest
is on the releases page). The scripts check what they download before they run any of it: the release's
list of checksums must be signed by the yggdrasil release key, which is written into each script, and
every file must match that list. A changed or foreign release is refused, and nothing is installed.

## The four steps

**1. On the server: install the trunk.**

```sh
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/trunk.sh
sudo bash trunk.sh --name trunk.example.org
```

It installs what it needs, downloads the trunk program and checks it (signature, then checksum). It
makes the server's key and gets a Let's Encrypt certificate, which renews by itself. It also sets the
server up safely: the firewall on (only ssh, 443, and 80 for Let's Encrypt open), Debian's automatic
security updates on, and a weekly check for a newer yggdrasil release, installed only when it is signed.
It ends with **one connect line** for your home computer, `wss://trunk.example.org/ap#pin=…,token=…`,
and tells you what to do with it.

Copy the line, but don't put it in a command: **the token in it is a secret, and it is shown only
once.** You paste it at home when `install.sh` asks (step 2). The server keeps only a fingerprint of
it. If you lose the line, `sudo bash trunk.sh --rotate-token` prints a new one, and the old one stops
working.

Want to check the download yourself first? The release key is in the repository (`allowed_signers`):

```sh
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/SHA256SUMS
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/SHA256SUMS.sig
echo 'release@yggdrasil namespaces="yggdrasil-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJyKwTSmRf3Cy1cHpzKHl3teRvCQtgK8/dcFRvlNCDJg' >allowed_signers
ssh-keygen -Y verify -f allowed_signers -I release@yggdrasil -n yggdrasil-release -s SHA256SUMS.sig <SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
```

Running a website on that server already? See [A website on the same server](#a-website-on-the-same-server).

**2. At home: connect to your trunk.**

```sh
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/install.sh
bash install.sh --trunk
```

When it asks, paste the connect line and press Enter (it is not shown while you paste, and it never
lands in your shell's history). On a first install it also asks for your model provider (Z AI, OpenRouter,
Anthropic, OpenAI or Other) and its API key (the key is not shown either). It downloads the release, checks it, and installs it
all, prebuilt: you need no developer tools. At the end it checks the whole path. Look for
`trunk https://trunk.example.org/pair → 200`.

**3. Your phone: scan.**

```sh
bash install.sh pair
```

A QR code appears in the terminal. Scan it with the phone's camera within 5 minutes. The phone opens
`https://trunk.example.org` and pairs itself: the first time it walks you through the door, then it
shows your sessions. Add it to the home screen. Hold the tree to talk: voice works through the trunk
too (see [Voice through the trunk](#voice-through-the-trunk)).

**4. More computers: join them.** On each one (Linux; Windows is untested in this release):

```sh
curl -fsSLO https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/join.sh
bash join.sh --hub https://trunk.example.org
```

It asks for that computer's model provider; the first choice, **Same as the home root**, needs nothing
typed. It then shows a QR code. Scan it with your paired phone, check that the code matches, and tap
**Add to my tree**: with "Same as the home root" your home computer then hands the new one its model
settings inside the root link. Your main session can now start work on that computer, and its results come home
(`root/install/README.md`, "Join an existing tree").

## Taking access away

- **A phone:** run `bash install.sh pair --list`, then `bash install.sh pair --revoke NAME`, or revoke
  it from another phone under `/devices`. Its next request is refused, and live connections are cut
  within a second. Not sure which phone? `bash install.sh pair --kill` revokes every device.
- **Your home computer's line to the trunk:** on the server, run `sudo bash trunk.sh --rotate-token`.
  Then run `bash install.sh --trunk` at home and paste the new line.
- **A joined computer:** its link tokens belong to the phone that approved it. Revoking that phone
  stops new links. There is no button for a single computer yet (`docs/spec-join.md`, "Limits").
- **The trunk itself:** `bash install.sh --trunk off` at home goes back to your own Wi-Fi only. On
  the server, `sudo bash trunk.sh --uninstall` lists what it removes and asks first: the service, the
  timers, the key and certificate, the program and the firewall rules it added.

## What the server can see

**Before pairing**, and for the app itself, your phone's connection is encrypted up to the trunk:
the trunk decrypts each request to route it, then sends it home over its own encrypted line, which
your home computer accepts only from that server's key.

**After pairing, your data skips it.** The pairing QR also carries your home computer's key (its
fingerprint). From then on the phone opens its own encrypted channel straight to your home computer
(WebRTC, keyed by that fingerprint) and sends everything over it: your messages, the answers, your
files, your voice and the spoken replies. The server passes those bytes along on port 443 without
any key for them. A small line at the bottom of the screen says which road the phone is on:

- **end to end**: the pinned channel is up. The server sees encrypted bytes, nothing else.
- **via the trunk's TLS**: the channel could not come up (a network that blocks it). The phone
  falls back to the trunk's line, as before: then the server *can* read what passes.
- **reconnecting — nothing sent meanwhile**: the channel was up and dropped (your home computer
  restarting, the network blinking). The phone opens it again by itself; until then it sends
  nothing, and never switches to the trunk's line on its own.
- **box key mismatch — nothing sent**: the key that came back is not the one in the QR. Someone in
  the middle, maybe the server itself. The phone refuses and sends no data at all.

The limits, plainly:
- The app's code (its pages and scripts) still comes from the server, like any website. A server
  that is actively malicious could serve changed code. The pinned channel protects what you send
  and receive, not the code that sends it. So the trunk must still be a server you rent and trust,
  in a country you choose, and never one run by someone else.
- Pairing itself (the one-time code in the QR) passes through the server's line.

The trunk does **not** hold your model key, your sessions or your files. Those stay at home. On the
server there is only its own key and certificate and a fingerprint of your home computer's token.

## Voice through the trunk

Nothing extra to open: voice uses port 443 too. When you talk, the phone sends its audio over TCP to
`trunk.example.org:443`. The server recognizes that connection by its first bytes (ICE over TCP, not
TLS) and passes it, untouched, to your home computer over the line your home computer opened. There,
LiveKit and the voice agent turn your speech into text for your main session and the reply into
speech. UDP is not needed.

- **What it needs:** `trunk.sh` from this version on the server (re-run it once:
  `sudo bash trunk.sh`), and yggdrasil at home with voice installed (the default,
  `LIVEKIT_MODE=binary`).
- **Behind `sni-443.py`** (a website on the same server): its config needs the line
  `ice 127.0.0.1:4479`. `trunk.sh` writes it in a new config and warns when an existing one lacks it.
  Then run `sudo systemctl restart yggdrasil-sni-443`. With nginx's `stream { … }` instead, voice
  needs `sni-443.py` (nginx cannot tell ICE from other bytes).
- **Only paired phones** get a voice line, and its setup (LiveKit's signaling) rides the pinned
  channel too: the server cannot swap the call's keys. Revoking a phone cuts its call and its
  channel within a second.
- **Tested** by `sim/trunk-rtc-e2e.sh`: a phone, the server and a home computer, each allowed only
  TCP 443 to the server, with the real voice agent and speech engines.

## A website on the same server

If port 443 already serves a website, `trunk.sh` stops and installs nothing. Run it again with
`--behind-proxy`:

```sh
sudo bash trunk.sh --name trunk.example.org --behind-proxy
```

The trunk then listens only on `127.0.0.1:4443`. The script prints two ways to share port 443 by
name. Your website keeps its own certificate and nobody else's traffic is decrypted:

- **A:** our small router, `sni-443.py`. Move your website's HTTPS to `127.0.0.1:8443`, then run
  `sudo systemctl enable --now yggdrasil-sni-443`.
- **B:** nginx routes by name itself, with the `stream { … }` block the script prints.

If your web server also holds port 80, the script prints the few lines to add to it (for nginx,
caddy or apache) so that Let's Encrypt can check the name. After adding them, run
`sudo bash trunk.sh --webroot /var/lib/yggdrasil-trunk/acme`. Until then the trunk runs with a
temporary certificate. Your home computer already connects (it trusts the key, not the
certificate), but phones refuse the page.

## Good to know

- **Re-running is safe.** `sudo bash trunk.sh` with no options renews the certificate when it is due.
  It keeps the key and the token, so your home computer needs nothing new. `bash install.sh --trunk`
  run again keeps your paired phones.
- **Updates.** The server installs Debian's security updates every day, and once a week it checks for
  a newer yggdrasil release: only one signed by the release key is installed, never an older one.
  `sudo bash trunk.sh --update` does the same check right away. The trunk that ran before is kept:
  if the new one does not start or answer, it is put back and restarted by itself. At home:
  `bash install.sh --update`. To manage this yourself, run trunk.sh once with `--no-auto-updates`.
- **The firewall.** If it was off, `trunk.sh` turns it on (ufw) with only ssh and the trunk's ports
  open. If other services listen on the server, it leaves the firewall alone and tells you which ones.
  `--no-firewall` leaves it alone for good.
- **Voice over the trunk** works from anywhere ([above](#voice-through-the-trunk)). Slow mobile
  data adds its delay to every word, both ways.
- **Moving to another server or name:** run step 2 again and paste the new line. Then pair your phones again
  (the new address is a new website for them), and join other computers again with
  `bash join.sh --rejoin --hub https://<new name>`.
- **Files on the server:** `/etc/yggdrasil-trunk/` holds the key (mode 600), the certificate,
  `ap.toml` and your choices (`trunk.conf`). The services are `yggdrasil-trunk`, the daily
  `yggdrasil-trunk-cert.timer` and the weekly `yggdrasil-trunk-update.timer`. Logs:
  `journalctl -u yggdrasil-trunk`.
- **Tested** by `sim/own-trunk-e2e.sh`: fresh machines in docker, the signed release, a simulated
  phone, and Let's Encrypt's test server (Pebble). It also serves forged releases (changed, unsigned,
  signed by another key) and checks that each one is refused. Real Let's Encrypt is the same
  protocol, but the simulation does not reach it.
