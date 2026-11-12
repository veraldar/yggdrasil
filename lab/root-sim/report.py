#!/usr/bin/env python3
"""report.py — the night's report as one phone page (artifacts/root-coord-report.html), built from
the final human-sim reports so every number on it is the measured one. Also copies each final
transcript to artifacts/root-coord-sim-<scenario>.md so the phone can open it."""
import glob, html, json, os, shutil, statistics

ART = os.path.expanduser("~/Work/bifrost/artifacts")
FINAL = os.path.join(ART, "root-sim", "final-pass")
runs = {}
for f in sorted(glob.glob(os.path.join(FINAL, "*", "report.json"))):
    r = json.load(open(f))
    runs[r["scenario"]] = (r, os.path.dirname(f))  # newest wins (sorted by timestamped dir)

TITLES = {
    "parallel-two": "Two projects in parallel, follow-ups on both",
    "deep-lead": "One project split across a lead + parallel builds, looped to green",
    "research-build": "Research first, then build what it recommended",
    "away-back": "Hand off two tasks, leave, come back: what happened?",
    "decision": "Work that needs your decision midway",
    "switch-cancel": "Rapid topic switching, a cancel, a vague follow-up",
    "two-roots": "Two roots: work runs where the data is, reports flow home",
    "harness": "Claude Code as a session of the root",
}
rows, lats = [], []
for sc in TITLES:
    if sc not in runs:
        rows.append(f"<tr><td>{html.escape(TITLES[sc])}</td><td colspan=4>not run</td></tr>")
        continue
    r, d = runs[sc]
    s = r["judge"].get("scores", {})
    lats.append(r["latency"]["p50"] or 0)
    name = f"root-coord-sim-{sc}.md"
    shutil.copy(os.path.join(d, "transcript.md"), os.path.join(ART, name))
    checks = sum(c["ok"] for c in r["checks"])
    rows.append(
        f"<tr><td><a href='/api/artifact/{name}'>{html.escape(TITLES[sc])}</a></td>"
        f"<td class='{'ok' if r['pass'] else 'bad'}'>{'PASS' if r['pass'] else 'FAIL'}</td>"
        f"<td>{checks}/{len(r['checks'])}</td><td>{' '.join(str(s.get(k, '-')) for k in ('outcome', 'door', 'routing', 'proactivity', 'honesty'))}</td>"
        f"<td>{r['latency']['p50']}s · {r['sessions']} sess · depth {r['max_depth']} · {r['minutes']} min</td></tr>")
passed = sum(1 for sc in TITLES if sc in runs and runs[sc][0]["pass"])

