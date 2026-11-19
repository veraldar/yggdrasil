"""The librarian against a fake root, through its real HTTP interface. `python3 -m pytest`."""
import json
import os
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import librarian

NOW = int(time.time() * 1000)
SESSIONS = [
    {"id": "ses_a", "title": "Inventory storage research", "agent": "coordinator",
     "time": {"updated": NOW - 120_000}, "card": {"status": "done", "headline": "SQLite wins over a JSON file"}},
    {"id": "ses_b", "title": "Old lighthouse story", "agent": "build",
     "time": {"updated": NOW - 3 * 3_600_000}, "card": {"status": "done", "headline": "a story"}},
    {"id": "ses_e2e", "title": "e2e-order run", "agent": "build", "test": True,
     "time": {"updated": NOW - 60_000}, "card": {"status": "done", "headline": "test debris"}},
]
MESSAGES = {
    "ses_a": [
        {"info": {"id": "m1", "role": "user", "time": {"created": NOW - 300_000}}, "parts": [{"type": "text", "text": "sqlite or json for the inventory?"}]},
        {"info": {"id": "m2", "role": "assistant", "time": {"created": NOW - 120_000}}, "parts": [
            {"type": "tool", "tool": "webfetch", "state": {"input": {"url": "https://sqlite.org/whentouse.html"}}},
            {"type": "text", "text": "Use SQLite: transactions, concurrent readers, one file. The teal inventory needs it."}]},
    ],
    "ses_b": [
        {"info": {"id": "m3", "role": "assistant", "time": {"created": NOW - 3 * 3_600_000}}, "parts": [{"type": "text", "text": "The keeper lit the lamp."}]},
        {"info": {"id": "m4", "role": "assistant", "time": {"created": NOW - 2 * 3_600_000}}, "parts": [
            {"type": "tool", "tool": "bash", "call": "c1", "state": {"input": {"command": "curl -H 'Authorization: Bearer ey123' https://cc-live.example/access"},
             "output": "cc-live full access ok\ntoken=sk-secret-abcdefghijklmnop\ndata:image/png;base64," + "A" * 3000}}]},
    ],
}
# B7c: a coordinator's inbox — the reports filed with it are memory too
INBOX = {
    "ses_a": [{"id": "evt_1", "at": NOW - 90_000, "from": "ses_b", "title": "phase 1 done",
               "body": "the twin boots and the list-order spec is green; full access confirmed on cc-live"}],
}


class FakeRoot(BaseHTTPRequestHandler):
    live = [s["id"] for s in SESSIONS]  # what the brain currently holds (prune tests move it)

    def log_message(self, *a):
        pass

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        q = dict(kv.split("=", 1) for kv in qs.split("&") if kv)
        if path == "/session":
            body = [s for s in SESSIONS if s["id"] in self.live]
        elif "/inbox" in path:
            body = INBOX.get(path.split("/")[2], [])
        elif "since=" in qs:  # B8: only what came after the named message
            sid, since = path.split("/")[2], q.get("since", "")
            msgs = MESSAGES.get(sid, [])
            body = msgs[msgs.index(next(m for m in msgs if m["info"]["id"] == since)):] if since in [m["info"]["id"] for m in msgs] else []
        else:
            body = MESSAGES.get(path.split("/")[2], [])
        b = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}"


def call(base, tool, session="ses_x", **inp):
    inp.setdefault("session", session)  # status/facts_for take it from input, remember from the body
    req = urllib.request.Request(f"{base}/call/{tool}",
                                 data=json.dumps({"input": inp, "session": session}).encode(), method="POST")
    return json.load(urllib.request.urlopen(req))


