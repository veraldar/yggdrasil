#!/usr/bin/env python3
"""trunk-report.py — the trunk meter's reader (trunk observability, proposal v2, steps 1c + 3).

The trunk's processes write their own numbers (trunk/src/meter.rs, branch/lib/obs.ts) into one
folder at home: `<proc>-min-YYYY-MM-DD.jsonl` (one line a minute: counters, peaks, latency
summaries) and `<proc>-events-YYYY-MM-DD.jsonl` (links, probes, streams, refusals, refreshes,
revocations, cuts …). This script only reads them:

  day [--day YYYY-MM-DD] [--post]   the morning page: trunk-day-<day>.html in the artifacts
                                    folder (no scripts, phone width); --post files a one-line
                                    report with the link in MAIN's inbox. Also writes the hourly
                                    roll-ups (kept 400 d).
  watch [--post]                    every 5 min: 2 failed test requests in a row, the channel
                                    down > 2 min, a stolen refresh token, a revocation that took
                                    > 5 s to cut → one line in MAIN's inbox (once per incident)
  release-check <id> <deploy_ms> [--post]
                                    15 min after a deploy vs the hour before it (report only)
  json [--day …]                    the day's numbers as JSON (for MAIN or a test)

Posts to MAIN are automation posts (meta.auto): filed in its inbox, never a transcript turn —
but each one costs a digest call on the brain's own model, and an alert can wake MAIN. So: one
morning line a day, and every incident is posted once.
Times on the page are local (the machine's zone); files are named by UTC day.
Content is never in these files; this script adds none. What it writes is the owner's only (0600).
"""
import argparse
import datetime as dt
import glob
import gzip
import html
import json
import os
import statistics
import sys
import urllib.request

HOME = os.path.expanduser("~")
OBS = os.environ.get("BIFROST_OBS_DIR") or f"{HOME}/.local/share/yggdrasil/hub/obs"
ART = os.environ.get("TRUNK_REPORT_ART") or f"{HOME}/Work/root-coord-pwa/artifacts"
BRAIN = os.environ.get("TRUNK_REPORT_BRAIN") or "http://127.0.0.1:4101"
LOCAL = dt.datetime.now().astimezone().tzinfo


# ---------------------------------------------------------------- reading -------------------

def utc_days(start_ms, end_ms):
    d = dt.datetime.fromtimestamp(start_ms / 1000, dt.timezone.utc).date()
    last = dt.datetime.fromtimestamp((end_ms - 1) / 1000, dt.timezone.utc).date()
    while d <= last:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def read_lines(obs, kind, start_ms, end_ms):
    """Every line of `*-<kind>-<utc day>.jsonl[.gz]` between start and end (ms), with `proc`."""
    out = []
    for day in utc_days(start_ms, end_ms):
        for f in sorted(glob.glob(os.path.join(obs, f"*-{kind}-{day}.jsonl*"))):
            proc = os.path.basename(f).split(f"-{kind}-")[0]
            opener = gzip.open if f.endswith(".gz") else open
            try:
                with opener(f, "rt") as fh:
                    for raw in fh:
                        try:
                            v = json.loads(raw)
                        except ValueError:
                            continue
                        ts = v.get("ts") or 0
                        if start_ms <= ts < end_ms:
                            v.setdefault("proc", proc)
                            v["_proc"] = proc
                            out.append(v)
            except OSError:
                continue
    out.sort(key=lambda v: v.get("ts", 0))
    return out


def local_day_bounds(day):
    d = dt.date.fromisoformat(day)
    start = dt.datetime.combine(d, dt.time(0), LOCAL)
    end = start + dt.timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def hhmm(ms):
    return dt.datetime.fromtimestamp(ms / 1000, LOCAL).strftime("%H:%M")


def hour_of(ms):
    return dt.datetime.fromtimestamp(ms / 1000, LOCAL).hour


def pct(vals, p):
    if not vals:
        return None
    v = sorted(vals)
    k = max(0, min(len(v) - 1, int(round(p / 100 * (len(v) - 1)))))
    return v[k]


def csum(lines, name, proc=None):
    return sum((l.get("c") or {}).get(name, 0) for l in lines if proc is None or l["_proc"] == proc)


def csum_prefix(lines, prefix, proc=None):
    out = {}
    for l in lines:
        if proc is not None and l["_proc"] != proc:
            continue
        for k, v in (l.get("c") or {}).items():
            if k.startswith(prefix):
                out[k[len(prefix):]] = out.get(k[len(prefix):], 0) + v
    return out


def gmax(lines, name, proc=None):
    vals = [(l.get("g") or {}).get(name, 0) for l in lines if proc is None or l["_proc"] == proc]
    return max(vals) if vals else 0


def hist_typical(lines, name, proc=None):
    """Per-minute summaries can't be merged exactly: the count-weighted median of the minutes'
    p50s, and the worst minute's p95 (labelled as such on the page)."""
    rows = [(l.get("h") or {}).get(name) for l in lines if proc is None or l["_proc"] == proc]
    rows = [r for r in rows if r]
    if not rows:
        return None
    n = sum(r["n"] for r in rows)
    p50s = []
    for r in rows:
        p50s += [r["p50"]] * min(r["n"], 1000)
    return {"n": n, "p50": statistics.median(p50s), "p95_worst": max(r["p95"] for r in rows),
            "p95_median": statistics.median(r["p95"] for r in rows)}


# ---------------------------------------------------------------- the day's numbers ---------