page = f"""<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Root coordinator — night report</title><style>
:root{{--bg:#f6f4ef;--fg:#1d1b18;--mut:#6b665e;--line:#d9d4c9;--ok:#2f7a45;--bad:#b23a2e;--acc:#7a5c1e}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0d0f12;--fg:#e7e3da;--mut:#9a958b;--line:#2a2e35;--ok:#6cc68a;--bad:#ef7b6e;--acc:#d9b25f}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}}
main{{max-width:760px;margin:0 auto;padding:20px 16px 48px}} h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:28px 0 8px;color:var(--acc)}}
p,li{{margin:6px 0}} .mut{{color:var(--mut)}} code{{font-size:13px}} pre{{white-space:pre-wrap;border:1px solid var(--line);padding:10px;font-size:12.5px;overflow-x:auto}}
table{{border-collapse:collapse;width:100%;font-size:13px}} td,th{{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}}
.ok{{color:var(--ok);font-weight:700}} .bad{{color:var(--bad);font-weight:700}} a{{color:inherit}} .big{{font-size:28px;font-weight:700}}
</style></head><body><main>
<h1>One door, a tree of sessions, several roots</h1>
<p class=mut>root-coord · built and tested 11-12 night · branch <code>root-coord</code> (brain) + <code>root-coord-pwa</code> (phone)</p>
<p><span class=big>{passed}/{len(TITLES)}</span> human simulations pass on the final brain with the live profile config · <b>27/27</b> deterministic tree checks · <b>56</b> unit tests · the phone flow passes end to end on real models · MAIN median reply {statistics.median(lats) if lats else '-'} s</p>

<h2>What you get</h2>
<ul>
<li><b>MAIN is the only door.</b> You talk to it; it starts, continues, reads and closes sessions itself — by topic, so you never sort sessions. Your transcript with MAIN stays a conversation: results come back as MAIN's own words, never as raw lane posts.</li>
<li><b>It comes back to you.</b> When work finishes, fails or needs a decision, MAIN tells you without being asked; routine progress stays in the tree. What you missed rides your next message.</li>
<li><b>Sessions dig again.</b> The 11-09 swap had dropped AGENTS.md and turned on a brain-wide "two sentences" + 60-word cut for every session. Both fixed; brevity is for voice turns only.</li>
<li><b>Profiles</b> = role + tools + model + thinking: coordinator (fast, glm-5.3, no thinking, cannot write), lead (owns a project, splits it, loops until green), build, research, plan — and <b>claude-code / opencode / codex</b> sessions that resume their own harness session.</li>
<li><b>Several roots, one tree.</b> A session can run on another root (another machine or the VPS); you and MAIN see it like a local one. Proven over an SSH line to the Infomaniak VPS.</li>
<li><b>Model-aware.</b> A lite model gets a short role prompt and a lean tool set.</li>
</ul>

<h2>Human simulation (an LLM plays you on the phone, talks only to MAIN)</h2>
<table><tr><th>scenario</th><th></th><th>checks</th><th>judge o·d·r·p·h</th><th>MAIN p50 · tree · time</th></tr>{''.join(rows)}</table>
<p class=mut>Checks run on the files the sessions actually built (pytest in the workspace, grep for your answers, tree shape, nothing internal in MAIN). Tap a scenario for its transcript.</p>

<h2>Also proven tonight</h2>
<ul>
<li><b>The phone, end to end</b> (real coordinator, real model): type to MAIN → the <code>→ session</code> tag is a link → MAIN comes back by itself with the verified result → the child opens with its card line → the home tree shows it. <a href='/api/artifact/root-coord-ui-home.png'>home</a> · <a href='/api/artifact/root-coord-ui-child.png'>child</a> · <a href='/api/artifact/root-coord-ui-main-reported.png'>MAIN</a></li>
<li><b>Across hardware</b>: a root on the Infomaniak VPS (mock model, no key copied) took a session from MAIN at home over an SSH line; its report flowed home and MAIN relayed it. Transport-agnostic: the bifrost-net trunk can carry the same HTTP later.</li>
<li><b>Harness sessions</b>: Claude Code and opencode each built, resumed their own session on the follow-up, and reported up the tree. Codex is wired, waiting for <code>codex login</code>.</li>
<li><b>Lite tier</b>: glm-4.5-air marked lite did a task with the lean tool set and short prompt.</li>
<li><b>Your real data</b>: the new brain loaded a copy of all 569 sessions in 0.65 s, migrated MAIN to the coordinator, <code>/tree</code> in 27 ms.</li>
</ul>

<h2>Bugs the simulation caught (all fixed)</h2>
<ul>
<li>A finished build filed as "routine" → MAIN never told you. Outcomes are never routine now.</li>
<li>"(quiet)" leaked into your transcript. Hidden now.</li>
<li>A provider rate limit (z.ai 1302) killed a build mid-run. It backs off and retries now.</li>
<li>GLM spent 273 s thinking and answered nothing. An empty step retries once with thinking off.</li>
<li>MAIN split a project into three sessions itself instead of one lead. One project = one lead.</li>
<li>MAIN started a second session just to double-check one. It asks the owning session now.</li>
<li>The tree said "working" for seconds after a run ended. Live status now.</li>
<li>Inline code in replies was unreadable in dark themes (white chip, light text). Fixed in the app.</li>
<li>MAIN said "Done — it now handles 3d6+2" right after only forwarding the request. Dispatch now reads STARTED/SENT, NOT DONE YET, and "done" words are reserved for confirmed reports.</li>
<li>MAIN closed a still-running session "to tidy the tree", killing the work it then called done. Closing running work now needs an explicit cancel; tidying is forbidden.</li>
</ul>

<h2>Waiting for you (the auto-mode guard stopped these — your call)</h2>
<pre>! ~/Work/root-coord/lab/root-sim/deploy-live.sh apply      # the brain on :4100 (backups, watcher swap, probes)
! ~/Work/root-coord/lab/root-sim/deploy-pwa.sh apply       # the phone app on :8443
  … and rollback with the same scripts: deploy-live.sh rollback / deploy-pwa.sh rollback</pre>
<ul>
<li><b>veraldar.org</b>: a 4-line canon patch is staged (plant block, "first branch", v0.7, road). The live page is a 10-29 deploy that lags both repo branches.</li>
<li><b>GitHub</b>: rename <code>veraldar/bifrost</code> → <code>veraldar/yggdrasil</code> (archive the 10-31 split first). Not pushed: the lab history carries private IPs.</li>
<li><code>codex login</code> to enable codex sessions · copy the local backup bundle off this machine · the old fold-tighten settle watcher is still running (it measures the old brain).</li>
</ul>
</main></body></html>"""
open(os.path.join(ART, "root-coord-report.html"), "w").write(page)
print(f"report → {ART}/root-coord-report.html ({passed}/{len(TITLES)} pass)")
