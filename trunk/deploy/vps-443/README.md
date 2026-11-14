# The VPS's :443 for the end design — a kit, not applied by anything

Today's VPS answers :443 with a hand-made byte-peek dispatcher (three rules: STUN → coturn,
the trunk's TLS name → the access point with a PROXY v1 line, everything else → the website).
The end design adds one rule: a paired phone's ICE over TCP (the pinned channel and voice,
DTLS/SRTP end to end — opaque on the VPS) → the access point's raw `livekit-ice` forward. This
kit swaps the dispatcher for `trunk/deploy/sni-443.py` with a config that keeps the three rules
and adds the fourth. Names and addresses are parameters: `AP_NAME` (the trunk's TLS name),
`VPS_IP` (where coturn listens), ports default to today's (ap 4443, website 8443, ICE 4479).

| file | what |
|---|---|
| `sni-443.conf.in` + `make-conf.sh` | `make-conf.sh AP_NAME VPS_IP > sni-443.conf` |
| `ap.toml.add` | append to the ap's `ap.toml`: the `[[ap.tcp]] livekit-ice` forward on 127.0.0.1:4479 |
| `yggdrasil-sni-443.service` | the unit (DynamicUser + CAP_NET_BIND_SERVICE; `Conflicts=turn-dispatcher`) |
| `superset-test.py` | proof, on any machine: today's test cases pass against sni-443.py with this config |
| `dispatch-cases.py` | today's dispatcher test, case for case, names as parameters, + the ICE cases |

## Prove it first (on the home machine; nothing touches the VPS)

    trunk/deploy/vps-443/superset-test.py                          # the ported cases + ICE: GREEN
    trunk/deploy/vps-443/superset-test.py --old <today's dispatch_test.py> --name <AP_NAME>
                                                                   # YOUR test, unmodified: GREEN

`--old` puts a shim named `turn-dispatcher.py` next to a copy of your test: the dispatcher's
interface (`handle`, `sni_of`, the `CADDY` / `COTURN` / `AP` backends the test rebinds), served by
sni-443.py with exactly the rendered config. One difference, outside every test: a connection
that closes before 8 bytes is forwarded to the website instead of dropped.

## The steps (the owner runs them; each is undoable)

The access point must be this tree's build (it routes `/offer`, carries the raw `livekit-ice`
forward and the hub's ICE demux): `cargo build --release` in `trunk/` inside `rust:1-bookworm`
(glibc 2.36 runs on Debian 13; the full build links libopus — `apt install libopus0` on the VPS).

1. **Stage** (from home): copy to the VPS's `/tmp`: `sni-443.py`, the rendered `sni-443.conf`,
   `yggdrasil-sni-443.service`, the new ap binary as `trunk-ap`.
2. **The ap first** (the hub's bridge re-dials by itself; the ap's key, hence the pin, is unchanged):

       sudo cp -p /etc/trunk-ap/ap.toml /etc/trunk-ap/ap.toml.pre-ice
       sudo cp -p /usr/local/bin/trunk-ap /usr/local/bin/trunk-ap.pre-ice
       cat ap.toml.add | sudo tee -a /etc/trunk-ap/ap.toml >/dev/null
       sudo install -m 755 /tmp/trunk-ap /usr/local/bin/trunk-ap
       sudo systemctl restart trunk-ap && journalctl -u trunk-ap -n 8 -o cat   # "ap: tcp 'livekit-ice' 127.0.0.1:4479 — LIVE"

   Undo: put the two `.pre-ice` files back, restart trunk-ap.
3. **The dispatcher swap** (one command: ~1 s without :443):

       sudo install -d /usr/local/lib/yggdrasil-trunk
       sudo install -m 644 /tmp/sni-443.py /usr/local/lib/yggdrasil-trunk/sni-443.py
       sudo install -m 644 /tmp/sni-443.conf /etc/trunk-ap/sni-443.conf
       sudo install -m 644 /tmp/yggdrasil-sni-443.service /etc/systemd/system/
       sudo systemctl daemon-reload
       sudo systemctl stop turn-dispatcher && sudo systemctl start yggdrasil-sni-443

   Undo: `sudo systemctl stop yggdrasil-sni-443 && sudo systemctl start turn-dispatcher`.
4. **Check from outside**: the website `curl -sI https://<site>/` → 200; the trunk
   `curl -s -o /dev/null -w '%{http_code}' https://<AP_NAME>/pair` → 200 (503 = the hub is not
   connected); TURN: a STUN binding over TCP to `<VPS_IP>:443` answers; the hub's bridge log says
   `channel up`; the phone's indicator says **end to end**.
5. **Keep it**: `sudo systemctl disable turn-dispatcher && sudo systemctl enable yggdrasil-sni-443`
   (keep `turn-dispatcher.py` on disk for the undo).

## What the hub needs beyond today's hand-made one

Today: brain + app (devices mode) + bridge (`[ap]` + root-link) from the tree release; no
LiveKit, no agent, no WireGuard node. `root/install/install.sh --trunk` now does all of the
below for a planted hub; for the hand-made one, by hand:

- **This tree's builds**: bifrost-net (the bridge's pinned channel, ICE-TCP demux, the
  WireGuard relay), yggdrasil, and the app (`npm run build`: the service worker and
  `lib/pinned.ts` carry the app's data after pairing).
- **The WireGuard node**: `bifrost-net wg-key <state>/hub-wg.key`; a `wg-hub.toml` (`udp`
  127.0.0.1:A, `relay` 127.0.0.1:B, `http` 127.0.0.1:C, `brain` = the hub brain, `roots_file` =
  the app's `roots.json` next to `devices.json`, `devices_file`); a unit for
  `bifrost-net wg -c wg-hub.toml`. bridge.toml `[bridge.root-link]`: `wg_relay = "127.0.0.1:B"`,
  `wg_local = "127.0.0.1:A"`. The brain: `YGG_PEERS_FROM=http://127.0.0.1:C/_wg/_roots`,
  `YGG_PEERS_VIA=http://127.0.0.1:C/_wg/{id}` (instead of the bridge's `/_roots`). The app:
  `BIFROST_WG_PUB_FILE=<state>/hub-wg.key.pub`. Roots joined before the tunnel re-join by
  themselves (join.sh) and the phone approves each once more (it shows the key's fingerprint).
- **LiveKit for the trunk**, separate from the live stack's (its own ports and keys): e.g.
  signaling 127.0.0.1:7980, `rtc.tcp_port` 7981, `rtc.udp_port` 7982, `use_external_ip: false`,
  `node_ip: <the hub's LAN address>`. bridge.toml `[ap]`: `livekit = "127.0.0.1:7980"` and
  `tcp = { livekit-ice = "<LAN address>:7981" }` (never loopback: LiveKit's TCP mux files a
  connection under the address it arrived on). `ice_tcp` can stay unset (= `<AP_NAME>:443`).
- **The voice agent** (`branch/voice/agent.py start`): `LIVEKIT_URL=ws://127.0.0.1:7980` + its
  key/secret, `OPENCODE_URL` = the hub brain, `SPEACHES_URL` (the Mac's speech server or
  `edge/voice_server.py`), `AGENT_HTTP_PORT` (free), `AGENT_TTS=off` (the phone speaks; the reply's
  audio rides the room), `APP_URL=http://127.0.0.1:<app>` (its `/api/tts/stream`), and an
  `AGENT_NAME` of its own (never `bifrost-live`/`bifrost-preview`).
- **The app's env**: `LIVEKIT_URL=wss://<AP_NAME>` (signaling through the bridge's `/rtc`, over
  the pinned channel), `LIVEKIT_API_URL=http://127.0.0.1:7980`, `LIVEKIT_API_KEY/SECRET`,
  `AGENT_NAME` (= the agent's), `BIFROST_TRUNK_ICE=auto` (the phone's candidate `<VPS_IP>:443`),
  `SPEACHES_URL` + `TTS_MODEL_EN`/`TTS_VOICE_EN`, `BIFROST_WG_PUB_FILE`.
- Restart order: brain, wg node, bridge, app, LiveKit, agent. The phone needs no re-pairing (the
  bridge's DTLS identity and devices.json are unchanged).