def analyze(obs, start, end):
    mins = read_lines(obs, "min", start, end)
    evs = read_lines(obs, "events", start, end)
    k = lambda kind: [e for e in evs if e.get("kind") == kind]
    br = [l for l in mins if l["_proc"] == "bridge"]
    ap = [l for l in mins if l["_proc"] == "ap"]
    wg = [l for l in mins if l["_proc"] == "wg"]
    R = {"start": start, "end": end, "minutes": {p: sum(1 for l in mins if l["_proc"] == p) for p in ("bridge", "ap", "wg")}}

    # -- up time: the test requests (home → VPS → bridge; and the VPS's own when step 2 runs)
    probes = [e for e in k("probe") if e.get("from") == "home"]
    ok = [e for e in probes if e.get("ok")]
    outages, cur = [], None
    for e in probes:
        if not e.get("ok"):
            if cur is None:
                cur = {"from": e["ts"], "to": e["ts"], "n": 1, "why": e.get("why")}
            else:
                cur["to"], cur["n"] = e["ts"], cur["n"] + 1
        else:
            if cur and cur["n"] >= 2:
                cur["back"] = e["ts"]
                outages.append(cur)
            cur = None
    if cur and cur["n"] >= 2:
        outages.append(cur)
    R["probe"] = {
        "sent": len(probes), "ok": len(ok),
        "up_pct": round(100 * len(ok) / len(probes), 2) if probes else None,
        "p50_ms": pct([e["ms"] for e in ok], 50), "p95_ms": pct([e["ms"] for e in ok], 95),
        "fails": {w: sum(1 for e in probes if not e.get("ok") and e.get("why") == w) for w in {e.get("why") for e in probes if not e.get("ok")}},
        "outages": outages,
        "strip": [(e["ts"], bool(e.get("ok"))) for e in probes],
        "vps_ok": csum(ap, "edge.probe.ok"), "vps_fail": csum(ap, "edge.probe.fail"),
        "vps_typical": hist_typical(ap, "edge.probe"),
        "vps_link": hist_typical(ap, "edge.probe.link"),
    }

    # -- the channel
    R["link"] = {
        "ups": csum(br, "link.up"),
        "downs": [{"t": e["ts"], "why": e.get("why"), "up_s": e.get("up_s")} for e in k("link.down")],
        "fails": [{"t": e["ts"], "why": e.get("why")} for e in k("link.fail")],
        "rtt": hist_typical(br, "link.rtt"),
        "queue_peak": gmax(br, "link.queue.frames"),
        "now_up": bool(br and (br[-1].get("g") or {}).get("link")),
    }

    # -- traffic through the trunk (each finished stream is one record)
    streams = k("stream")
    R["streams"] = {"n": len(streams), "tunnel": sum(1 for s in streams if s.get("via") == "tunnel")}
    routes = {}
    for s in streams:
        r = routes.setdefault(s.get("route", "?"), {"n": 0, "ttfb": [], "5xx": 0, "4xx": 0, "in": 0, "out": 0})
        r["n"] += 1
        r["in"] += s.get("in", 0)
        r["out"] += s.get("out", 0)
        if s.get("st", 0) >= 500 or s.get("st", 0) == 0:
            r["5xx"] += 1
        elif s.get("st", 0) >= 400:
            r["4xx"] += 1
        if s.get("ttfb_ms") is not None and s.get("st") != 101:
            r["ttfb"].append(s["ttfb_ms"])
    R["routes"] = {k_: {"n": v["n"], "p50": pct(v["ttfb"], 50), "p95": pct(v["ttfb"], 95), "5xx": v["5xx"], "4xx": v["4xx"],
                        "mb": round((v["in"] + v["out"]) / 1e6, 2)} for k_, v in sorted(routes.items(), key=lambda x: -x[1]["n"])}
    tt = [s["ttfb_ms"] for s in streams if s.get("ttfb_ms") is not None and s.get("st") != 101 and s.get("route") != "api.run-events"]
    R["ttfb"] = {"p50": pct(tt, 50), "p95": pct(tt, 95), "n": len(tt)}
    R["errors"] = {"5xx": sum(1 for s in streams if s.get("st", 0) >= 500 or s.get("st", 0) == 0), "4xx": sum(1 for s in streams if 400 <= s.get("st", 0) < 500)}
    polling = sum(1 for s in streams if s.get("route") in ("api.session", "api.session.messages"))
    R["polling_pct"] = round(100 * polling / len(streams)) if streams else None
    R["per_hour"] = {"streams": [0] * 24, "dtls": [0] * 24, "probe_fail": [0] * 24}
    for s in streams:
        R["per_hour"]["streams"][hour_of(s["ts"])] += 1
    for l in br:
        R["per_hour"]["dtls"][hour_of(l["ts"])] += (l.get("c") or {}).get("peer.dtls.rxq_full", 0)
    for e in probes:
        if not e.get("ok"):
            R["per_hour"]["probe_fail"][hour_of(e["ts"])] += 1

    # -- the phone channel (pinned peers)
    opens = k("peer.open")
    cuts = [e for e in k("cut") if e.get("src") == "bridge"]
    R["peers"] = {
        "offers": csum(br, "peer.offer"), "offers_ok": csum(br, "peer.offer.ok"), "offers_denied": csum(br, "peer.offer.denied"),
        "opened": len(opens), "open_p50_ms": pct([e["ms"] for e in opens], 50), "open_p95_ms": pct([e["ms"] for e in opens], 95),
        "path": {p: sum(1 for e in opens if e.get("path") == p) for p in ("udp", "tcp")},
        "cuts": {w: sum(1 for e in cuts if e.get("why") == w) for w in {e.get("why") for e in cuts}},
        "dtls_drops": csum(br, "peer.dtls.rxq_full"),
        "dtls_minutes": sum(1 for l in br if (l.get("c") or {}).get("peer.dtls.rxq_full")),
        "dtls_peak_min": max([((l.get("c") or {}).get("peer.dtls.rxq_full", 0), l["ts"]) for l in br] or [(0, 0)]),
        "backlog_peak": gmax(br, "peer.tunnel.backlog"),
        "loop_lag_peak_us": gmax(br, "bridge.loop.lag_us"),
        "loop": hist_typical(br, "bridge.loop"),
        "tunnel_ttfb": hist_typical(br, "ttfb.tunnel"),
        "warn_lines": csum(br, "log.warn"), "suppressed": csum(br, "log.suppressed"),
    }

    # -- tokens
    claims = k("pair.claim")
    app_ref = [e for e in k("refresh") if e.get("src") == "app"]
    br_ref = [e for e in k("refresh") if e.get("src") == "bridge"]
    reuses = k("reuse")
    revokes = k("revoke")
    denies = k("deny")
    all_cuts = k("cut")
    leads = [e["lead_s"] for e in app_ref + br_ref if e.get("ok") and e.get("lead_s") is not None]
    revoke_ms = [e["revoke_ms"] for e in all_cuts if e.get("revoke_ms") is not None]
    T = {
        "codes": len(k("pair.code")),
        "claims_ok": sum(1 for c in claims if c.get("ok")),
        "claims_failed": {w: sum(1 for c in claims if not c.get("ok") and c.get("why") == w) for w in {c.get("why") for c in claims if not c.get("ok")}},
        "repairs": sum(1 for c in claims if c.get("ok") and c.get("from")),
        "refresh_ok": sum(1 for e in app_ref + br_ref if e.get("ok")),
        "refresh_denied": {w: sum(1 for e in app_ref + br_ref if not e.get("ok") and e.get("why") == w) for w in {e.get("why") for e in app_ref + br_ref if not e.get("ok")}},
        "refresh_late": sum(1 for x in leads if x < 0),
        "lead_p5": pct(leads, 5), "lead_p50": pct(leads, 50),
        "races": sum(1 for r in reuses if not r.get("theft")), "thefts": [r for r in reuses if r.get("theft")],
        "revokes": {w: sum(1 for r in revokes if r.get("why") == w) for w in {r.get("why") for r in revokes}},
        "kills": len(k("kill")),
        "revoke_cut_p50": pct(revoke_ms, 50), "revoke_cut_max": max(revoke_ms) if revoke_ms else None, "revoke_cut_n": len(revoke_ms),
        "denies": {f"{d.get('why')} → {d.get('hint')}": sum(1 for x in denies if x.get("why") == d.get("why")) for d in denies},
    }
    # roaming: a region refusal → how it ended
    roams = []
    for d in [x for x in denies if x.get("why") == "region" and x.get("device")]:
        if any(r["device"] == d["device"] and 0 <= d["ts"] - r["t"] < 120_000 for r in roams):
            continue  # the same episode
        dev, t0 = d["device"], d["ts"]
        end_ = "not back"
        took = None
        for e in evs:
            if e["ts"] < t0:
                continue
            if e["ts"] - t0 > 6 * 3600_000:
                break
            if e.get("kind") == "refresh" and e.get("ok") and e.get("device") == dev:
                end_, took = ("silent" if e["ts"] - t0 <= 60_000 else "refresh, late"), e["ts"] - t0
                break
            if e.get("kind") == "peer.open" and e.get("device") == dev:
                end_, took = "channel again", e["ts"] - t0
                break
            if e.get("kind") == "pair.claim" and e.get("ok") and e.get("from") == dev:
                end_, took = "QR scan", e["ts"] - t0
                break
        roams.append({"device": dev, "t": t0, "end": end_, "ms": took})
    T["roams"] = roams
    # interruptions: a device's first refusal/cut (not the owner's own revoke or kill) → its next success
    starts = sorted(
        [x for x in denies if x.get("device") and x.get("why") in ("expired", "region", "invalid")]
        + [x for x in all_cuts if x.get("src") == "bridge" and x.get("why") == "token expired"],
        key=lambda x: x["ts"],
    )
    inter, open_ = [], {}
    for x in starts:
        dev = x["device"]
        if dev in open_:
            continue
        open_[dev] = x["ts"]
        how, took = "not back", None
        for e in evs:
            if e["ts"] <= x["ts"]:
                continue
            if e.get("kind") in ("refresh", "offer") and e.get("device") == dev and e.get("ok", True):
                how, took = "silent", e["ts"] - x["ts"]
                break
            if e.get("kind") == "pair.claim" and e.get("ok") and e.get("from") == dev:
                how, took = "QR", e["ts"] - x["ts"]
                break
        inter.append({"device": dev, "t": x["ts"], "why": x.get("why"), "how": how, "ms": took})
        if how != "not back":
            del open_[dev]
    qr_causes = {}
    for c in claims:
        if c.get("ok") and c.get("from"):
            prev = [r for r in revokes if r.get("device") == c["from"] and r["ts"] <= c["ts"]]
            why = prev[-1]["why"] if prev else "cookie lost or refresh expired"
            qr_causes[why] = qr_causes.get(why, 0) + 1
    T["interruptions"] = {
        "n": len(inter),
        "silent": sum(1 for i in inter if i["how"] == "silent"),
        "qr": sum(1 for i in inter if i["how"] == "QR") + sum(1 for c in claims if c.get("ok") and c.get("from") and not any(i.get("how") == "QR" and i["device"] == c["from"] for i in inter)),
        "not_back": sum(1 for i in inter if i["how"] == "not back"),
        "silent_p50_ms": pct([i["ms"] for i in inter if i["how"] == "silent"], 50),
        "qr_causes": qr_causes,
    }
    R["tokens"] = T

    # -- the VPS (its minute lines, home over the channel)
    R["vps"] = {
        "minutes": len(ap),
        "tls_ok": csum(ap, "edge.tls.ok"), "tls_fail": csum(ap, "edge.tls.fail"), "tls_timeout": csum(ap, "edge.tls.timeout"),
        "tls_fail_kinds": csum_prefix(ap, "edge.tls.fail."),
        "proxy_bad": csum(ap, "edge.proxy.bad") + csum(ap, "edge.proxy.timeout"),
        "head_bad": csum(ap, "edge.head.bad") + csum(ap, "edge.head.timeout"),
        "offline": csum(ap, "edge.offline"), "raw_nolink": csum(ap, "edge.raw.nolink"),
        "streams": csum(ap, "edge.streams"), "routes": csum_prefix(ap, "edge.route."),
        "link_down": {w: csum(ap, f"edge.link.down.{w}") for w in ("silent", "error", "closed", "taken")},
        "link_refused": csum(ap, "edge.link.refused"),
        "rss_max": max([(l.get("p") or {}).get("rss", 0) for l in ap] or [0]),
        "cpu_s": cpu_used(ap),
        "ttfb": hist_typical(ap, "edge.ttfb"), "tls": hist_typical(ap, "edge.tls"),
        "sni": sni_day(ap),
    }
    # -- the WireGuard node (its counters are cumulative: the day's difference)
    R["wg"] = wg_day(wg)
    R["roots"] = {"ups": len([e for e in k("root.link") if e.get("up")]), "downs": len([e for e in k("root.link") if not e.get("up")]),
                  "rtt": hist_typical(br, "root.rtt"), "refused": csum_prefix(br, "root.link.refused.")}
    R["bridge_proc"] = {"cpu_s": cpu_used(br), "rss_max": max([(l.get("p") or {}).get("rss", 0) for l in br] or [0])}
    R["dropped"] = sum((l.get("c") or {}).get("obs.dropped", 0) for l in mins)
    return R