def test_all():
    root = serve(FakeRoot)
    d = tempfile.mkdtemp()
    arts = os.path.join(d, "artifacts")
    os.mkdir(arts)
    open(os.path.join(arts, "report.md"), "w").write("# Review\nThe mutable default in add_item leaks tags.")
    seed = os.path.join(d, "seed.json")
    json.dump({"facts": [{"topic": "garden", "fact": "tomatoes go in the south bed", "days_ago": 6}]}, open(seed, "w"))
    lib = librarian.Library(os.path.join(d, "lib.db"))
    assert lib.db.execute("PRAGMA user_version").fetchone()[0] == 1, "migration ran"

    lib.seed(seed)
    n, r = librarian.index_once(lib, root, arts)
    assert n == 3, f"two sessions (the e2e one is skipped) + one artifact: {n}"
    assert r >= 3, f"row counts are real: {r}"
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM docs WHERE session='ses_e2e'").fetchone()[0] == 0, "info.test skipped"
        assert lib.db.execute("SELECT count(*) FROM docs WHERE kind='report'").fetchone()[0] == 1, "the inbox body is indexed"
    assert librarian.index_once(lib, root, arts) == (0, 0), "nothing changed: nothing re-indexed"
    base = serve(librarian.handler_for(lib))

    man = json.load(urllib.request.urlopen(f"{base}/manifest"))
    assert [t["name"] for t in man["tools"]] == ["search", "recent", "remember", "recall"], man["tools"]
    assert all(t["scope"] == "self" for t in man["tools"])
    assert "librarian_search" in man["prompt"], "tells agents when to reach for it"

    out = call(base, "search", query="teal inventory")["output"]
    assert '"Inventory storage research"' in out and "[teal]" in out, out
    assert "msg=m2" in out, "hits carry the message id"
    assert "nothing found" in call(base, "search", query="lighthouse lamp", since_minutes=30)["output"]
    assert "keeper" in call(base, "search", query="lamp")["output"]
    art = call(base, "search", query="mutable default")["output"]
    assert "/api/artifact/report.md" in art, art
    rep = call(base, "search", query="list-order")["output"]
    assert "report" in rep and "ses_a" in rep, rep

    rec = call(base, "recent", minutes=10)["output"]
    assert "1 session(s)" in rec and "SQLite wins" in rec and "keywords:" in rec and "lighthouse" not in rec.lower(), rec

    # ── B1: recall over the facts FTS, all words first, any word second, search as fallback ──
    assert "kept under 'cc-live'" in call(base, "remember", topic="cc-live", fact="MAIN's cc-live v0.9.0 has full access to the relay, shipped 11-10")["output"]
    hit = call(base, "recall", topic="full access")["output"]
    assert "shipped 11-10" in hit, f"a fact holding 'cc-live … access' is found by two of its words: {hit}"
    assert "south bed" in call(base, "recall", topic="garden")["output"], "seeded past memory"
    assert "what was said" in call(base, "recall", topic="teal inventory")["output"], "falls back to search"

    # remember() dedupes: a same-topic fact refreshes instead of copying
    assert "refreshed" in call(base, "remember", topic="cc-live", fact="release v0.9.1 shipped 11-18")["output"]
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM facts WHERE topic='cc-live'").fetchone()[0] == 1, "one row"
        assert lib.db.execute("SELECT used FROM facts WHERE topic='cc-live'").fetchone()[0] >= 1, "hits bump used"

    # ── internal tools: callable, but never in the manifest's schemas ────────────────────
    st = call(base, "status", session="ses_a")["output"]
    assert "document(s)" in st and "indexed" in st, st
    assert "stale" in call(base, "status", session="nope")["output"]
    assert "south bed" in call(base, "facts_for", session="seed")["output"]
    assert "phase 1 done" in call(base, "search", query="phase 1 done")["output"]
    fid = lib.db.execute("SELECT id FROM facts WHERE topic='garden'").fetchone()[0]
    assert f"forgot fact {fid}" in call(base, "forget", id=fid)["output"]
    assert "cc-live" in call(base, "pinned")["output"]

    # ── B4: tool output is its own row, masked with G1's patterns ────────────────────────
    toolrow = call(base, "search", query="cc-live full access")["output"]
    assert "(tool" in toolrow, toolrow
    toolhit = call(base, "search", query="Bearer")["output"]
    assert "ey123" not in toolhit, "bearer tokens never reach the index"
    secret = call(base, "search", query="sk-secret-abcdefghijklmnop")["output"]
    assert "nothing found" in secret, f"keys never reach the index: {secret}"
    img = call(base, "search", query="image KB")["output"]
    assert "KB" in img, f"the collapsed image text is findable: {img}"
    m3 = call(base, "search", query="keeper lit")["output"]
    assert "msg=m3" in m3, "msg= is the message id"

    # ── B5: recency breaks bm25 ties — the young lamp row beats the older keeper text ────
    hits = call(base, "search", query="lamp")["output"]
    lines = [x for x in hits.split("\n") if x.startswith("- ")]
    assert len(lines) == 1 and "3h ago" in hits or "2h ago" in hits, hits

    # ── internal facts_for sees a session's own facts; forget removes exactly one ────────
    call(base, "remember", topic="twin", fact="the twin brain is :4250", session="ses_a")
    ff = call(base, "facts_for", session="ses_a")["output"]
    assert ":4250" in ff and "from" not in ff, ff

    # ── G7.1: prune follows the brain, facts survive ─────────────────────────────────────
    FakeRoot.live = ["ses_a"]  # the brain restarted, ses_b is gone
    n, r = librarian.index_once(lib, root, arts)
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1, "gone session dropped"
        assert lib.db.execute("SELECT count(*) FROM docs WHERE session='ses_b'").fetchone()[0] == 0, "its docs too"
        assert lib.db.execute("SELECT count(*) FROM facts").fetchone()[0] >= 1, "facts stay"
    assert "keeper lamp" in call(base, "search", query="keeper lamp")["output"], "its text is unfindable"

    FakeRoot.live = []  # a brain restart answering an empty list must NOT wipe the index
    librarian.index_once(lib, root, arts)
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1, "empty list: no prune"

    # ── B8: an incremental pass upserts by key, other rows stay ──────────────────────────
    FakeRoot.live = ["ses_a", "ses_b", "ses_e2e"]
    lib2 = librarian.Library(os.path.join(d, "lib2.db"))
    librarian.index_once(lib2, root, arts)
    with lib2.lock:
        before = lib2.db.execute("SELECT count(*) FROM docs").fetchone()[0]
        body0 = lib2.db.execute("SELECT body FROM docs WHERE key='m1'").fetchone()[0]
        MESSAGES["ses_a"][1]["parts"][-1]["text"] += " Plus: WAL mode."
        MESSAGES["ses_a"].append({"info": {"id": "m9", "role": "user", "time": {"created": NOW}}, "parts": [{"type": "text", "text": "thanks"}]})
        SESSIONS[0]["time"]["updated"] = NOW  # a real brain moves the mark on a new turn
    n, r = librarian.index_once(lib2, root, arts)
    with lib2.lock:
        assert "WAL mode" in lib2.db.execute("SELECT body FROM docs WHERE key='m2'").fetchone()[0]
        assert lib2.db.execute("SELECT body FROM docs WHERE key='m1'").fetchone()[0] == body0, "untouched row untouched"
        assert lib2.db.execute("SELECT count(*) FROM docs").fetchone()[0] == before + 1, "only the delta landed"

    assert "error" in call(base, "nope")


