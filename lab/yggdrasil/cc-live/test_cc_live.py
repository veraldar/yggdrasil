"""cc-live tests: the screen emulator, the transcript → chat items, paging + tail, the prompt parser
and the raw-key filter.   python3 -m unittest discover -s lab/yggdrasil/cc-live  (or pytest)"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cc_live as C  # noqa: E402
import transcript as T  # noqa: E402
import vt  # noqa: E402

# a permission prompt as Claude Code 2.1.285 draws it at 100 columns (seen live, 11-14)
PROMPT_SCREEN = """\
● Write(hello.txt)
────────────────────────────────────────────────────────────────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this
      session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
""".splitlines()

IDLE_SCREEN = """\
❯ Make a plan

● Here is the plan:
  1. Read the code
  2. Fix the bug
  3. Run the tests

✻ Brewed for 3s · done 5:02 PM
─────────────────────────────────────────────────────────────── scratch ─
❯
─────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ← for agents
""".splitlines()


class Screen(unittest.TestCase):
    def test_moves_erase_and_wide(self):
        s = vt.Screen(20, 5)
        s.feed(b"hello\r\nworld\x1b[1;3HX\x1b[2;1H\x1b[K\x1b[5Gok")
        self.assertEqual(s.lines()[:2], ["heXlo", "    ok"])
        s.feed("\x1b[3;1H日本".encode())
        self.assertEqual(s.lines()[2], "日本")
        s.feed(b"\x1b[3;1H\x1b[2K\x1b]0;title\x07\x1b[38;2;1;2;3mcolour\x1b[0m")
        self.assertEqual(s.lines()[2], "colour")

    def test_scroll_and_split_utf8(self):
        s = vt.Screen(10, 3)
        s.feed(b"a\r\nb\r\nc\r\nd")
        self.assertEqual(s.lines(), ["b", "c", "d"])
        raw = "❯ ok".encode()
        s.feed(b"\r\n" + raw[:2])
        s.feed(raw[2:])
        self.assertEqual(s.lines()[-1], "❯ ok")

    def test_alt_screen(self):
        s = vt.Screen(10, 3)
        s.feed(b"main\x1b[?1049h\x1b[2J\x1b[Halt")
        self.assertEqual(s.lines()[0], "alt")
        s.feed(b"\x1b[?1049l")
        self.assertEqual(s.lines()[0], "main")


class Prompt(unittest.TestCase):
    def test_permission_prompt(self):
        p = C.parse_prompt(PROMPT_SCREEN)
        self.assertIsNotNone(p)
        self.assertEqual(p["question"], "Do you want to create hello.txt?")
        self.assertEqual([o["n"] for o in p["options"]], [1, 2, 3])
        self.assertEqual(p["options"][0], {"n": 1, "label": "Yes", "selected": True})
        self.assertTrue(p["options"][1]["label"].endswith("for this session (shift+tab)"))
        self.assertEqual(p["options"][2]["label"], "No")
        self.assertEqual(p["context"], ["Create file", "hello.txt", " 1 hi"])
        self.assertIn("Esc to cancel", p["footer"])

    def test_a_numbered_list_with_the_input_box_is_no_prompt(self):
        self.assertIsNone(C.parse_prompt(IDLE_SCREEN))
        self.assertTrue(C.input_box(IDLE_SCREEN))
        self.assertTrue(C.input_empty(IDLE_SCREEN))
        typed = [ln if ln != "❯" else "❯ half a mess" for ln in IDLE_SCREEN]
        self.assertFalse(C.input_empty(typed))

    def test_term_filter(self):
        class Fake:
            def __init__(self, ls):
                self.ls = ls

            def lines(self):
                return self.ls

        empty = Fake(IDLE_SCREEN)
        self.assertEqual(C.term_filter(empty, b"a\x1azb"), b"azb")  # Ctrl+Z never passes
        self.assertEqual(C.term_filter(empty, b"\x1b[D"), b"")  # ← on an empty input: agent view
        typed = Fake([ln if ln != "❯" else "❯ abc" for ln in IDLE_SCREEN])
        self.assertEqual(C.term_filter(typed, b"\x1b[D"), b"\x1b[D")  # ← moves the cursor
        self.assertEqual(C.term_filter(empty, b"\x03\r"), b"\x03\r")


def ev(**k):
    k.setdefault("uuid", f"u{id(k)}")
    k.setdefault("timestamp", "2026-11-14T10:00:00Z")
    return k


EVENTS = [
    {"type": "custom-title", "customTitle": "scratch"},
    ev(type="user", uuid="u1", message={"role": "user", "content": "hello there"}, origin={"kind": "human"}),
    ev(type="attachment", attachment={"type": "environment"}),
    ev(type="assistant", uuid="a1", message={"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "Hi!"}]}),
    ev(type="assistant", uuid="a2", message={"content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls -la", "description": "List files"}}]}),
    ev(type="user", uuid="r1", message={"content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "a\nb", "is_error": False}]}),
    ev(type="assistant", uuid="a3", message={"content": [{"type": "tool_use", "id": "tu2", "name": "Read", "input": {"file_path": "/x/y.py"}}]}),
    ev(type="user", uuid="r2", message={"content": [{"type": "tool_result", "tool_use_id": "tu2", "content": [{"type": "text", "text": "no such file"}], "is_error": True}]}),
    ev(type="attachment", uuid="q1", attachment={"type": "queued_command", "prompt": "also this", "commandMode": "prompt", "origin": {"kind": "human"}}),
    ev(type="assistant", uuid="a4", message={"content": [{"type": "tool_use", "id": "tu3", "name": "Agent", "input": {"description": "Survey", "subagent_type": "Explore", "prompt": "look"}}]}),
    ev(type="user", uuid="r3", message={"content": [{"type": "tool_result", "tool_use_id": "tu3", "content": [{"type": "text", "text": "Async agent launched…"}]}]},
       toolUseResult={"status": "async_launched", "agentId": "agx"}),
    ev(type="user", uuid="h1", message={"content": 'Another Claude session sent a message:\n<agent-message from="agx">\n[Subagent hand-back] blah. The report follows:\n  Found it.\n  Second line.\n</agent-message>'}, origin={"kind": "peer"}),
    ev(type="user", uuid="n1", message={"content": "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"build\" completed</summary>\n</task-notification>"}),
    ev(type="user", uuid="m1", isMeta=True, message={"content": "<local-command-caveat>x</local-command-caveat>"}),
    ev(type="user", uuid="i1", message={"content": [{"type": "text", "text": "[Request interrupted by user]"}]}),
    ev(type="system", uuid="s1", subtype="turn_duration", durationMs=4200),
    ev(type="system", uuid="s2", subtype="compact_boundary", content="Conversation compacted"),
    ev(type="system", uuid="s3", subtype="local_command", content="<command-name>/model</command-name>\n<command-args>haiku</command-args>"),
    {"type": "file-history-snapshot", "messageId": "x"},
]


class Transcript(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "s.jsonl")
        with open(self.path, "w") as f:
            for e in EVENTS:
                f.write(json.dumps(e) + "\n")

    def test_items(self):
        its = T.page(self.path)["items"]
        kinds = [(i["k"], i.get("kind") or i.get("name") or "") for i in its]
        self.assertEqual(kinds, [
            ("user", ""), ("assistant", ""), ("tool", "Bash"), ("tool", "Read"), ("user", ""), ("tool", "Agent"),
            ("note", "agent"), ("note", "task"), ("note", "interrupted"), ("turn", ""), ("note", "compact"), ("note", "command")])
        bash, read, agent = its[2], its[3], its[5]
        self.assertEqual((bash["title"], bash["detail"], bash["result"]), ("List files", "ls -la", {"text": "a\nb", "error": False}))
        self.assertEqual(read["result"], {"text": "no such file", "error": True})
        self.assertTrue(its[4]["queued"])
        self.assertEqual((agent["title"], agent["agent"], agent["result"]["text"]), ("Survey (Explore)", "agx", "started in the background"))
        self.assertEqual((its[6]["agent"], its[6]["text"], its[6]["more"]), ("agx", "Found it.", "Found it.\nSecond line."))
        self.assertEqual(its[7]["text"], 'Background command "build" completed — completed')
        self.assertEqual(its[11]["text"], "/model haiku")

    def test_paging_and_cursor(self):
        first = T.page(self.path, want=3)
        self.assertEqual(T.shown(first["items"]), 3)
        self.assertGreater(first["cursor"], 0)
        older = T.page(self.path, before=first["cursor"], want=100)
        self.assertEqual(older["cursor"], 0)
        whole = T.page(self.path, want=100)["items"]
        self.assertEqual(T.shown(older["items"]) + 3, T.shown(whole))

    def test_tail_waits_for_whole_lines(self):
        pg = T.page(self.path)
        tail = T.Tail(self.path, pg["tail"])
        self.assertEqual(tail.read(), [])
        line = json.dumps(ev(type="assistant", uuid="z", message={"content": [{"type": "text", "text": "live!"}]})) + "\n"
        with open(self.path, "a") as f:
            f.write(line[:20])
        self.assertEqual(tail.read(), [])
        with open(self.path, "a") as f:
            f.write(line[20:])
        self.assertEqual([i["text"] for i in tail.read()], ["live!"])

    def test_page_stops_at_a_half_written_line(self):
        with open(self.path, "a") as f:
            f.write('{"type": "assistant", "mess')
        pg = T.page(self.path)
        self.assertEqual(pg["tail"], os.path.getsize(self.path) - len('{"type": "assistant", "mess'))

    def test_subagent_stats_read_its_sidechain(self):
        sub = os.path.join(self.path[:-len(".jsonl")], "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-agx.jsonl"), "w") as f:
            for e in (
                ev(type="assistant", isSidechain=True, message={"content": [{"type": "tool_use", "id": "s1", "name": "Bash", "input": {"command": "ls", "description": "Look around"}}]}),
                ev(type="user", isSidechain=True, message={"content": [{"type": "tool_result", "tool_use_id": "s1", "content": "x"}]}),
                ev(type="assistant", isSidechain=True, message={"content": [{"type": "tool_use", "id": "s2", "name": "Read", "input": {"file_path": "/a/b.rs"}}]}),
            ):
                f.write(json.dumps(e, separators=(",", ":")) + "\n")
        st = T.subagent_stats(self.path, "agx")
        self.assertEqual((st["tools"], st["last"]), (2, "Read: /a/b.rs"))
        self.assertEqual(T.items(json.loads(json.dumps(ev(type="assistant", isSidechain=True, message={"content": [{"type": "text", "text": "x"}]})))), [])

    def test_mangle(self):
        self.assertEqual(T.mangle("/home/dweeb_xyz/Work/cc-live.x"), "-home-dweeb-xyz-Work-cc-live-x")


if __name__ == "__main__":
    unittest.main()