def sni_day(ap):
    """The :443 dispatcher's minutes (sni-443.py → the ap → home): conns and bytes per route, errors."""
    out = {"conns": {}, "bytes": {}, "errors": {}}
    for l in ap:
        for part in ("conns", "bytes", "errors"):
            for k_, v in ((l.get("sni") or {}).get(part) or {}).items():
                out[part][k_] = out[part].get(k_, 0) + v
    return out


def cpu_used(lines):
    xs = [(l["ts"], (l.get("p") or {}).get("cpu_s")) for l in lines if (l.get("p") or {}).get("cpu_s") is not None]
    if len(xs) < 2:
        return None
    used, prev = 0.0, xs[0][1]
    for _, c in xs[1:]:
        used += c - prev if c >= prev else c  # a restart starts from 0
        prev = c
    return round(used, 1)


def wg_day(wg):
    if not wg:
        return None
    first, last = wg[0].get("wg") or {}, wg[-1].get("wg") or {}
    d = lambda a, b: max(0, (b or 0) - (a or 0)) if (b or 0) >= (a or 0) else (b or 0)
    drops_last, drops_first = last.get("dropped") or {}, first.get("dropped") or {}
    return {
        "peers": last.get("peers"), "up": [p.get("id") for p in last.get("peer_list") or [] if p.get("up")],
        "frames_in": d((first.get("frames") or {}).get("rx"), (last.get("frames") or {}).get("rx")),
        "frames_out": d((first.get("frames") or {}).get("tx"), (last.get("frames") or {}).get("tx")),
        "dropped": {kk: d(drops_first.get(kk), v) for kk, v in drops_last.items() if d(drops_first.get(kk), v)},
    }


