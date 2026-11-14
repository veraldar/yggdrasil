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

- **A small server (VPS)** from a provider you choose, in the country you choose. Debian 12 or newer,
  or Ubuntu 22.04 or newer. The smallest plan is enough (1 CPU, 512 MB). You need its admin access
  (`sudo`).
- **A name for it**, for example `trunk.example.org`: a DNS record (type A, plus AAAA if the server
  has IPv6) on a domain you own, pointing at the server's address.
- **Ports 80 and 443 open** on the server, including in your provider's firewall panel. Port 443
  carries everything. Port 80 is only for Let's Encrypt, which checks that the name is yours.
- **Your home computer** with yggdrasil installed, or about to be (`root/install/README.md`).

## The four steps

**1. On the server: install the trunk.**

```sh
curl -fsSLO https://raw.githubusercontent.com/veraldar/yggdrasil/main/trunk/install/trunk.sh
sudo bash trunk.sh --name trunk.example.org
```

It installs what it needs, downloads the trunk program and checks it against the release's
checksums. It also makes the server's key and gets a Let's Encrypt certificate, which renews by
itself. It ends with **one line** for your home computer:

```
./install.sh --trunk 'wss://trunk.example.org/ap#pin=AB:CD:…,token=…'
```

Copy it. **The token in it is a secret, and it is shown only once.** The server keeps only a
fingerprint of it. If you lose the line, `sudo bash trunk.sh --rotate-token` prints a new one, and
the old one stops working.

Running a website on that server already? See [A website on the same server](#a-website-on-the-same-server).

**2. At home: connect to your trunk.** In the folder `yggdrasil/root/install`, paste the line:

```sh
./install.sh --trunk 'wss://trunk.example.org/ap#pin=AB:CD:…,token=…'
```

On a first install, also give it your model, as in `root/install/README.md`. At the end it checks
the whole path. Look for `trunk https://trunk.example.org/pair → 200`.

**3. Your phone: scan.**

```sh
./install.sh pair
```

A QR code appears in the terminal. Scan it with the phone's camera within 5 minutes. The phone opens
`https://trunk.example.org` and pairs itself: the first time it walks you through the door, then it
shows your sessions. Add it to the home screen. Hold the tree to talk: voice works through the trunk
too (see [Voice through the trunk](#voice-through-the-trunk)).

**4. More computers: join them.** On each one (Linux, macOS, Windows with WSL2):

```sh
./join.sh --hub https://trunk.example.org
```

It shows a QR code. Scan it with your paired phone, check that the code matches, and tap **Add to my
tree**. Your main session can now start work on that computer, and its results come home
(`root/install/README.md`, "Join an existing tree").

## Taking access away

- **A phone:** run `./install.sh pair --list`, then `./install.sh pair --revoke NAME`, or revoke it
  from another phone under `/devices`. Its next request is refused, and live connections are cut
  within a second. Not sure which phone? `./install.sh pair --kill` revokes every device.
- **Your home computer's line to the trunk:** on the server, run `sudo bash trunk.sh --rotate-token`.
  Then run `./install.sh --trunk '<the new line>'` at home.
- **A joined computer:** its link tokens belong to the phone that approved it. Revoking that phone
  stops new links. There is no button for a single computer yet (`docs/spec-join.md`, "Limits").
- **The trunk itself:** `./install.sh --trunk off` at home goes back to your own Wi-Fi only. On the
  server: `sudo systemctl disable --now yggdrasil-trunk yggdrasil-trunk-cert.timer`.

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
  `sudo bash trunk.sh`), and `./install.sh --trunk '<line>'` again at home with voice installed (the
  default, `LIVEKIT_MODE=binary`).
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

- **Re-running is safe.** `sudo bash trunk.sh` with no options updates the program and renews the
  certificate when it is due. It keeps the key and the token, so your home computer needs nothing
  new. `./install.sh --trunk '…'` run again keeps your paired phones.
- **Voice over the trunk** works from anywhere ([above](#voice-through-the-trunk)). Slow mobile
  data adds its delay to every word, both ways.
- **Moving to another server or name:** run step 2 with the new line. Then pair your phones again
  (the new address is a new website for them), and join other computers again with
  `./join.sh --rejoin --hub https://<new name>`.
- **Files on the server:** `/etc/yggdrasil-trunk/` holds the key (mode 600), the certificate,
  `ap.toml` and your choices (`trunk.conf`). The services are `yggdrasil-trunk` and the daily
  `yggdrasil-trunk-cert.timer`. Logs: `journalctl -u yggdrasil-trunk`.
- **Tested** by `sim/own-trunk-e2e.sh`: fresh machines in docker, the real scripts, a simulated
  phone, and Let's Encrypt's test server (Pebble). Real Let's Encrypt is the same protocol, but
  the simulation does not reach it.
