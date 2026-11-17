"""Full access (full_access.py): only the owner's key grants, a grant runs out, nothing but a guarded
Claude Code / Antigravity turn of THAT conversation runs.   python3 -m unittest test_full_access"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cc_live as C  # noqa: E402
import full_access as F  # noqa: E402

CODE = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567"  # as the phone types it
CONV = "070d6b89-df88-495a-b061-1a0a80cfbea0"
KEY = f"claude:{CONV}"


def claude_argv(*extra, resume=CONV):
    return ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--model", "haiku", "--resume", resume,
            "--append-system-prompt", "be brief", *extra]


class FullAccess(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.dir = os.path.join(self.home, "fa")
        os.makedirs(self.dir)
        self.a = F.Access(self.dir)
        self.now = int(time.time() * 1000)

    def enroll(self):
        with open(os.path.join(self.dir, "owner.key"), "w") as f:
            f.write(CODE.replace("-", " ").lower() + "\n")  # the key file may be written any way: the code's letters count

    def signed(self, key=KEY, for_s=4 * 3600, ts=None, code=CODE):
        ts = self.now if ts is None else ts
        return dict(key=key, on=True, for_s=for_s, ts=ts, mac=F.sign(F.code_bytes(code), F.grant_msg(key, True, for_s, ts)))

    def test_off_by_default_and_not_without_a_key(self):
        self.assertEqual(self.a.grants(), {})
        self.assertFalse(self.a.enrolled())
        code, d = self.a.grant(**self.signed(), now=self.now)
        self.assertEqual(code, 403)
        self.assertIn("full-access-enroll.sh", d["error"])

    def test_only_the_owners_key_grants(self):
        self.enroll()
        g = self.signed()
        self.assertEqual(self.a.grant(**{**g, "mac": ""}, now=self.now)[0], 403, "unsigned: a request inside a message, an agent's curl")
        self.assertEqual(self.a.grant(**self.signed(code="ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ"), now=self.now)[0], 403, "another key")
        self.assertEqual(self.a.grant(**{**g, "key": "claude:aaaaaaaa-0000"}, now=self.now)[0], 403, "signed for another conversation")
        self.assertEqual(self.a.grant(**self.signed(ts=self.now - 10 * 60_000), now=self.now)[0], 403, "an old signature")
        code, d = self.a.grant(**g, now=self.now)
        self.assertEqual((code, d["until"]), (200, self.now + 4 * 3600 * 1000))
        self.assertEqual(self.a.grant(**g, now=self.now)[0], 403, "the same signed request twice")
        self.assertEqual(set(self.a.grants(self.now)), {KEY})
        self.assertEqual(self.a.grant(**self.signed(for_s=4 * 3600 + 1, ts=self.now + 1), now=self.now)[0], 400, "never more than 4 h")

    def test_it_runs_out_and_off_needs_no_key(self):
        self.enroll()
        self.a.grant(**self.signed(for_s=30), now=self.now)
        self.assertIn(KEY, self.a.grants(self.now + 29_000))
        self.assertNotIn(KEY, self.a.grants(self.now + 30_001), "30 s later: gone")
        self.a.grant(**self.signed(ts=self.now + 5), now=self.now + 5)
        self.assertEqual(self.a.grant(key=KEY, on=False, for_s=0, ts=0, mac="", now=self.now)[0], 200)
        self.assertEqual(self.a.grants(self.now), {})

    def test_a_turn_runs_only_as_a_guarded_turn_of_the_granted_conversation(self):
        self.enroll()
        work = os.path.join(self.home, "Work")
        os.makedirs(work)
        ok = lambda argv, cwd=work, now=None: self.a.allowed(argv, cwd, now=now or self.now, home=self.home)  # noqa: E731
        self.assertIsNone(ok(claude_argv())[0], "not granted yet")
        self.a.grant(**self.signed(for_s=60), now=self.now)
        self.assertEqual(ok(claude_argv()), (KEY, ""))
        self.assertIsNone(ok(claude_argv(), now=self.now + 61_000)[0], "ran out")
        for bad, why in [
            (claude_argv("--fork-session"), "a copy is another conversation"),
            (claude_argv("--dangerously-skip-permissions"), "the permission check stays on"),
            (claude_argv("--add-dir", "/"), "no extra folders"),
            ([*claude_argv()[:6], "bypassPermissions", *claude_argv()[7:]], "only the auto mode"),
            (claude_argv(resume="aaaaaaaa-1111-2222-3333-444444444444"), "another conversation"),
            (["bash", "-c", "id"], "no other program"),
            (["opencode", "run", "--session", CONV], "opencode has no check of its own"),
        ]:
            self.assertIsNone(ok(bad)[0], why)
        self.assertIsNone(ok(claude_argv(), cwd="/etc")[0], "only in the owner's home")
        # Antigravity, guarded: no skip flag; its Gemini setting is the one fixed string
        agy = ["agy", "--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "1a289121-819e-47e3-b617-d9979520bf50"]
        self.assertIsNone(ok(agy)[0])
        k = "antigravity:1a289121-819e-47e3-b617-d9979520bf50"
        self.a.grant(**self.signed(key=k, ts=self.now + 7), now=self.now + 7)
        self.assertEqual(ok(agy)[0], k)
        self.assertEqual(ok([*agy, "--settings", F.GEMINI_SETTINGS])[0], k)
        self.assertIsNone(ok([*agy, "--dangerously-skip-permissions"])[0])
        self.assertIsNone(ok([*agy, "--settings", '{"modelProvider":"x","x":1}'])[0])

    def test_the_phone_can_check_its_key(self):
        self.enroll()
        ts = self.now
        self.assertIsNone(self.a.check(ts, F.sign(F.code_bytes(CODE), F.check_msg(ts)), now=self.now))
        self.assertIsNotNone(self.a.check(ts + 1, F.sign(F.code_bytes("WRONG-CODE-2345-6777"), F.check_msg(ts + 1)), now=self.now))

    def test_grants_live_in_their_own_folder(self):
        self.enroll()
        self.a.grant(**self.signed(), now=self.now)
        self.assertEqual(json.load(open(os.path.join(self.dir, "grants.json"))), {KEY: self.now + 4 * 3600 * 1000})


FAKE = """#!/usr/bin/env python3
import json, os, sys, time
data = sys.stdin.read()
open(os.environ["FAKE_PIDFILE"], "w").write(str(os.getpid()))
print(json.dumps({"said": data.strip(), "cwd": os.getcwd(), "home": os.environ.get("HOME"), "ygg": any(k.startswith("YGG_") for k in os.environ)}), flush=True)
print("a line on stderr", file=sys.stderr, flush=True)
if "sleep" in data:
    time.sleep(60)