# ---------------------------------------------------------------- flags --------------------

def flags(R):
    """What is wrong (red), worth watching (amber), and fine (green): one short line each."""
    red, amber, green = [], [], []
    P, T, peers = R["probe"], R["tokens"], R["peers"]
    if P["sent"]:
        if P["outages"]:
            o = P["outages"][0]
            red.append(f"the trunk was unreachable {len(P['outages'])}× — first {hhmm(o['from'])} ({o['why']}, {o['n']} test requests)")
        else:
            green.append(f"up {P['up_pct']} % ({P['ok']}/{P['sent']} test requests answered)")
    if peers["dtls_drops"]:
        n, at = peers["dtls_peak_min"]
        red.append(f"{peers['dtls_drops']:,} packets dropped on the phone channel (DTLS queue full) in {peers['dtls_minutes']} minutes, peak {n}/min at {hhmm(at)}")
    if T["thefts"]:
        red.append(f"a refresh token was used again after it was replaced (theft signal) — device {T['thefts'][0].get('device')} revoked")
    if T["revoke_cut_max"] is not None and T["revoke_cut_max"] > 5000:
        red.append(f"a revocation took {T['revoke_cut_max'] / 1000:.1f} s to cut (target ≤ 1.1 s)")
    if R["errors"]["5xx"]:
        amber.append(f"{R['errors']['5xx']} answers failed (5xx or no answer)")
    downs = [d for d in R["link"]["downs"]]
    if downs:
        amber.append(f"the channel dropped {len(downs)}× ({', '.join(sorted({str(d['why']) for d in downs}))})")
    elif R["minutes"]["bridge"]:
        green.append("the channel stayed up")
    if T["refresh_late"]:
        amber.append(f"{T['refresh_late']} refreshes came after the token had expired")
    if T["interruptions"]["qr"]:
        amber.append(f"{T['interruptions']['qr']} QR scan(s) needed to get back in")
    cuts_exp = peers["cuts"].get("token expired", 0)
    if cuts_exp:
        amber.append(f"{cuts_exp} phone channel(s) cut for an expired token")
    if R["polling_pct"] and R["polling_pct"] >= 80:
        amber.append(f"{R['polling_pct']} % of requests are the phone polling")
    if not red and not amber and R["minutes"]["bridge"]:
        green.append("nothing to fix")
    return red, amber, green


# ---------------------------------------------------------------- the page ------------------

