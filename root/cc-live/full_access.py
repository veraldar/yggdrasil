"""Full access, one session at a time (owner 11-17).

A conversation the owner granted from the phone runs its turns OUTSIDE the brain's sandbox — on
this helper, which is outside it — for at most 4 hours: ssh, gh, the release key, the build tools,
the real services. Off by default. Never inherited: a grant names one conversation (`kind:id`), so a
copy of it or a session it starts is another conversation, in the sandbox. Only Claude Code and
Antigravity, in the guarded mode a conversation from the terminal runs in — their own permission
check stays on (opencode and codex have none in headless runs: they stay in the sandbox).

Only the owner grants: a grant must be signed with the owner's key, which lives in DIR/owner.key
(written at the computer by full-access-enroll.sh, typed once into the phone) — outside the
sandbox, so nothing running in it (MAIN, an agent, a request inside a message) can sign one. Turning
it off needs no key. The helper checks its own table on every run: a turn the brain sends here for
a conversation without a live grant runs nothing.
"""

import hashlib
import hmac
import json
import os
import re
import threading
import time

MAX_S = 4 * 3600  # the longest a grant lasts
SKEW_MS = 120_000  # how old a signed request may be
KEY = re.compile(r"^(claude|antigravity):[A-Za-z0-9_-]{8,80}$")
GEMINI_SETTINGS = '{"modelProvider":"gemini"}'

# what the brain runs, exactly (harness.rs `argv`, guarded): flag → its one allowed value (None:
# any value), and the flags that take none. Anything else — another permission mode, a fork, a
# skip-permissions flag, an extra directory — is refused.
SHAPES = {
    "claude": {
        "bin": "claude",
        "id": "--resume",
        "valued": {"--output-format": "stream-json", "--permission-mode": "auto", "--model": None, "--resume": None, "--append-system-prompt": None},
        "bare": {"-p", "--verbose"},
        "must": {"-p", "--permission-mode", "--resume"},
    },
    "antigravity": {
        "bin": "agy",
        "id": "--conversation",
        "valued": {"--input-format": "stream-json", "--output-format": "stream-json", "--model": None, "--conversation": None, "--settings": GEMINI_SETTINGS},
        "bare": set(),
        "must": {"--conversation"},
    },
}


def code_bytes(code: str) -> bytes:
    """The key as the phone types it: the code's letters and digits, upper case (spaces and
    dashes in it are for reading only)."""
    return re.sub(r"[^A-Z2-7]", "", code.upper()).encode()


def sign(key: bytes, msg: str) -> str:
    return hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()


def grant_msg(key: str, on: bool, for_s: int, ts: int) -> str:
    return f"grant|{key}|{'on' if on else 'off'}|{for_s}|{ts}"


def check_msg(ts: int) -> str:
    return f"check|{ts}"


class Access:
    def __init__(self, d: str):
        self.dir = os.path.expanduser(d)
        self.lock = threading.Lock()
        self.seen: dict[str, int] = {}  # signatures already used (no replay), until they are too old anyway

    # ---- the owner's key and the grants, both outside the sandbox ----
    def _key(self) -> bytes | None:
        try:
            with open(os.path.join(self.dir, "owner.key")) as f:
                k = code_bytes(f.read())
        except OSError:
            return None
        return k if len(k) >= 16 else None

    def enrolled(self) -> bool:
        return self._key() is not None

    def _load(self) -> dict:
        try:
            with open(os.path.join(self.dir, "grants.json")) as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, d: dict) -> None:
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        p = os.path.join(self.dir, "grants.json")
        with open(f"{p}.tmp", "w") as f:
            json.dump(d, f)
        os.replace(f"{p}.tmp", p)

    def grants(self, now: int | None = None) -> dict:
        """`kind:id` → until (ms) of every live grant."""
        now = now or int(time.time() * 1000)
        return {k: v for k, v in self._load().items() if isinstance(v, int) and v > now}

    # ---- signed requests from the phone ----
    def _verify(self, msg: str, ts, mac, now: int) -> str | None:
        key = self._key()
        if key is None:
            return "this box has no full-access key yet — run full-access-enroll.sh at the computer"
        if not isinstance(ts, int) or abs(now - ts) > SKEW_MS:
            return "the request is too old (or the phone's clock is off)"
        if not isinstance(mac, str) or not hmac.compare_digest(mac, sign(key, msg)):
            return "not signed with this box's full-access key (only the owner's phone has it)"
        with self.lock:
            self.seen = {m: t for m, t in self.seen.items() if now - t < 2 * SKEW_MS}
            if mac in self.seen:
                return "that signed request was already used"
            self.seen[mac] = now
        return None

    def check(self, ts, mac, now: int | None = None) -> str | None:
        return self._verify(check_msg(ts if isinstance(ts, int) else 0), ts, mac, now or int(time.time() * 1000))

    def grant(self, key, on, for_s, ts, mac, now: int | None = None) -> tuple[int, dict]:
        now = now or int(time.time() * 1000)
        if not isinstance(key, str) or not KEY.match(key):
            return 400, {"error": "full access is for one Claude Code or Antigravity conversation"}
        if on is not True:  # turning it off is always allowed
            with self.lock:
                d = self._load()
                d.pop(key, None)
                self._save(d)
            return 200, {"key": key, "until": None}
        if not isinstance(for_s, int) or not 0 < for_s <= MAX_S:
            return 400, {"error": f"for_s: 1–{MAX_S} seconds"}
        why = self._verify(grant_msg(key, True, for_s, ts if isinstance(ts, int) else 0), ts, mac, now)
        if why:
            return 403, {"error": why}
        until = now + for_s * 1000
        with self.lock:
            d = {k: v for k, v in self._load().items() if isinstance(v, int) and v > now}
            d[key] = until
            self._save(d)
        return 200, {"key": key, "until": until}

    # ---- a turn the brain sends here ----
    def allowed(self, argv, cwd, now: int | None = None, home: str | None = None) -> tuple[str | None, str]:
        """(the granted `kind:id` this run is for, '') — or (None, why it is refused)."""
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            return None, "argv: a list of strings"
        kind = next((k for k, s in SHAPES.items() if argv[0] == s["bin"]), None)
        if kind is None:
            return None, "only Claude Code and Antigravity conversations run with full access"
        shape, seen, i = SHAPES[kind], {}, 1
        while i < len(argv):
            a = argv[i]
            if a in shape["bare"]:
                seen[a] = True
                i += 1
            elif a in shape["valued"] and i + 1 < len(argv):
                want = shape["valued"][a]
                if want is not None and argv[i + 1] != want:
                    return None, f"{a} {argv[i + 1]} is not how a guarded turn runs"
                seen[a] = argv[i + 1]
                i += 2
            else:
                return None, f"{a}: not part of a guarded turn"
        missing = shape["must"] - set(seen)
        if missing:
            return None, f"missing {sorted(missing)}"
        key = f"{kind}:{seen[shape['id']]}"
        if key not in self.grants(now):
            return None, "this conversation has no full access (or it ran out) — the owner turns it on from the phone"
        home = home or os.path.expanduser("~")
        real = os.path.realpath(cwd) if isinstance(cwd, str) else ""
        if not os.path.isdir(real) or not (real == home or real.startswith(home + os.sep)):
            return None, "the folder must be in the owner's home"
        return key, ""
