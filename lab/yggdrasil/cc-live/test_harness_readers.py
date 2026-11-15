"""The Antigravity and opencode readers on invented conversations of the same shape as theirs.
   python3 -m unittest discover -s lab/yggdrasil/cc-live"""
import fcntl
import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_agy as A  # noqa: E402
import harness_opencode as O  # noqa: E402

SID = "11111111-2222-4333-8444-555555555555"


def ev(step, typ, **kw):
    return json.dumps({"step_index": step, "source": "MODEL", "type": typ, "status": "DONE", "created_at": "2026-11-15T20:00:%02dZ" % step, **kw})


class Agy(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        A.ROOT = self.root
        os.makedirs(os.path.join(self.root, "cache"))
        os.makedirs(os.path.join(self.root, "presence"))
        self.log = os.path.join(self.root, "brain", SID, ".system_generated", "logs", "transcript.jsonl")
        os.makedirs(os.path.dirname(self.log))
        conv = lambda cwd, steps, title="": {"summary": {"ID": "x", "Title": title, "Preview": "", "NumSteps": steps,
                                                         "UpdatedAt": "2026-11-15T20:00:00Z", "WorkspaceURIs": [f"file://{cwd}"]}}
        meta = {"conversations": {
            SID: conv("/home/u/Work/proj", 9),
            "22222222-2222-4333-8444-555555555555": conv(os.path.expanduser("~/.cache/root-sim/preview/work"), 3, "the brain's own"),
            "33333333-2222-4333-8444-555555555555": conv("/home/u", 0, "empty"),
            "44444444-2222-4333-8444-555555555555": {"no": "summary"},
        }}
        with open(os.path.join(self.root, "cache", "conversation_metadata.json"), "w") as f:
            json.dump(meta, f)
        lines = [
            json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-15T20:00:00Z",
                        "content": "<USER_REQUEST>\nfix the build\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>"}),
            ev(1, "PLANNER_RESPONSE", content="Looking.", tool_calls=[
                {"name": "run_command", "args": {"CommandLine": json.dumps("make"), "toolSummary": json.dumps("Build it"), "WaitMsBeforeAsync": "5000"}},
                {"name": "read_file", "args": {"Path": json.dumps("/home/u/Work/proj/Makefile")}}]),
            ev(2, "GENERIC", content="Created At: 2026-11-15T21:00:02+01:00\nCompleted At: 2026-11-15T21:00:02+01:00\nCommand exited with code 2.\n\nCommand output:\nerror"),
            ev(3, "GENERIC", content="all: build"),
            ev(4, "CHECKPOINT"),
            ev(5, "PLANNER_RESPONSE", content="Fixed the Makefile."),
        ]
        with open(self.log, "w") as f:
            f.write("\n".join(lines) + "\n")

    def test_recent_keeps_the_terminals_conversations(self):
        r = A.recent()
        self.assertEqual([x["id"] for x in r], [SID], "the brain's own folder, an empty one and a broken entry are left out")
        self.assertEqual(r[0]["cwd"], "/home/u/Work/proj")
        self.assertEqual(r[0]["title"], "fix the build", "no title: the first request")

    def test_a_headless_conversation_has_its_folder_in_its_own_store(self):
        sid = "55555555-2222-4333-8444-555555555555"
        log = os.path.join(self.root, "brain", sid, ".system_generated", "logs", "transcript.jsonl")
        os.makedirs(os.path.dirname(log))
        with open(log, "w") as f:
            f.write(json.dumps({"step_index": 0, "type": "USER_INPUT", "created_at": "2026-11-15T21:00:00Z",
                                "content": "<USER_REQUEST>\nrun from agy -p\n</USER_REQUEST>"}) + "\n")
        os.makedirs(os.path.join(self.root, "conversations"))
        c = sqlite3.connect(os.path.join(self.root, "conversations", f"{sid}.db"))
        c.execute("CREATE TABLE trajectory_metadata_blob (id text, data blob)")
        c.execute("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)", (b"\n/\n+file:///home/u/Work/headless\x1a\x00\x12",))
        c.commit()
        c.close()
        got = {r["id"]: r for r in A.recent()}
        self.assertEqual(got[sid]["cwd"], "/home/u/Work/headless", "not in agy's metadata cache: read from its store")
        self.assertEqual(got[sid]["title"], "run from agy -p")

    def test_items_pair_each_output_with_its_call(self):
        its = A.page(SID)["items"]
        self.assertEqual([i["k"] for i in its], ["user", "assistant", "tool", "tool", "assistant"])
        self.assertEqual(its[0]["text"], "fix the build", "the request alone, no CLI metadata")
        mk, rd = its[2], its[3]
        self.assertEqual(mk["title"], "run_command · Build it")
        self.assertTrue(mk["result"]["error"], "exit code 2 is an error")
        self.assertTrue(mk["result"]["text"].startswith("Command exited"), "the timestamp header is dropped")
        self.assertEqual(rd["title"], "read_file · /home/u/Work/proj/Makefile")
        self.assertEqual(rd["result"], {"text": "all: build", "error": False})
        self.assertNotIn("WaitMsBeforeAsync", mk["detail"])

    def test_paging_and_tail(self):
        p = A.page(SID, want=2)
        self.assertEqual([i["k"] for i in p["items"]], ["tool", "assistant"])
        older = A.page(SID, before=p["cursor"], want=10)
        self.assertEqual([i["k"] for i in older["items"]], ["user", "assistant", "tool"])
        self.assertIsNone(older["cursor"])
        t = A.Tail(SID)
        self.assertEqual(t.read(), [])
        with open(self.log, "a") as f:
            f.write(ev(6, "PLANNER_RESPONSE", tool_calls=[{"name": "run_command", "args": {"CommandLine": json.dumps("make test")}}]) + "\n")
            f.write(ev(7, "GENERIC", content="ok")[:20])  # half a line: waits
        new = t.read()
        self.assertEqual([(i["k"], i["title"]) for i in new], [("tool", "run_command · make test")])
        with open(self.log, "a") as f:
            f.write(ev(7, "GENERIC", content="ok")[20:] + "\n")
        self.assertEqual([(i["k"], i["id"], i["text"]) for i in t.read()], [("result", "c6.0", "ok")])

    def test_instructions_preamble_is_not_the_request(self):
        self.assertEqual(A._request("<instructions>\nbe terse\n</instructions>\n\nhello"), "hello")

    def test_live_is_a_held_presence_lock(self):
        lock = os.path.join(self.root, "presence", f"{SID}.lock")
        with open(lock, "w"):
            pass
        real = A._is_agy
        A._is_agy = lambda pid: pid == os.getpid()
        try:
            self.assertEqual(A.live(), {}, "a lock file nobody holds: closed")
            fd = os.open(lock, os.O_RDWR)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            got = A.live()
            self.assertEqual(list(got), [SID])
            self.assertEqual(got[SID]["pid"], os.getpid())
            os.close(fd)
            self.assertEqual(A.live(), {}, "released: closed again")
        finally:
            A._is_agy = real


