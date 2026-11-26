#!/usr/bin/env python3
"""Requests board: asks.json + git + live session list -> script-free phone HTML.
Run:  python3 ~/Work/requests-board/board/build.py   (≈1 s, same URL every time)"""
import json, subprocess, urllib.request, datetime, html, os, sys
here = os.path.dirname(os.path.abspath(__file__))
GIT = os.path.expanduser("~/Work/tree-next")
OUT = os.path.expanduser("~/Work/root-coord-pwa/artifacts/requests-board.html")
e = html.escape
def git(*a):
    r = subprocess.run(["git", "-C", GIT, *a], capture_output=True, text=True); return r.returncode, r.stdout.strip()
live = {}
try:
    for s in json.load(urllib.request.urlopen("http://127.0.0.1:4101/session", timeout=5)):
        live[s["id"][-6:]] = (s.get("card") or {}).get("status") or "—"
except Exception: live = None
asks = json.load(open(os.path.join(here, "asks.json")))
ORDER = ["blocked", "stalled", "running", "queued", "done"]
LABEL = {"blocked": "needs you / blocked", "stalled": "stalled", "running": "running", "queued": "queued", "done": "done"}
asks.sort(key=lambda a: ORDER.index(a["status"]))
cards, counts = [], {}
for a in asks:
    counts[a["status"]] = counts.get(a["status"], 0) + 1
    st = a["status"]; delivery = ""
    if a.get("commit"):
        ok, _ = git("cat-file", "-e", a["commit"] + "^{commit}")
        inbr = git("merge-base", "--is-ancestor", a["commit"], a["branch"])[0] == 0
        merged = git("merge-base", "--is-ancestor", a["commit"], "tree-next")[0] == 0
        flag = "" if ok == 0 and inbr else " ⚠ not found"
        delivery = (f'<div class="d">{e(a.get("commit_label","@"))} <b>{e(a["branch"])}</b> <code>{e(a["commit"])}</code>'
                    f'{"" if not merged else " · in tree-next"}{flag}</div>')
    if a.get("link"):
        delivery += f'<div class="d"><a href="/api/artifact/{e(a["link"])}">{e(a["link"])}</a></div>'
    note = f'<div class="n">{e(a["note"])}</div>' if a.get("note") else ""
    ls = f' · session {e(live.get(a["sid"], "?"))}' if live is not None and a.get("sid") else ""
    cards.append(f'<div class="c {st}"><div class="t"><span class="k">{LABEL[st].split(" /")[0] if st!="blocked" else "blocked"}</span>'
                 f'<span class="w">{e(a["when"])}</span></div><div class="q">{e(a["what"])}</div>{note}'
                 f'<div class="o">{e(a["who"])}{ls}</div>{delivery}</div>')
now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
summ = " · ".join(f"{counts[s]} {s}" for s in ORDER if s in counts)
page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Requests</title>
<style>
body{{margin:0;padding:12px;background:rgb(233,239,216);color:#1d2a14;font:14px/1.5 "Commit Mono",ui-monospace,Menlo,Consolas,monospace}}
h1{{font-size:16px;margin:0 0 2px}} .s{{color:#5a6a48;font-size:12px;margin-bottom:12px}}
.c{{background:#f6f9ec;border:1px solid #c5d0ab;border-left:5px solid #889;border-radius:6px;padding:8px 10px;margin:0 0 8px}}
.c.blocked{{border-left-color:#c0392b}} .c.stalled{{border-left-color:#d68910}} .c.running{{border-left-color:#2e86c1}} .c.queued{{border-left-color:#999}} .c.done{{border-left-color:#2e8b57}}
.t{{display:flex;justify-content:space-between;font-size:11px;text-transform:uppercase;letter-spacing:.05em}}
.blocked .k{{color:#c0392b}} .stalled .k{{color:#b9770e}} .running .k{{color:#2e86c1}} .done .k{{color:#2e8b57}} .w{{color:#6b7a58}}
.q{{font-weight:700;margin:2px 0}} .o{{font-size:12px;color:#4a5a38}} .n{{font-size:12px;color:#8a3a10}} .d{{font-size:12px;margin-top:2px;overflow-wrap:break-word}}
code{{background:#e3ebcd;padding:0 3px;border-radius:3px}} a{{color:#1d5a8c}}
</style></head><body><h1>Requests</h1><div class="s">snapshot {now} · {e(summ)}<br>refresh: ask MAIN “refresh the requests board”, then reload</div>
{"".join(cards)}</body></html>'''
open(OUT, "w").write(page)
print("wrote", OUT, len(page), "bytes;", summ, "| live sessions:", "n/a" if live is None else len(live))