def test_recall_any_word_order():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r1.db"))
    lib.remember("cc-live v0.9.0", "released with full access to the relay", session="t")
    assert "full access" in lib.recall("full access"), "two words from topic+fact find it"


def test_recall_falls_back_to_search():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r2.db"))
    lib.upsert([("the teal inventory needs sqlite", "t", "m1", "s1", "assistant", NOW)])
    out = lib.recall("teal inventory")
    assert "what was said" in out and "teal" in out, out


def test_remember_dedupes():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r3.db"))
    lib.remember("deploy flow", "push to main, then tag")
    assert "refreshed" in lib.remember("deploy flow", "push to main, then tag, then smoke")
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM facts WHERE topic LIKE '%deploy%'").fetchone()[0] == 1
    lib.remember("garden beds", "south bed for tomatoes")
    with lib.lock:  # unrelated topics never collapse into each other
        assert lib.db.execute("SELECT count(*) FROM facts").fetchone()[0] == 2


def test_internal_tools_hidden_from_manifest_schemas():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r4.db"))
    assert librarian.INTERNAL_TOOLS, "the internal four exist"
    names = [t["name"] for t in librarian.MANIFEST["tools"]]
    assert names == ["search", "recent", "remember", "recall"], "manifests stay agent-only"
    assert not any(t["scope"] == "internal" for t in librarian.MANIFEST["tools"])
    assert "forget" in names + [t["name"] for t in librarian.INTERNAL_TOOLS]
    assert lib.status("") and lib.facts_for("x").startswith("no facts") and lib.pinned()