class Opencode(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ["XDG_DATA_HOME"] = self.home
        os.makedirs(os.path.join(self.home, "opencode"))
        c = sqlite3.connect(O.db_path())
        c.executescript("""
          CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL, parent_id text,
                                time_updated integer NOT NULL, time_archived integer);
          CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
                                time_updated integer NOT NULL, data text NOT NULL);
          CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
                             time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);""")
        c.executemany("INSERT INTO session VALUES (?,?,?,?,?,?)", [
            ("ses_a", "/home/u/Work", "Fix the tests", None, 2000, None),
            ("ses_sub", "/home/u/Work", "a subagent", "ses_a", 3000, None),
            ("ses_tmp", "/tmp", "scratch", None, 4000, None),
            ("ses_old", "/home/u", "archived", None, 1000, 1500)])
        c.executemany("INSERT INTO message VALUES (?,?,?,?,?)", [
            ("msg_1", "ses_a", 100, 100, json.dumps({"role": "user", "time": {"created": 100}})),
            ("msg_2", "ses_a", 200, 300, json.dumps({"role": "assistant", "time": {"created": 200, "completed": 300}, "finish": "stop"}))])
        c.executemany("INSERT INTO part VALUES (?,?,?,?,?,?)", [
            ("prt_1", "msg_1", "ses_a", 100, 100, json.dumps({"type": "text", "text": "run the tests"})),
            ("prt_1b", "msg_1", "ses_a", 101, 101, json.dumps({"type": "text", "synthetic": True, "text": "Called the Read tool…"})),
            ("prt_2", "msg_2", "ses_a", 210, 210, json.dumps({"type": "reasoning", "text": "hmm"})),
            ("prt_3", "msg_2", "ses_a", 220, 250, json.dumps({"type": "tool", "tool": "bash", "callID": "call_1",
                                                              "state": {"status": "completed", "input": {"command": "pytest", "description": "Run tests"}, "output": "1 failed"}})),
            ("prt_4", "msg_2", "ses_a", 260, 300, json.dumps({"type": "text", "text": "One test fails."}))])
        c.commit()
        c.close()

    def tearDown(self):
        os.environ.pop("XDG_DATA_HOME", None)

    def test_recent_top_level_unarchived_real_folders(self):
        self.assertEqual([r["id"] for r in O.recent()], ["ses_a"])

    def test_items(self):
        p = O.page("ses_a")
        self.assertEqual([i["k"] for i in p["items"]], ["user", "tool", "assistant", "turn"])
        self.assertEqual(p["items"][0]["text"], "run the tests", "the CLI's synthetic echo is not the owner's words")
        tool = p["items"][1]
        self.assertEqual((tool["id"], tool["title"], tool["result"]["text"]), ("call_1", "bash · Run tests", "1 failed"))
        self.assertEqual(p["items"][3]["ms"], 100)
        self.assertIsNone(p["cursor"])

    def test_tail_resends_a_part_that_changed(self):
        t = O.Tail("ses_a")
        self.assertEqual(t.read(), [])
        c = sqlite3.connect(O.db_path())
        c.execute("UPDATE part SET time_updated=400, data=? WHERE id='prt_4'", (json.dumps({"type": "text", "text": "One test fails: fixed it."}),))
        c.commit()
        c.close()
        new = t.read()
        self.assertEqual([(i["id"], i["text"]) for i in new], [("prt_4", "One test fails: fixed it.")])
        self.assertEqual(t.read(), [])

    def test_live_from_processes(self):
        real = O._procs
        O._procs = lambda: iter([
            (10, ["opencode", "-s", "ses_x"], "/home/u", 0),                    # names its conversation
            (11, ["opencode"], "/home/u/Work", 1500),                           # the newest of its folder since it started
            (12, ["opencode", "serve", "--port", "4096"], "/home/u/Work", 0),   # a server: never open
            (13, ["opencode", "run", "hi"], "/home/u/Work", 0),                 # a one-shot without a session: unknown
        ])
        try:
            got = O.live()
        finally:
            O._procs = real
        self.assertEqual(got, {"ses_x": {"pid": 10, "cwd": "/home/u"}, "ses_a": {"pid": 11, "cwd": "/home/u/Work"}})


if __name__ == "__main__":
    unittest.main()