CSS = """
:root{--bg:#07080e;--surface:#0d0f18;--border:rgba(196,204,255,.13);--text:#e9ebf5;--dim:#8b90a8;--ok:#72d19a;--warn:#e6b35a;--bad:#ec7c7c;--info:#7ab4e6}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:460px;margin:0 auto;padding:10px 10px 40px}
h1{font-size:13px;font-weight:400;letter-spacing:.14em;margin:4px 0 2px}
.lede{color:var(--dim);font-size:11px;margin:0 0 10px}
.card{border:1px solid var(--border);background:var(--surface);margin:8px 0;padding:9px 10px}
.flag{border-left:2px solid var(--bad)}.amber{border-left:2px solid var(--warn)}.green{border-left:2px solid var(--ok)}
.st-bad{color:var(--bad)}.st-warn{color:var(--warn)}.st-ok{color:var(--ok)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
.tile{border:1px solid var(--border);background:var(--surface);padding:7px 8px;min-width:0}
.tl{font-size:10px;color:var(--dim)}.tv{font-size:15px;margin:1px 0}.ts{font-size:10px;color:var(--dim)}
details{border:1px solid var(--border);background:var(--surface);margin:6px 0}
details>summary{cursor:pointer;padding:8px 10px;list-style:none;font-size:12.5px}
details>summary::-webkit-details-marker{display:none}
details>summary::after{content:' ›';color:var(--dim)}details[open]>summary::after{content:' ⌄'}
.body{padding:2px 10px 10px;border-top:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:400;color:var(--dim);font-size:10px;padding:3px 4px 3px 0;border-bottom:1px solid var(--border)}
td{padding:3px 4px 3px 0;border-bottom:1px solid var(--border);vertical-align:top}
.k{font-size:10.5px;color:var(--dim)}
ul.l{margin:4px 0;padding-left:16px}ul.l li{margin:2px 0}
svg{width:100%;height:auto;display:block}
.strip{display:flex;flex-wrap:wrap;gap:1px;margin:6px 0}.strip i{width:4px;height:10px;display:block}
footer{margin-top:16px;font-size:10.5px;color:var(--dim);border-top:1px solid var(--border);padding-top:8px}
"""


def esc(x):
    return html.escape(str(x), quote=True)