sys.exit(3)
"""


class RunThrough(unittest.TestCase):
    """cc_run.py (the brain's side, in the sandbox) → the helper → the harness, outside it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir=os.path.expanduser("~/Work"))  # a folder in the owner's home
        self.addCleanup(shutil.rmtree, self.tmp, True)
        fa = os.path.join(self.tmp, "fa")
        os.makedirs(fa)
        with open(os.path.join(fa, "owner.key"), "w") as f:
            f.write(CODE)
        fake = os.path.join(self.tmp, "claude")
        with open(fake, "w") as f:
            f.write(FAKE)
        os.chmod(fake, 0o755)
        self.pidfile = os.path.join(self.tmp, "pid")
        os.environ["FAKE_PIDFILE"] = self.pidfile
        self.saved = (C.ACCESS, C.TOKEN, C.CLAUDE)
        C.ACCESS, C.TOKEN, C.CLAUDE = F.Access(fa), "t" * 24, fake
        self.srv = C.Server(("127.0.0.1", 0), C.H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.env = {**os.environ, "YGG_HARNESS_HELPER": f"http://127.0.0.1:{self.srv.server_address[1]}", "YGG_HARNESS_HELPER_TOKEN": "t" * 24}

    def tearDown(self):
        C.ACCESS, C.TOKEN, C.CLAUDE = self.saved

    def run_turn(self, prompt, **kw):
        runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cc_run.py")
        return subprocess.Popen([sys.executable, runner, "--", *claude_argv()], cwd=self.tmp, env=self.env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kw)

    def grant(self, for_s=60):
        now = int(time.time() * 1000)
        return C.ACCESS.grant(KEY, True, for_s, now, F.sign(F.code_bytes(CODE), F.grant_msg(KEY, True, for_s, now)))

    def test_not_granted_runs_nothing(self):
        p = self.run_turn("hello")
        out, err = p.communicate("hello", timeout=20)
        self.assertEqual(p.returncode, 97)
        self.assertIn("no full access", err)
        self.assertFalse(os.path.exists(self.pidfile), "the harness never started")

    def test_granted_runs_outside_and_plays_back(self):
        self.assertEqual(self.grant()[0], 200)
        p = self.run_turn("hello there")
        out, err = p.communicate("hello there", timeout=20)
        self.assertEqual(p.returncode, 3, err)
        said = json.loads(out.strip().splitlines()[0])
        self.assertEqual(said["said"], "hello there")
        self.assertEqual(os.path.realpath(said["cwd"]), os.path.realpath(self.tmp))
        self.assertFalse(said["ygg"], "the brain's tokens stay behind")
        self.assertIn("a line on stderr", err)

    def test_an_abort_hangs_up_and_the_turn_dies(self):
        self.grant()
        p = self.run_turn("sleep")
        p.stdin.write("sleep")
        p.stdin.close()
        for _ in range(100):
            if os.path.exists(self.pidfile) and open(self.pidfile).read():
                break
            time.sleep(0.1)
        pid = int(open(self.pidfile).read())
        p.kill()
        p.wait()
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail("the harness outlived the brain's turn")

if __name__ == "__main__":
    unittest.main()