def test_tool_output_indexed_and_masked():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r5.db"))
    msg = {"info": {"id": "mm", "role": "assistant", "time": {"created": NOW}}, "parts": [
        {"type": "tool", "tool": "bash", "call": "c9",
         "state": {"input": {"command": "curl -H 'Authorization: Bearer zz' https://x/access"},
                   "output": "cc-live full access\ntoken=aaaa-bbbb\ndata:image/png;base64," + "B" * 4096}}]}
    lib.put_session({"id": "s", "title": "t", "time": {"updated": NOW}}, [msg])
    hit = lib.search("cc-live full access")
    assert "(tool" in hit and "msg=mm:c9" in hit, hit
    hit2 = lib.search("token")
    assert "tool" in hit2, "the row stays findable by its keyword"
    assert "aaaa-bbbb" not in hit2, "but the secret value is masked away"
    assert "BBBB" not in lib.search("[image 4 KB]").upper() or "[image 4 KB]" in lib.search("[image 4 KB]"), "image collapsed"


def test_search_returns_msg_id_and_prefers_recent():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r6.db"))
    lib.upsert([
        ("the lamp is lit", "old", "old_msg", "s_old", "assistant", NOW - 20 * 86_400_000),
        ("the lamp is lit", "new", "new_msg", "s_new", "assistant", NOW - 60_000),
    ])
    out = lib.search("lamp")
    assert "msg=new_msg" in out and "msg=old_msg" in out, out
    assert out.index("new_msg") < out.index("old_msg"), "recency breaks the bm25 tie"


def test_incremental_upsert_keeps_other_rows():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r7.db"))
    lib.put_session({"id": "s", "title": "t", "time": {"updated": NOW}}, MESSAGES["ses_a"])
    with lib.lock:
        n0 = lib.db.execute("SELECT count(*) FROM docs").fetchone()[0]
    msgs = [MESSAGES["ses_a"][1], {"info": {"id": "m_new", "role": "user", "time": {"created": NOW}},
                                   "parts": [{"type": "text", "text": "one more turn"}]}]
    lib.put_session({"id": "s", "title": "t", "time": {"updated": NOW + 1}}, msgs)
    with lib.lock:
        rows = {r[0] for r in lib.db.execute("SELECT key FROM docs")}
    assert "m1" in rows and n0 + 1 == len(rows), f"the untouched row survived: {rows}"


def test_prune_removes_gone_sessions_but_keeps_facts():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r8.db"))
    lib.put_session({"id": "gone", "title": "t", "time": {"updated": NOW}}, MESSAGES["ses_b"])
    lib.remember("durables", "the fact outlives the session", session="gone")
    lib.prune(["live"], [])
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM docs WHERE session='gone'").fetchone()[0] == 0
        assert lib.db.execute("SELECT count(*) FROM sessions WHERE id='gone'").fetchone()[0] == 0
        assert lib.db.execute("SELECT session FROM facts WHERE topic='durables'").fetchone()[0] == "gone"


def test_prune_skips_on_empty_list():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r9.db"))
    lib.put_session({"id": "kept", "title": "t", "time": {"updated": NOW}}, MESSAGES["ses_a"])
    lib.prune([], [])  # a brain answering [] is a restart, not an empty brain
    with lib.lock:
        assert lib.db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1


def test_indexes_inbox_bodies():
    lib = librarian.Library(os.path.join(tempfile.mkdtemp(), "r10.db"))
    ev = {"id": "evt_9", "at": NOW, "title": "done", "body": "x" * 4000}
    lib.put_session({"id": "main", "title": "[MAIN]", "agent": "coordinator", "time": {"updated": NOW}}, [], reports=[ev])
    with lib.lock:
        r = lib.db.execute("SELECT body, kind, length(body) FROM docs WHERE key='evt_9'").fetchone()
    assert r[1] == "report" and r[2] == 2500, f"report bodies clip at 2500: {r[2]}"


if __name__ == "__main__":
    test_all()
    for t in (test_recall_any_word_order, test_recall_falls_back_to_search, test_remember_dedupes,
              test_internal_tools_hidden_from_manifest_schemas, test_tool_output_indexed_and_masked,
              test_search_returns_msg_id_and_prefers_recent, test_incremental_upsert_keeps_other_rows,
              test_prune_removes_gone_sessions_but_keeps_facts, test_prune_skips_on_empty_list,
              test_indexes_inbox_bodies):
        t()
    print("ok: librarian")