def write_private(path, text):
    """Write a file only its owner may read (0600), atomically."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def ms_s(ms):
    if ms is None:
        return "—"
    return f"{ms / 1000:.2f} s" if ms >= 1000 else f"{ms:.0f} ms"


def bars(values, color, title):
    vmax = max(values) or 1
    w, h, x0, y0 = 340, 84, 28, 70
    slot = (w - x0 - 4) / 24
    out = [f'<svg viewBox="0 0 {w} {h + 14}" role="img" aria-label="{esc(title)}">']
    for frac in (0, 0.5, 1):
        y = y0 - frac * (y0 - 8)
        out.append(f'<line x1="{x0}" x2="{w - 4}" y1="{y:.1f}" y2="{y:.1f}" stroke="rgba(196,204,255,.10)"/>')
        out.append(f'<text x="{x0 - 4}" y="{y + 3:.1f}" fill="#8b90a8" font-size="9" text-anchor="end">{round(vmax * frac):,}</text>')
    for i, v in enumerate(values):
        if v:
            bh = max(1.5, v / vmax * (y0 - 8))
            x = x0 + i * slot + (slot - 7) / 2
            out.append(f'<rect x="{x:.1f}" y="{y0 - bh:.1f}" width="7" height="{bh:.1f}" rx="2" fill="{color}"><title>{i:02d}:00 · {v:,}</title></rect>')
    for hr in (0, 6, 12, 18, 23):
        out.append(f'<text x="{x0 + hr * slot + slot / 2:.1f}" y="{y0 + 12}" fill="#8b90a8" font-size="9" text-anchor="middle">{hr:02d}</text>')
    out.append(f'<line x1="{x0}" x2="{w - 4}" y1="{y0}" y2="{y0}" stroke="rgba(196,204,255,.28)"/></svg>')
    return "".join(out)


def kv_rows(rows):
    # every value is text (some of it from the VPS): escaped, always
    return "<table>" + "".join(f"<tr><td class=k>{esc(a)}</td><td>{esc(b)}</td></tr>" for a, b in rows) + "</table>"


def page(day, R):
    red, amber, green = flags(R)
    P, T, peers, L, V = R["probe"], R["tokens"], R["peers"], R["link"], R["vps"]
    d = dt.date.fromisoformat(day)
    title = f"TRUNK · {d.strftime('%a').upper()} {d.strftime('%m-%d')}"
    o = [f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'><title>{esc(title)}</title><style>{CSS}</style></head><body><main>"]
    o.append(f"<h1>{esc(title)}</h1><p class=lede>The trunk's own meter, the whole day (local time). Counts and timings only: no words, no audio, no full IP addresses; the VPS keeps nothing on disk.</p>")
    for cls, icon, items in (("flag", "✕", red), ("amber", "!", amber), ("green", "✓", green)):
        if items:
            col = {"flag": "st-bad", "amber": "st-warn", "green": "st-ok"}[cls]
            o.append(f"<div class='card {cls}'>" + "".join(f"<div><span class={col}>{icon}</span> {esc(i)}</div>" for i in items) + "</div>")
    o.append("<div class=tiles>")
    tiles = [
        ("up (test requests)", f"{P['up_pct']} %" if P["up_pct"] is not None else "—", f"{P['ok']}/{P['sent']} · typical {ms_s(P['p50_ms'])}"),
        ("through the trunk", f"{R['streams']['n']:,}", f"requests · {R['streams']['tunnel']:,} on the phone channel"),
        ("first byte", ms_s(R["ttfb"]["p50"]), f"p50 · p95 {ms_s(R['ttfb']['p95'])}"),
        ("phone channel drops", f"{peers['dtls_drops']:,}", f"DTLS queue full · {peers['dtls_minutes']} min"),
        ("channel to the VPS", "up" if L["now_up"] else "down", f"{len(L['downs'])} drops · ping {ms_s((L['rtt'] or {}).get('p50'))}"),
        ("tokens", f"{T['refresh_ok']} refreshes", f"{T['interruptions']['silent']} silent · {T['interruptions']['qr']} QR"),
    ]
    for a, b, c in tiles:
        o.append(f"<div class=tile><div class=tl>{esc(a)}</div><div class=tv>{esc(b)}</div><div class=ts>{esc(c)}</div></div>")
    o.append("</div>")

    # up time strip
    if P["strip"]:
        o.append("<details open><summary>Up time — every test request</summary><div class=body>")
        o.append("<div class=strip>" + "".join(f"<i style='background:{'#72d19a' if ok else '#ec7c7c'}' title='{esc(hhmm(t))} {'ok' if ok else 'failed'}'></i>" for t, ok in P["strip"]) + "</div>")
        rows = [("sent from home", f"{P['sent']} (every 5 min: home → VPS → bridge → back)"), ("answered", f"{P['ok']}"),
                ("time", f"p50 {ms_s(P['p50_ms'])} · p95 {ms_s(P['p95_ms'])}")]
        if P["fails"]:
            rows.append(("failed", ", ".join(f"{k}: {v}" for k, v in P["fails"].items())))
        for ot in P["outages"]:
            rows.append(("outage", f"{hhmm(ot['from'])}–{hhmm(ot.get('back', ot['to']))} · {ot['why']}"))
        if P["vps_ok"] or P["vps_fail"]:
            rows.append(("from the VPS", f"{P['vps_ok']} ok · {P['vps_fail']} failed · link round {ms_s((P['vps_link'] or {}).get('p50'))}"))
        o.append(kv_rows(rows) + "</div></details>")

    # phone channel
    o.append(f"<details {'open' if peers['dtls_drops'] else ''}><summary>Phone channel (pinned peers)</summary><div class=body>")
    if peers["dtls_drops"]:
        o.append("<div class=k>DTLS drops per hour</div>" + bars(R["per_hour"]["dtls"], "#ec7c7c", "DTLS drops per hour"))
    o.append(kv_rows([
        ("connects", f"{peers['opened']} opened · {peers['offers_ok']}/{peers['offers']} offers ok · {peers['offers_denied']} refused"),
        ("open in", f"p50 {ms_s(peers['open_p50_ms'])} · p95 {ms_s(peers['open_p95_ms'])}"),
        ("path", f"UDP {peers['path']['udp']} · ICE-TCP via :443 {peers['path']['tcp']}"),
        ("cut", ", ".join(f"{k}: {v}" for k, v in peers["cuts"].items()) or "none"),
        ("tunnel first byte", f"typical {ms_s((peers['tunnel_ttfb'] or {}).get('p50'))} · worst minute p95 {ms_s((peers['tunnel_ttfb'] or {}).get('p95_worst'))}"),
        ("queues", f"tunnel backlog peak {peers['backlog_peak']} frames · loop lag peak {peers['loop_lag_peak_us'] / 1000:.1f} ms"),
        ("log", f"{peers['warn_lines']:,} warnings counted · {peers['suppressed']:,} repeats not printed"),
    ]) + "</div></details>")

    # traffic
    o.append("<details><summary>Traffic by route</summary><div class=body>")
    o.append("<div class=k>requests per hour</div>" + bars(R["per_hour"]["streams"], "#7ab4e6", "requests per hour"))
    o.append("<table><tr><th>route</th><th>n</th><th>p50</th><th>p95</th><th>err</th></tr>")
    for rname, r in list(R["routes"].items())[:14]:
        o.append(f"<tr><td>{esc(rname)}</td><td>{int(r['n']):,}</td><td>{esc(ms_s(r['p50']))}</td><td>{esc(ms_s(r['p95']))}</td><td>{int(r['5xx']) or ''}</td></tr>")
    o.append("</table>")
    if R["polling_pct"] is not None:
        o.append(f"<p class=k>{R['polling_pct']} % of the requests are the session list and transcript polls.</p>")
    o.append("</div></details>")

    # tokens
    o.append("<details><summary>Tokens — pairing, refresh, revocations</summary><div class=body>")
    I = T["interruptions"]
    o.append(kv_rows([
        ("pairing", f"{T['codes']} codes · {T['claims_ok']} claimed · {T['repairs']} were re-pairs" + (" · failed: " + ", ".join(f"{k} {v}" for k, v in T["claims_failed"].items()) if T["claims_failed"] else "")),
        ("refresh", f"{T['refresh_ok']} ok" + (" · refused: " + ", ".join(f"{k} {v}" for k, v in T["refresh_denied"].items()) if T["refresh_denied"] else "")),
        ("how early", f"p50 {T['lead_p50']} s before expiry · p5 {T['lead_p5']} s · {T['refresh_late']} after expiry" if T["lead_p50"] is not None else "—"),
        ("reuse", f"{T['races']} harmless races · {len(T['thefts'])} theft signals"),
        ("back in", f"{I['n']} interruptions · {I['silent']} silent (p50 {ms_s(I['silent_p50_ms'])}) · {I['qr']} QR · {I['not_back']} not back"),
        ("QR because", ", ".join(f"{k}: {v}" for k, v in I["qr_causes"].items()) or "—"),
        ("roaming", ", ".join(f"{hhmm(r['t'])} {r['end']}" + (f" ({ms_s(r['ms'])})" if r['ms'] else "") for r in T["roams"]) or "no region refusals"),
        ("revoked", ", ".join(f"{k}: {v}" for k, v in T["revokes"].items()) or "none"),
        ("revoke → cut", f"p50 {ms_s(T['revoke_cut_p50'])} · max {ms_s(T['revoke_cut_max'])} ({T['revoke_cut_n']} cuts)" if T["revoke_cut_n"] else "—"),
        ("refusals", ", ".join(f"{k}: {v}" for k, v in T["denies"].items()) or "none"),
    ]) + "</div></details>")

    # channel + VPS
    o.append("<details><summary>The VPS and the channel</summary><div class=body>")
    rows = [("channel", f"{L['ups']} connects · drops: " + (", ".join(f"{hhmm(x['t'])} {x['why']}" for x in L["downs"]) or "none")),
            ("ping", f"p50 {ms_s((L['rtt'] or {}).get('p50'))} · worst minute p95 {ms_s((L['rtt'] or {}).get('p95_worst'))}"),
            ("queue to the VPS", f"peak {L['queue_peak']} frames")]
    if V["minutes"]:
        rows += [("VPS minutes", f"{V['minutes']} received"),
                 ("TLS", f"{V['tls_ok']:,} ok · {V['tls_fail']} failed {V['tls_fail_kinds'] or ''} · {V['tls_timeout']} timeouts"),
                 ("refused early", f"PROXY {V['proxy_bad']} · head {V['head_bad']}"),
                 ("bridge offline", f"{V['offline']} answers · {V['raw_nolink']} raw refused"),
                 ("link (VPS side)", ", ".join(f"{k} {v}" for k, v in V["link_down"].items() if v) or "no drops"),
                 ("process", f"cpu {V['cpu_s']} s · rss max {V['rss_max'] / 1e6:.0f} MB")]
        S = V["sni"]
        if S["conns"]:
            rows.append((":443 dispatcher", ", ".join(f"{k_} {v:,}" for k_, v in sorted(S["conns"].items())) +
                         (" · errors: " + ", ".join(f"{k_} {v}" for k_, v in S["errors"].items()) if S["errors"] else "")))
    else:
        rows.append(("VPS minutes", "none yet (step 2: the VPS sends its numbers home)"))
    o.append(kv_rows(rows) + "</div></details>")

    # roots
    W = R["wg"]
    o.append("<details><summary>Root links and WireGuard</summary><div class=body>")
    o.append(kv_rows([
        ("root links", f"{R['roots']['ups']} linked · {R['roots']['downs']} unlinked · ping {ms_s((R['roots']['rtt'] or {}).get('p50'))}"),
        ("wireguard", (f"peers {W['peers']} · up {', '.join(W['up']) or 'none'} · frames {W['frames_in']:,} in / {W['frames_out']:,} out · dropped {W['dropped'] or 0}") if W else "no minutes"),
        ("bridge process", f"cpu {R['bridge_proc']['cpu_s']} s · rss max {R['bridge_proc']['rss_max'] / 1e6:.0f} MB"),
    ]) + "</div></details>")
    o.append(f"<footer>From {esc(OBS.replace(HOME, '~'))} (bridge {R['minutes']['bridge']} min · VPS {R['minutes']['ap']} min · wg {R['minutes']['wg']} min"
             f"{' · ' + str(R['dropped']) + ' meter lines dropped' if R['dropped'] else ''}). Made by scripts/trunk-report.py.</footer></main></body></html>")
    return "".join(o)


# ---------------------------------------------------------------- roll-ups -----------------

def rollup(obs, start, end):
    """Hourly sums of every counter per process, kept 400 days in obs/rollup/hour-YYYY-MM.jsonl."""
    mins = read_lines(obs, "min", start, end)
    hours = {}
    for l in mins:
        key = (l["_proc"], l["ts"] // 3600_000 * 3600_000)
        h = hours.setdefault(key, {})
        for k, v in (l.get("c") or {}).items():
            h[k] = h.get(k, 0) + v
    private_dir(obs)
    private_dir(os.path.join(obs, "rollup"))
    by_month = {}
    for (proc, ts), c in hours.items():
        m = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).strftime("%Y-%m")
        by_month.setdefault(m, []).append({"ts": ts, "proc": proc, "c": c})
    for m, rows in by_month.items():
        f = os.path.join(obs, "rollup", f"hour-{m}.jsonl")
        keep = []
        if os.path.exists(f):
            have = {(r["proc"], r["ts"]) for r in rows}
            with open(f) as fh:
                keep = [json.loads(x) for x in fh if x.strip()]
            keep = [r for r in keep if (r["proc"], r["ts"]) not in have]
        write_private(f, "".join(json.dumps(r) + "\n" for r in sorted(keep + rows, key=lambda r: (r["ts"], r["proc"]))))
    cutoff = (dt.date.today() - dt.timedelta(days=400)).strftime("%Y-%m")
    for f in glob.glob(os.path.join(obs, "rollup", "hour-*.jsonl")):
        if os.path.basename(f)[5:12] < cutoff:
            os.remove(f)


# ---------------------------------------------------------------- MAIN's inbox --------------

def main_session():
    with urllib.request.urlopen(f"{BRAIN}/session", timeout=10) as r:
        sessions = json.load(r)
    for s in sessions:
        if s.get("title") == "[MAIN]" and not s.get("parentID"):
            return s["id"]
    return None


def post_main(text):
    """An automation post to MAIN: filed in its inbox (meta.auto), never a transcript turn; it costs
    one digest call on the brain's model and may wake MAIN — callers post each incident once."""
    sid = main_session()
    if not sid:
        print("trunk-report: no MAIN session found", file=sys.stderr)
        return False
    body = json.dumps({"parts": [{"type": "text", "text": text}], "meta": {"auto": True}}).encode()
    req = urllib.request.Request(f"{BRAIN}/session/{sid}/message", data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return 200 <= r.status < 300


# ---------------------------------------------------------------- commands -----------------

def cmd_day(a):
    day = a.day or (dt.date.today() - dt.timedelta(days=1)).isoformat()
    start, end = local_day_bounds(day)
    R = analyze(a.obs, start, end)
    name = f"trunk-day-{day}.html"
    os.makedirs(a.out, exist_ok=True)
    write_private(os.path.join(a.out, name), page(day, R))
    if os.path.isdir(a.obs):
        rollup(a.obs, start, end)
    red, amber, green = flags(R)
    if not any(R["minutes"].values()) and not R["streams"]["n"]:
        print(f"[trunk] {day}: no meter data — nothing posted")
        return
    head = red[0] if red else amber[0] if amber else green[0] if green else "no data"
    line = f"[trunk] {day}: {'✕ ' if red else '! ' if amber else '✓ '}{head} — /api/artifact/{name}"
    print(line)
    if a.post:
        post_main(line)


def cmd_json(a):
    day = a.day or dt.date.today().isoformat()
    start, end = local_day_bounds(day)
    print(json.dumps(analyze(a.obs, start, end), default=str, indent=1))


def cmd_watch(a):
    """The last 30 minutes: an incident is posted once (state in obs/.watch.json)."""
    now = int(dt.datetime.now().timestamp() * 1000)
    if not os.path.isdir(a.obs):
        return  # no meter yet: nothing to watch
    state_f = os.path.join(a.obs, ".watch.json")
    try:
        state = json.load(open(state_f))
    except (OSError, ValueError):
        state = {}
    evs = read_lines(a.obs, "events", now - 30 * 60_000, now + 60_000)
    seen = set(state.get("seen", []))
    alerts = []
    probes = [e for e in evs if e.get("kind") == "probe" and e.get("from") == "home"]
    # runs of 2+ failed test requests: one still going, or one that ended since the last run
    runs, cur = [], []
    for e in probes:
        if not e.get("ok"):
            cur.append(e)
        else:
            if len(cur) >= 2:
                runs.append((cur, e))
            cur = []
    for run, back in runs:
        key = f"outage:{run[0]['ts']}"
        if state.get("outage") == run[0]["ts"]:
            alerts.append(f"[trunk alert] the trunk answers again ({hhmm(back['ts'])}; it was not answering since {hhmm(run[0]['ts'])})")
            state.pop("outage", None)
            seen.add(key)
        elif key not in seen:
            alerts.append(f"[trunk alert] the trunk was not answering {hhmm(run[0]['ts'])}–{hhmm(back['ts'])} ({run[0].get('why')}, {len(run)} test requests failed)")
            seen.add(key)
    if len(cur) >= 2:
        key = f"outage:{cur[0]['ts']}"
        if key not in seen:
            alerts.append(f"[trunk alert] the trunk is not answering since {hhmm(cur[0]['ts'])} ({cur[-1].get('why')}, {len(cur)} test requests failed)")
            seen.add(key)
            state["outage"] = cur[0]["ts"]
    for e in evs:
        if e.get("kind") == "link.down":
            ups = [u for u in evs if u.get("kind") == "link.up" and u["ts"] > e["ts"]]
            if (not ups or ups[0]["ts"] - e["ts"] > 120_000) and now - e["ts"] > 120_000:
                key = f"link:{e['ts']}"
                if key not in seen:
                    alerts.append(f"[trunk alert] the channel to the VPS went down at {hhmm(e['ts'])} ({e.get('why')}) and stayed down over 2 minutes")
                    seen.add(key)
        if e.get("kind") == "reuse" and e.get("theft"):
            key = f"theft:{e['ts']}"
            if key not in seen:
                alerts.append(f"[trunk alert] a refresh token was used again after it was replaced (theft signal) at {hhmm(e['ts'])}: device {e.get('device')} was revoked")
                seen.add(key)
        if e.get("kind") == "cut" and (e.get("revoke_ms") or 0) > 5000:
            key = f"slowcut:{e['ts']}"
            if key not in seen:
                alerts.append(f"[trunk alert] a revocation took {e['revoke_ms'] / 1000:.1f} s to cut ({e.get('src')}, target ≤ 1.1 s)")
                seen.add(key)
    state["seen"] = sorted(seen)[-200:]
    write_private(state_f, json.dumps(state))
    for line in alerts:
        print(line)
        if a.post:
            post_main(line)


def cmd_release_check(a):
    t = int(a.deploy_ms)
    before = analyze(a.obs, t - 3600_000, t)
    after = analyze(a.obs, t, t + 15 * 60_000)
    if before["minutes"]["bridge"] < 30:
        line = (f"[trunk] release {a.release}: no baseline to compare with (the meter has "
                f"{before['minutes']['bridge']} minutes from the hour before it) — report only")
        print(line)
        if a.post:
            post_main(line)
        return

    def per_min(R, key):
        return R[key]

    rows = []
    worse = []

    def cmp(label, b, x, higher_is_worse=True, fmt=lambda v: str(v)):
        rows.append(f"{label}: {fmt(b)} → {fmt(x)}")
        if b is not None and x is not None and higher_is_worse and x > b * 1.5 and x - b > 0:
            worse.append(label)

    cmp("first byte p95", before["ttfb"]["p95"], after["ttfb"]["p95"], fmt=ms_s)
    cmp("5xx per hour", before["errors"]["5xx"], after["errors"]["5xx"] * 4)
    cmp("failed test requests", before["probe"]["sent"] - before["probe"]["ok"], (after["probe"]["sent"] - after["probe"]["ok"]) * 4)
    cmp("DTLS drops per hour", before["peers"]["dtls_drops"], after["peers"]["dtls_drops"] * 4)
    cmp("revoke → cut max", before["tokens"]["revoke_cut_max"], after["tokens"]["revoke_cut_max"], fmt=ms_s)
    verdict = ("! worse after release " + a.release + ": " + ", ".join(worse)) if worse else ("✓ release " + a.release + ": no worse in its first 15 minutes")
    line = f"[trunk] {verdict} ({'; '.join(rows)}) — report only"
    print(line)
    if a.post:
        post_main(line)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--obs", default=OBS)
    ap.add_argument("--out", default=ART)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("day")
    d.add_argument("--day")
    d.add_argument("--post", action="store_true")
    j = sub.add_parser("json")
    j.add_argument("--day")
    w = sub.add_parser("watch")
    w.add_argument("--post", action="store_true")
    r = sub.add_parser("release-check")
    r.add_argument("release")
    r.add_argument("deploy_ms")
    r.add_argument("--post", action="store_true")
    a = ap.parse_args()
    {"day": cmd_day, "json": cmd_json, "watch": cmd_watch, "release-check": cmd_release_check}[a.cmd](a)


if __name__ == "__main__":
    main()
