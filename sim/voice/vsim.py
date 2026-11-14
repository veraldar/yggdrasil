#!/usr/bin/env python3
"""vsim.py — the VOICE persona simulation: an LLM plays the human behind each root and SPEAKS.

Per turn: persona text → real TTS (its own voice/speed, optional noise bed, optional speaker
echo) → injected as the phone's microphone (sim/voice/phone.mjs, a Pixel 7 in Chromium) →
the app's hands-free voice path → the box's STT (the voice agent) → MAIN (real model) → the
app's spoken reply → captured off the phone's audio output → the persona's own STT → the
persona reads what it actually HEARD → next turn. Then deterministic checks (hsim's, on the
files the sessions built, plus voice checks on the turn log) and an LLM judge with an added
"voice" score. Output: report.md + report.json + every turn's audio.

    vsim.py SCENARIO.json [--port 4170] [--keep] [--out DIR]          # own stack, own ports
    vsim.py SCENARIO.json --target https://host:8447 --brain http://127.0.0.1:4101
    vsim.py SCENARIO.json --target home=http://…,lab=http://… --brain home=http://…,lab=http://…

Transport-agnostic: the phone only knows the target app URL (whatever carries it — tailnet
today, the trunk tomorrow); the brain URL is a side channel for checks and transcripts.
Exit 0 = PASS, 1 = FAIL, 3 = rig error (never a pass).
"""
import argparse, json, os, re, signal, subprocess, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import hsim  # noqa: E402  (the text sim: brain API, persona/judge LLM calls, deterministic checks)
import speech  # noqa: E402
import stack as stackmod  # noqa: E402

PERSONA_MODEL = os.environ.get("VSIM_PERSONA_MODEL", hsim.PERSONA_MODEL)
JUDGE_MODEL = os.environ.get("VSIM_JUDGE_MODEL", hsim.JUDGE_MODEL)
COMMAND_WORDS = r"^(?:ok(?:ay)?\s+)?(pause|wait|hold on|continue|resume|go on|faster|slower|speed up|slow down|stop|quiet|enough)\b[\s.!,]*(?:please)?[\s.!]*$"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def jload(path):
    return json.load(open(path))


# ── the phone (one phone.mjs process) ─────────────────────────────────────────
class Phone:
    def __init__(self, name, out, cfg, headed=False):
        self.name, self.out = name, out
        os.makedirs(out, exist_ok=True)
        cmd = ["node", os.path.join(HERE, "phone.mjs"), "--name", name, "--out", out, "--cfg", json.dumps(cfg)]
        if headed:
            cmd.append("--headed")
        self.err = open(os.path.join(out, f"phone-{name}.log"), "a")
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, text=True, bufsize=1)
        self.res, self.cv, self.n, self.lock = {}, threading.Condition(), 0, threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()
        with self.cv:
            if not self.cv.wait_for(lambda: 0 in self.res, 90):
                raise RuntimeError(f"phone {name} did not start")
        self.res.pop(0)

    def _read(self):
        for line in self.p.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            with self.cv:
                self.res[m.get("id")] = m
                self.cv.notify_all()
        with self.cv:
            self.res["dead"] = True
            self.cv.notify_all()

    def call(self, cmd, timeout=180, **kw):
        with self.lock:
            self.n += 1
            i = self.n
            self.p.stdin.write(json.dumps({"id": i, "cmd": cmd, **kw}) + "\n")
            self.p.stdin.flush()
        with self.cv:
            if not self.cv.wait_for(lambda: i in self.res or "dead" in self.res, timeout):
                raise TimeoutError(f"phone {self.name}: {cmd} timed out")
            if i not in self.res:
                raise RuntimeError(f"phone {self.name} died")
            m = self.res.pop(i)
        if not m["ok"]:
            raise RuntimeError(f"phone {self.name}: {cmd}: {m['error']}")
        return m["result"]

    def close(self):
        try:
            self.call("close", timeout=20)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.p.wait(10)
        except Exception:  # noqa: BLE001
            self.p.kill()


# ── one persona's line to one root's MAIN (a tab on their phone) ──────────────
class Line:
    def __init__(self, phone, root, persona, audio_dir):
        self.phone, self.root, self.persona = phone, root, persona
        self.tab = root["name"]
        self.brain = hsim.Brain(root["brain"]) if root.get("brain") else None
        self.main_id = self.brain.main_id() if self.brain else None
        self.audio_dir = audio_dir
        self.pulled_t = 0  # wall ms the reply bus was last pulled at
        self.opened = False

    def pair(self, admin_token=None):
        """devices mode: the box console mints a one-time code (POST /api/pair/code — loopback or the
        admin token), the phone 'scans' the QR (opens its URL: the app behind the access point that
        BIFROST_PUBLIC_URL names) and redeems it. From then on the phone talks to that origin."""
        import urllib.request
        hdr = {"content-type": "application/json"}
        if admin_token:
            hdr["authorization"] = f"Bearer {admin_token}"
        r = urllib.request.Request(self.root["app"].rstrip("/") + "/api/pair/code", data=json.dumps({"name": f"vsim-{self.persona['id']}"}).encode(), headers=hdr)
        qr = json.loads(urllib.request.urlopen(r, timeout=20).read())["url"]
        res = self.phone.call("pair", tab=self.tab, url=qr, timeout=60)
        self.root = dict(self.root, app=qr.split("/pair#")[0])
        log(f"[{self.persona['id']}→{self.tab}] paired through {self.root['app']} → landed {res['landed']}")
        return res

    def open(self):
        if self.root.get("pair") and not getattr(self, "paired", False):
            self.pair(self.root.get("admin_token"))
            self.paired = True
        url = self.root["app"].rstrip("/") + (f"/session/main?id={self.main_id}" if self.main_id else "/session/main")
        self.phone.call("open", tab=self.tab, url=url, timeout=60)
        t_tap = self.phone.call("since", tab=self.tab, t=0)["now"]
        r = self.phone.call("handsfree", tab=self.tab, timeout=90, settle=1500)
        self.wait_agent(t_tap)
        self.opened = True
        log(f"[{self.persona['id']}→{self.tab}] hands-free on ({r['ms']} ms)")

    def wait_agent(self, since_ms, secs=45):
        """the voice agent is in the room and armed. Own stack: its log says so for this room. Any
        other target: the app's own 10 s 'no voice agent' check stays quiet for 12 s."""
        alog = self.root.get("agent_log")
        end = time.time() + secs
        if alog and self.main_id:
            pat = f"room '{self.main_id}' ready"
            while time.time() < end:
                for line in open(alog, errors="replace").read().splitlines()[-400:]:
                    if pat in line:
                        try:
                            ts = json.loads(line).get("timestamp", "")
                            t = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
                        except Exception:  # noqa: BLE001
                            t = time.time()
                        if t * 1000 >= since_ms - 2000:
                            return True
                time.sleep(0.5)
            log(f"[{self.tab}] agent never armed for room {self.main_id} — going on anyway")
            return False
        t0 = self.phone.call("since", tab=self.tab, t=0)["now"]
        time.sleep(12)
        s = self.phone.call("since", tab=self.tab, t=t0)
        return not any("no voice agent" in d["msg"] for d in s["diag"])

    def since(self, t):
        return self.phone.call("since", tab=self.tab, t=t)

    def messages(self):
        """MAIN's full transcript as the box holds it (user voice turns = what the box's STT heard)"""
        if not self.brain:
            return []
        out = []
        for m in self.brain.req("GET", f"/session/{self.main_id}/message"):
            info = m.get("info", {})
            out.append({"id": info.get("id"), "role": info.get("role"), "voice": info.get("modality") == "voice",
                        "text": "\n".join(p.get("text", "") for p in m.get("parts", []) if p.get("type") == "text").strip(),
                        "created": (info.get("time") or {}).get("created"), "completed": (info.get("time") or {}).get("completed")})
        return out


# ── the persona ───────────────────────────────────────────────────────────────
VOICE_PERSONA_SYSTEM = """You are role-playing a real human user of "bifrost": a phone app to talk to their own AI that runs on their own computer at home. You use it HANDS-FREE: you SPEAK to it and it SPEAKS back. On each computer ("root") you talk to ONE conversation, "main" — the coordinator — which creates and manages work sessions; the phone also shows a session list you can glance at, but you never manage sessions yourself.

Persona: {persona}

Your goals for this session:
{goals}

How this session goes (follow it loosely, like a real person would):
{script}

How talking works:
- Whatever you "say" is turned into your voice and goes into the phone's mic. End every utterance with the word "over" (the app's keyword for "your turn"); if you forget, it is added for you.
- Speak like this person talks out loud: short, informal, spoken words. No markdown, no code, no file paths spelled out unless your goals need them. You may hesitate ("um", "uh"), correct yourself mid-sentence, or ramble a bit if that is your style.
- You only know what you HEARD main say (written below as you heard it — the speech recognition in your ears is not perfect, so it may contain odd words) and what the session list shows. You cannot see files, and you do not read main's replies on screen.
- While main is speaking you can use voice commands: "pause", "continue", "faster", "slower", "stop". Plan them with "during_reply": a list of {{"at_s": <seconds after main starts speaking>, "text": "<command>"}}. To interrupt main with a new request while it talks, put that request (ending in "over") in during_reply — that is a barge-in.
- A real person doesn't take "done" on faith: when main says something is finished, it's fair to ask how it was checked.
- After giving work, you usually wait for main to come back to you (action "wait"); a real person doesn't poll every few seconds.
- You are done when every goal is achieved and confirmed by main — or when you give up (then say why).
{roots_note}
Reply with ONLY one JSON object, nothing else:
{{"action":"say","text":"<what you say, ending in over>"{to_field},"during_reply":[]}}
{{"action":"wait","seconds":<30-900>,"why":"<what you're waiting for>"}}
{{"action":"done","satisfied":true|false,"why":"<one or two sentences>"}}"""


class Persona:
    def __init__(self, spec, sc, roots, phone, out):
        self.spec, self.sc, self.id = spec, sc, spec["id"]
        self.voice = {"voice": "af_heart", "speed": 1.0, **(spec.get("voice") or {})}
        self.phone = phone
        self.audio = os.path.join(out, "audio")
        os.makedirs(self.audio, exist_ok=True)
        self.lines = {r["name"]: Line(phone, r, spec, self.audio) for r in roots if r["name"] in spec.get("roots", [roots[0]["name"]])}
        self.home = spec.get("roots", [roots[0]["name"]])[0]
        self.heard = []  # [{t, who, text, root}] — the persona's memory of the conversation
        self.turns, self.events, self.verdict, self.cost, self.n = [], [], None, 0.0, 0
        self.started = time.time()

    # ── LLM decision ────────────────────────────────────────────────────────
    def decide(self, waited_note):
        sp = self.spec
        multi = len(self.lines) > 1
        system = VOICE_PERSONA_SYSTEM.format(
            persona=sp["persona"], goals="\n".join(f"- {g}" for g in sp["goals"]),
            script="\n".join(f"- {s}" for s in sp.get("script", [])) or "- (no particular order)",
            roots_note=(f"- Your phone has one app per computer: {', '.join(self.lines)}. Say which one you talk to with \"to\".\n" if multi else ""),
            to_field=(',"to":"<' + "|".join(self.lines) + '>"' if multi else ""))
        conv = []
        t0 = self.started
        for h in sorted(self.heard, key=lambda h: h["t"]):
            tag = f" ({h['root']})" if multi else ""
            conv.append(f"[+{(h['t'] - t0) / 60:.1f}m] {h['who']}{tag}: {h['text']}")
        plist = []
        for name, ln in self.lines.items():
            if ln.brain:
                try:
                    plist.append((f"{name}:\n" if multi else "") + hsim.phone_list(ln.brain.tree(), ln.main_id))
                except Exception:  # noqa: BLE001
                    pass
        prompt = (f"Time since you started: {(time.time() - t0) / 60:.1f} min.{waited_note}\n\n"
                  f"The conversation so far, as you heard it:\n{chr(10).join(conv) or '(nothing yet — you open the app and turn on hands-free)'}\n\n"
                  f"Your phone's session list right now:\n{chr(10).join(plist) or '(not shown)'}\n\nWhat do you do now? JSON only.")
        text, cost = hsim.claude(system, prompt, PERSONA_MODEL)
        self.cost += cost
        return hsim.jobj(text)

    # ── speech out ──────────────────────────────────────────────────────────
    def mouth(self, intended, path, pauses=None):
        """what actually comes out: the scenario's mishearings (the person says one word, a
        similar-sounding one reaches the mic) and 'over' at the end"""
        spoken = intended.strip()
        for mh in self.sc.get("mishear", []) + self.spec.get("mishear", []):
            used = mh.setdefault("_used", 0)
            if mh.get("times") is not None and used >= mh["times"]:
                continue  # the recognizer only got it wrong the first N times
            if re.search(rf"\b{re.escape(mh['meant'])}\b", spoken, re.I):
                spoken = re.sub(rf"\b{re.escape(mh['meant'])}\b", mh["say"], spoken, flags=re.I)
                mh["_used"] = used + 1
        if not re.search(r"\bover(\s+and\s+out)?[\s.!?]*$", spoken, re.I) and not re.match(COMMAND_WORDS, spoken, re.I):
            spoken = spoken.rstrip(" .!?,") + ". Over."
        words = len(spoken.split())
        pause = self.voice.get("pause_s", 1.2) if (pauses or (pauses is None and words > 45)) else 0
        speech.speak(spoken, path, voice=self.voice["voice"], speed=self.voice.get("speed", 1.0), pause_s=pause)
        return spoken

    # ── one spoken turn with its reply ──────────────────────────────────────
    def turn(self, act):
        to = act.get("to") if act.get("to") in self.lines else self.home
        ln = self.lines[to]
        if not ln.opened:
            ln.open()
        self.n += 1
        k = f"{self.id}-t{self.n:02d}"
        intended = (act.get("text") or "").strip()
        rec = {"n": self.n, "persona": self.id, "root": to, "intended": intended, "utterances": [], "incidents": []}
        # every wav is synthesized BEFORE the mic opens: a keyword must come out on time
        say_wav = os.path.join(self.audio, f"{k}-say.wav")
        spoken = self.mouth(intended, say_wav, act.get("pauses"))
        during = []
        for j, d in enumerate(sorted(act.get("during_reply") or [], key=lambda d: float(d.get("at_s", 3)))):
            w = os.path.join(self.audio, f"{k}-x{j + 1}.wav")
            if re.search(r"\bover[\s.!?]*$", d["text"], re.I):
                dtext = self.mouth(d["text"], w)  # a barge-in: a whole new turn
            else:
                dtext = d["text"]  # a deck command: just the words
                speech.speak(dtext, w, voice=self.voice["voice"], speed=self.voice.get("speed", 1.0), lead_s=0.1, tail_s=0.2)
            during.append({"at_s": float(d.get("at_s", 3)), "text": dtext, "wav": w,
                           "barge": bool(re.search(r"\bover[\s.!?]*$", dtext, re.I))})
        # a polite person lets a reply that is still playing end first (unless they barge in) —
        # and hears it: anything spoken since the last pull is an unprompted report
        self.drain(ln, "while the person was about to speak")
        before = {m["id"] for m in ln.messages()}
        log(f"[{self.id}→{to}] SAYS: {spoken}")
        r = ln.phone.call("say", tab=ln.tab, wav=say_wav, timeout=300)
        utt = {"kind": "turn", "spoken": spoken, "intended": intended, "wav": os.path.relpath(say_wav, os.path.dirname(self.audio)),
               "t0": r["t0"], "t1": r["t1"], "dur": r["dur"]}
        rec["utterances"].append(utt)
        committed = self.wait_commit(ln, r["t1"], 14)
        if not committed:
            # the human repeats the keyword — then, if still nothing, the whole thing once
            rec["incidents"].append("no commit after 14 s: said 'over' again")
            w = os.path.join(self.audio, f"{k}-over.wav")
            speech.speak("Over.", w, voice=self.voice["voice"], speed=self.voice.get("speed", 1.0), lead_s=0.1)
            r2 = ln.phone.call("say", tab=ln.tab, wav=w)
            committed = self.wait_commit(ln, r2["t1"], 12)
            if not committed:
                rec["incidents"].append("still no commit: repeated the whole turn")
                r2 = ln.phone.call("say", tab=ln.tab, wav=say_wav, timeout=300)
                committed = self.wait_commit(ln, r2["t1"], 14)
            utt["t1"] = r2["t1"]
        utt["commit"] = committed
        last_t1 = utt["t1"]
        # keywords / barge-in while the reply plays
        if during:
            onset = self.wait_onset(ln, utt["t1"], act.get("reply_timeout", 240))
            if onset is None:
                rec["incidents"].append("reply never started — the planned interjections were not spoken")
            else:
                for d in during:
                    delay = onset / 1000 + d["at_s"] - time.time()
                    if delay > 0:
                        time.sleep(delay)
                    s0 = ln.since(0)
                    if not d["barge"] and "nodeck" in s0["uiState"] and not s0["playing"]:
                        rec["incidents"].append(f"{d['text']!r} not spoken: the reply was already over at +{d['at_s']}s")
                        rec["utterances"].append({"kind": "command", "spoken": d["text"], "intended": d["text"], "skipped": True,
                                                  "planned_at_s": d["at_s"], "ui_before": s0["uiState"], "t0": s0["now"], "t1": s0["now"], "dur": 0})
                        continue
                    rd = ln.phone.call("say", tab=ln.tab, wav=d["wav"], timeout=300)
                    u = {"kind": "barge" if d["barge"] else "command", "spoken": d["text"], "intended": d["text"],
                         "wav": os.path.relpath(d["wav"], os.path.dirname(self.audio)), "t0": rd["t0"], "t1": rd["t1"], "dur": rd["dur"],
                         "ui_before": s0["uiState"], "planned_at_s": d["at_s"], "playing_at_start": s0["playing"]}
                    log(f"[{self.id}→{to}] {u['kind'].upper()} at +{(rd['t0'] - onset) / 1000:.1f}s: {d['text']}")
                    rec["utterances"].append(u)
                    if d["barge"]:
                        u["commit"] = self.wait_commit(ln, rd["t1"], 14)
                        last_t1 = rd["t1"]
                        break
        end = self.wait_reply_end(ln, last_t1, act.get("reply_timeout", 300))
        rec["reply_wait"] = end
        self.collect(ln, rec, before, k)
        self.turns.append(rec)
        return rec

    def wait_quiet(self, ln, secs):
        end = time.time() + secs
        while time.time() < end:
            s = ln.since(int(time.time() * 1000))
            if not s["playing"] and s["uiState"].startswith(("listening", "off")):
                return True
            time.sleep(1)
        return False

    def wait_commit(self, ln, t1, secs):
        """the agent heard "over": the app mutes the mic and shows 'working' (or a reply starts)"""
        end = time.time() + secs
        while time.time() < end:
            s = ln.since(t1 - 500)
            if any(e["kind"] == "mic-off" for e in s["events"]) or any(u["state"].startswith("working") for u in s["ui"]) or s["reply"]:
                return True
            time.sleep(0.4)
        return False

    def wait_onset(self, ln, t1, secs):
        end = time.time() + secs
        while time.time() < end:
            s = ln.since(t1)
            sp = [x for x in s["reply"] if x["a"] >= t1 - 100]
            if sp:
                return sp[0]["a"]
            time.sleep(0.25)
        return None

    def wait_reply_end(self, ln, t1, secs, quiet_ms=2500):
        """the reply has been spoken (or it is clear none comes): onset, end, and how it ended"""
        end = time.time() + secs
        onset, msg_done_at = None, None
        while time.time() < end:
            s = ln.since(t1)
            sp = [x for x in s["reply"] if x["a"] >= t1 - 100]
            if sp and onset is None:
                onset = sp[0]["a"]
            if onset is not None:
                last = sp[-1]["b"]
                if not s["playing"] and s["now"] - last > quiet_ms and not s["uiState"].startswith(("working", "speaking")):
                    return {"onset": onset, "end": last, "how": "spoken", "ui": s["uiState"]}
                if s["now"] - last > 15000 and "paused" not in s["uiState"]:
                    # a person notices 15 s of silence in the middle of an answer
                    return {"onset": onset, "end": last, "how": "went silent", "ui": s["uiState"]}
            else:
                # MAIN answered but nothing plays: the app chose not to speak it (or failed to)
                msgs = ln.messages()
                done = [m for m in msgs if m["role"] == "assistant" and (m["completed"] or 0) >= t1 - 2000 and m["text"]]
                if done and msg_done_at is None:
                    msg_done_at = time.time()
                if msg_done_at and time.time() - msg_done_at > 30 and s["uiState"].startswith(("listening", "off")):
                    return {"onset": None, "end": None, "how": "unspoken", "ui": s["uiState"]}
            time.sleep(0.5)
        s = ln.since(t1)
        return {"onset": onset, "end": (s["reply"][-1]["b"] if s["reply"] else None), "how": "timeout", "ui": s["uiState"]}

    # ── what was heard, on both sides ───────────────────────────────────────
    def collect(self, ln, rec, before, k):
        utts = rec["utterances"]
        t_first = utts[0]["t0"]
        reply_path = os.path.join(self.audio, f"{k}-reply-raw.wav")
        mic_path = os.path.join(self.audio, f"{k}-mic.wav")
        pr = ln.phone.call("pull", tab=ln.tab, bus="reply", path=reply_path)
        pm = ln.phone.call("pull", tab=ln.tab, bus="mic", path=mic_path)
        if pm.get("path"):
            # keep the mic from the turn's first word on
            speech.trim(mic_path, mic_path, max(0, (t_first - 300 - pm["t0"]) / 1000))
            rec["mic_wav"] = os.path.relpath(mic_path, os.path.dirname(self.audio))
        s = ln.since(t_first - 1000)
        rec["timeline"] = {"ui": [(u["t"] - t_first, u["state"]) for u in s["ui"]],
                           "console": [(c["t"] - t_first, c["type"], c["text"][:160]) for c in s.get("console", [])][-30:],
                           "events": [(e["t"] - t_first, e["kind"]) for e in s["events"] if not e["kind"].startswith("media-ratechange")][:80],
                           "diag": [(d["t"] - t_first, d["msg"][:120]) for d in s["diag"]][:60]}
        rec["tts"] = [{"text": x["text"], "status": x["status"], "t": x["t"] - t_first} for x in s["tts"]]
        msgs = ln.messages()
        new = [m for m in msgs if m["id"] not in before]
        # the box side: each over-ending utterance should be a voice turn, answered by MAIN
        voice_in = [m for m in new if m["role"] == "user"]
        replies = [m for m in new if m["role"] == "assistant" and m["text"]]
        heard_by_box = [m for m in voice_in if m["voice"]]
        spoken_utts = [u for u in utts if u["kind"] in ("turn", "barge")]
        for i, u in enumerate(spoken_utts):
            m = heard_by_box[i] if i < len(heard_by_box) else None
            u["box_heard"] = m["text"] if m else None
            ref = re.sub(r"[\s.,!?]*\bover(\s+and\s+out)?[\s.!?]*$", "", u["spoken"], flags=re.I)
            u["box_wer"] = speech.wer(ref, m["text"]) if m else None
            if m:
                ans = next((x for x in msgs[msgs.index(next(y for y in msgs if y["id"] == m["id"])) + 1:] if x["role"] == "assistant" and x["text"]), None)
                u["main_reply"] = ans["text"] if ans else None
                u["t_user_msg"] = m["created"]
                u["t_main_done"] = ans["completed"] if ans else None
        rec["commands_reached_main"] = [m["text"] for m in voice_in if re.match(COMMAND_WORDS, m["text"].strip(), re.I)]
        rec["main_replies"] = [m["text"] for m in replies]
        # the persona side: what came out of the phone, utterance by utterance
        rw = rec["reply_wait"]
        if pr.get("path"):
            bounds = [u["t1"] for u in spoken_utts] + [None]
            for i, u in enumerate(spoken_utts):
                a = u["t1"]
                b = bounds[i + 1]
                if b is not None:  # cut where the barge-in started speaking
                    b = next((x["t0"] for x in utts if x["kind"] == "barge" and x["t0"] > a), b)
                out = os.path.join(self.audio, f"{k}-reply{i + 1}.wav")
                speech.trim(reply_path, out, max(0, (a - pr["t0"]) / 1000), (b - pr["t0"]) / 1000 if b else None)
                spans = speech.loud_spans(out)
                u["reply_wav"] = os.path.relpath(out, os.path.dirname(self.audio))
                u["reply_audio_s"] = round(sum(e - s0 for s0, e in spans), 1)
                if rw.get("how") == "went silent":
                    rec["incidents"].append(f"the reply went silent {round(sum(e - s0 for s0, e in spans), 1)} s in (deck still '{rw.get('ui')}')")
                if spans and sum(e - s0 for s0, e in spans) < 0.6:
                    u["first_audio_s"] = round(spans[0][0], 2)
                    u["persona_heard"] = ""  # a blip, nothing a person could understand (whisper makes 'you' of it)
                    self.heard.append({"t": u["t1"] / 1000 + spans[0][0], "who": "main", "root": ln.tab,
                                       "text": "(starts to speak, then silence — you heard nothing you could understand)"})
                elif spans:
                    u["first_audio_s"] = round(spans[0][0], 2)
                    u["reply_end_s"] = round(spans[-1][1], 2)
                    clip = os.path.join(self.audio, f"{k}-heard{i + 1}.wav")
                    speech.trim(out, clip, max(0, spans[0][0] - 0.3), spans[-1][1] + 0.5)
                    u["persona_heard"] = speech.stt(clip)
                    os.remove(clip)
                else:
                    u["persona_heard"] = ""
                tts_ref = " ".join(x["text"] for x in s["tts"] if x["t"] >= a - 200 and (b is None or x["t"] < b + 200))
                u["tts_text"] = tts_ref
                if tts_ref and u["persona_heard"]:
                    u["reply_wer"] = speech.wer(tts_ref, u["persona_heard"])
                    u["reply_wer_heard"], u["reply_words_covered"] = speech.wer_prefix(tts_ref, u["persona_heard"])
                    u["reply_words_total"] = len(speech.norm_words(tts_ref))
            os.remove(reply_path)
        # latency on one clock (the phone's): end of speech → first reply audio → end of reply
        for u in spoken_utts:
            if u.get("first_audio_s") is not None:
                u["latency"] = {"first_audio_s": u["first_audio_s"], "reply_end_s": u.get("reply_end_s")}
                if u.get("t_user_msg"):
                    u["latency"]["stt_commit_s"] = round((u["t_user_msg"] - u["t1"]) / 1000, 2)
                if u.get("t_main_done") and u.get("t_user_msg"):
                    u["latency"]["main_s"] = round((u["t_main_done"] - u["t_user_msg"]) / 1000, 2)
                    u["latency"]["tts_first_s"] = round(u["first_audio_s"] - (u["t_main_done"] - u["t1"]) / 1000, 2)
        # deck effects of the voice commands (ui transitions after each command)
        for u in utts:
            if u["kind"] != "command" or u.get("skipped"):
                continue
            nxt = min([x["t0"] for x in utts if x["t0"] > u["t0"]] + [u["t1"] + 8000])  # until the next utterance
            after = [st for (t, st) in rec["timeline"]["ui"] if u["t0"] - t_first - 200 <= t <= min(nxt, u["t1"] + 8000) - t_first]
            u["ui_after"] = after
            u["agent_saw"] = self.agent_saw(ln, u)
        # the persona's memory
        for u in utts:
            self.heard.append({"t": u["t0"] / 1000, "who": "you", "root": ln.tab, "text": u["intended"]})
            if u.get("persona_heard"):
                cut = " (you cut it off)" if any(x["kind"] in ("barge",) and x["t0"] > u["t1"] for x in utts) or \
                    any(x["kind"] == "command" and re.search(r"stop|quiet|enough", x["spoken"], re.I) for x in utts) else ""
                self.heard.append({"t": u["t1"] / 1000 + (u.get("first_audio_s") or 0), "who": "main", "root": ln.tab,
                                   "text": u["persona_heard"] + cut})
        if rw["how"] == "unspoken" and replies:
            self.heard.append({"t": time.time(), "who": "main (on screen, not read aloud)", "root": ln.tab, "text": replies[-1]["text"][:600]})
        log(f"[{self.id}→{ln.tab}] turn {rec['n']}: " + " | ".join(
            f"box heard {u.get('box_heard')!r} (wer {u.get('box_wer')}) → heard back {(u.get('persona_heard') or '')[:160]!r} "
            f"(wer {u.get('reply_wer_heard')}, first audio {u.get('first_audio_s')}s)" for u in spoken_utts))

    def agent_saw(self, ln, u):
        """what the voice agent made of a command (own stack only: its log)"""
        alog = ln.root.get("agent_log")
        if not alog:
            return None
        out = []
        for line in open(alog, errors="replace").read().splitlines()[-600:]:
            if "voice command" in line or "dropped" in line or "keyword commit" in line:
                try:
                    d = json.loads(line)
                    ts = d.get("timestamp", "")
                    t = (time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone) * 1000 + int(ts[20:23] or 0)
                except Exception:  # noqa: BLE001
                    continue
                if u["t0"] - 500 <= t <= u["t1"] + 8000:
                    out.append(d["message"][:140])
        return out

    def drain(self, ln, why="between turns"):
        """whatever the phone said while the person was thinking (an unprompted report spoken
        between turns) is heard too: pull it, transcribe it, remember it"""
        if not ln.opened:
            return None
        self.wait_quiet(ln, 120)
        raw = os.path.join(self.audio, f"{self.id}-d{self.n:02d}-{int(time.time())}.wav")
        pr = ln.phone.call("pull", tab=ln.tab, bus="reply", path=raw)
        ln.phone.call("pull", tab=ln.tab, bus="mic", path=None)
        if not pr.get("path"):
            return None
        spans = speech.loud_spans(raw)
        if not spans or sum(e - a for a, e in spans) < 0.8:
            os.remove(raw)
            return None
        self.n += 1
        k = f"{self.id}-r{self.n:02d}"
        out = os.path.join(self.audio, f"{k}-report.wav")
        speech.trim(raw, out, max(0, spans[0][0] - 0.3), spans[-1][1] + 0.5)
        os.remove(raw)
        heard = speech.stt(out)
        t_on = pr["t0"] + spans[0][0] * 1000
        s = ln.since(int(t_on) - 30000)
        tts_ref = " ".join(x["text"] for x in s["tts"] if x["t"] <= t_on + 2000)
        self.turns.append({"n": self.n, "persona": self.id, "root": ln.tab, "kind": "report", "incidents": [], "reply_wait": {"how": why},
                           "utterances": [{"kind": "report", "spoken": "", "intended": "", "persona_heard": heard, "tts_text": tts_ref,
                                           "reply_wav": os.path.relpath(out, os.path.dirname(self.audio)), "t0": t_on, "t1": t_on,
                                           "reply_wer": speech.wer(tts_ref, heard) if tts_ref and heard else None,
                                           "reply_wer_heard": speech.wer_prefix(tts_ref, heard)[0] if tts_ref and heard else None,
                                           "reply_audio_s": round(sum(e - a for a, e in spans), 1)}]})
        self.heard.append({"t": t_on / 1000, "who": "main", "root": ln.tab, "text": heard})
        log(f"[{self.id}←{ln.tab}] UNPROMPTED ({why}), heard: {heard[:200]}")
        return heard

    # ── waiting for main to come back by itself ─────────────────────────────
    def wait(self, secs):
        ln = self.lines[self.home] if self.lines[self.home].opened else next((x for x in self.lines.values() if x.opened), None)
        if ln is None:
            time.sleep(min(secs, 30))
            return " You waited — nothing happened (hands-free is not on yet)."
        t0 = int(time.time() * 1000)
        end = time.time() + secs
        spoke = []
        while time.time() < end:
            time.sleep(3)
            for name, l2 in self.lines.items():
                if not l2.opened:
                    continue
                s = l2.since(t0)
                if s["reply"]:
                    spoke.append((name, l2))
            if spoke:
                break
        got = []
        for name, l2 in dict(spoke).items():
            r = self.wait_reply_end(l2, t0, 300)
            time.sleep(6)  # a report may come in two messages
            r2 = self.wait_reply_end(l2, t0, 120)
            self.n += 1
            k = f"{self.id}-w{self.n:02d}"
            raw = os.path.join(self.audio, f"{k}-report-raw.wav")
            pr = l2.phone.call("pull", tab=l2.tab, bus="reply", path=raw)
            l2.phone.call("pull", tab=l2.tab, bus="mic", path=None)
            heard = ""
            if pr.get("path"):
                out = os.path.join(self.audio, f"{k}-report.wav")
                speech.trim(raw, out, max(0, (t0 - pr["t0"]) / 1000))
                os.remove(raw)
                spans = speech.loud_spans(out)
                if spans:
                    clip = out + ".clip.wav"
                    speech.trim(out, clip, max(0, spans[0][0] - 0.3), spans[-1][1] + 0.5)
                    heard = speech.stt(clip)
                    os.remove(clip)
                s = l2.since(t0)
                tts_ref = " ".join(x["text"] for x in s["tts"])
                self.turns.append({"n": self.n, "persona": self.id, "root": name, "kind": "report", "utterances": [{
                    "kind": "report", "spoken": "", "intended": "", "persona_heard": heard, "tts_text": tts_ref,
                    "reply_wav": os.path.relpath(out, os.path.dirname(self.audio)),
                    "reply_wer": speech.wer(tts_ref, heard) if tts_ref and heard else None,
                    "reply_wer_heard": speech.wer_prefix(tts_ref, heard)[0] if tts_ref and heard else None,
                    "reply_audio_s": round(sum(e - a for a, e in spans), 1)}], "reply_wait": r2 or r, "incidents": []})
            if heard:
                self.heard.append({"t": time.time(), "who": "main", "root": name, "text": heard})
                got.append(heard)
                log(f"[{self.id}←{name}] UNPROMPTED, heard: {heard[:200]}")
        waited = int(secs - max(0, end - time.time()))
        self.silent_s = 0 if got else getattr(self, "silent_s", 0) + waited
        note = f" You just waited {waited}s" + (" — main came back to you (see above)." if got else " — main said nothing.")
        if self.silent_s >= 300:
            note += f" That makes {self.silent_s // 60} minutes with no word from main: a real person would ask main about it now."
        return note

    # ── the loop ────────────────────────────────────────────────────────────
    def run(self, max_min, max_turns):
        waited_note = ""
        turns = 0
        while True:
            el = (time.time() - self.started) / 60
            if el > max_min:
                self.events.append({"t": el, "kind": "timeout"})
                log(f"[{self.id}] time budget spent")
                break
            if turns >= max_turns:
                self.events.append({"t": el, "kind": "turns"})
                log(f"[{self.id}] turn budget spent")
                break
            for ln in self.lines.values():
                if self.drain(ln) and not waited_note:
                    waited_note = " Main said something by itself (see above)."
            act = self.decide(waited_note)
            waited_note = ""
            a = act.get("action")
            if a == "done":
                self.verdict = act
                self.events.append({"t": el, "kind": "done", **act})
                log(f"[{self.id}] DONE satisfied={act.get('satisfied')}: {act.get('why')}")
                break
            if a == "wait":
                secs = max(20, min(int(act.get("seconds", 120)), 900))
                log(f"[{self.id}] waits {secs}s — {act.get('why', '')}")
                waited_note = self.wait(secs)
                self.events.append({"t": el, "kind": "wait", "asked": secs, "note": waited_note})
                continue
            if not (act.get("text") or "").strip():
                continue
            turns += 1
            try:
                self.turn(act)
            except Exception as e:  # noqa: BLE001
                log(f"[{self.id}] turn failed: {e}")
                traceback.print_exc()
                self.events.append({"t": el, "kind": "turn-error", "error": str(e)})
                # the rig (or the voice path) is broken, not the conversation: never grade that
                if "died" in str(e) or not any(ln.opened for ln in self.lines.values()) or \
                        sum(1 for x in self.events if x["kind"] == "turn-error") >= 3:
                    raise
        return self


# ── voice checks (on the turn log) ────────────────────────────────────────────
def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 3) if xs else None


def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return round(xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))], 2)


def utts_of(personas, kinds=("turn", "barge")):
    return [u for p in personas for t in p.turns for u in t["utterances"] if u["kind"] in kinds]


def main_spoken(personas):
    """every MAIN message the person could have heard: was it read aloud by the app? (a TTS call
    whose text opens like the message — the e2e suite's `spoken()` rule)"""
    out = []
    for p in personas:
        for name, ln in p.lines.items():
            if not (ln.opened and ln.brain):
                continue
            tts = [hsim_norm(x["text"]) for x in ln.since(0)["tts"] if x.get("status") in (200, None)]
            for m in ln.brain.visible(ln.main_id):
                if m["role"] != "assistant" or (m["created"] or 0) < p.started * 1000 - 5000:
                    continue
                head = " ".join(hsim_norm(m["text"]).split()[:4])
                out.append({"persona": p.id, "root": name, "auto": m["auto"], "text": m["text"][:200],
                            "spoken": bool(head) and any(head in t for t in tts)})
    return out


def hsim_norm(s):
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s or "")
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"(\*\*|__|`|#)", "", s.lower())).strip()


def voice_checks(sc, personas, acct=None):
    res = []
    acct = acct or []
    spoken = utts_of(personas)
    cmds = utts_of(personas, ("command",))

    def add(name, ok, detail):
        res.append({"name": name, "ok": bool(ok), "detail": detail})

    for c in sc.get("voice_checks", []) + [{"kind": "proactive_spoken", "advisory": True,
                                             "name": "MAIN's unprompted reports were read aloud (hands-free: the person can't see the screen)"}]:
        k, name = c["kind"], c.get("name", c["kind"])
        n0 = len(res)
        if k == "all_turns_landed":
            miss = [u["spoken"][:60] for u in spoken if not u.get("box_heard")]
            add(name, not miss, f"{len(spoken) - len(miss)}/{len(spoken)} landed" + (f"; lost: {miss}" if miss else ""))
        elif k == "every_reply_spoken":
            miss = [u["spoken"][:60] for u in spoken if u.get("main_reply") and not u.get("persona_heard")]
            add(name, not miss, f"{len([u for u in spoken if u.get('persona_heard')])} replies heard" + (f"; silent: {miss}" if miss else ""))
        elif k == "box_wer_max":
            m = mean([u.get("box_wer") for u in spoken])
            add(name, m is not None and m <= c["value"], f"mean box WER {m} (max {c['value']})")
        elif k == "reply_wer_max":
            m = mean([u.get("reply_wer_heard") for u in spoken])
            add(name, m is not None and m <= c["value"], f"mean reply WER (on what played) {m} (max {c['value']})")
        elif k == "first_audio_p50_max":
            p = pct([u.get("first_audio_s") for u in spoken], 0.5)
            add(name, p is not None and p <= c["value"], f"first reply audio p50 {p}s (max {c['value']}s)")
        elif k == "no_command_messages":
            bad = [x for p in personas for t in p.turns for x in t.get("commands_reached_main", [])]
            add(name, not bad, "clean" if not bad else f"commands sent to MAIN as messages: {bad}")
        elif k == "command_effect":
            want = {"pause": r"\|paused@", "resume": r"\|deck@", "stop": r"\|nodeck@|^listening", "faster": "rate+", "slower": "rate-"}
            hits = [u for u in cmds if re.search(c["command_regex"], u["spoken"], re.I)]
            if not hits:
                add(name, False, f"no command matching {c['command_regex']} was spoken")
                continue
            details, ok_all = [], True
            for u in hits:
                if u.get("skipped"):
                    ok_all = False
                    details.append(f"{u['spoken']!r}: not spoken — the reply was already over")
                    continue
                after = u.get("ui_after") or []
                rate0 = float((u.get("ui_before") or "@1").split("@")[-1] or 1)
                eff = c["effect"]
                if eff in ("rate+", "rate-"):
                    rates = [float(s.split("@")[-1] or 1) for s in after]
                    ok = any((r > rate0) if eff == "rate+" else (r < rate0) for r in rates)
                else:
                    ok = any(re.search(want.get(eff, eff), s) for s in after)
                ok_all &= ok
                details.append(f"{u['spoken']!r}: {u.get('ui_before')} → {after[-3:]} agent: {(u.get('agent_saw') or [])[:2]}")
            add(name, ok_all, " ; ".join(details)[:600])
        elif k == "barge_in":
            bs = utts_of(personas, ("barge",))
            if not bs:
                add(name, False, "no barge-in was spoken")
                continue
            ok = all(u.get("box_heard") and u.get("persona_heard") for u in bs)
            add(name, ok, "; ".join(f"{u['spoken'][:50]!r} → box heard {u.get('box_heard')!r}, answered: {(u.get('persona_heard') or '')[:80]!r}" for u in bs))
        elif k == "reply_cut":
            # the reply a stop / barge-in landed on stopped early: far fewer words played than were sent
            cut = []
            for p in personas:
                for t in p.turns:
                    us = t["utterances"]
                    for i, u in enumerate(us):
                        if u["kind"] in ("turn", "barge") and any(x["kind"] in ("command", "barge") and not x.get("skipped")
                                                                  and re.search(c.get("by", "stop|over"), x["spoken"], re.I) for x in us[i + 1:]):
                            cut.append(u)
            ok = bool(cut) and all(u.get("reply_words_total") and u.get("reply_words_covered") is not None
                                   and u["reply_words_covered"] < 0.8 * u["reply_words_total"] for u in cut)
            add(name, ok, "; ".join(f"played ~{u.get('reply_words_covered')}/{u.get('reply_words_total')} words ({u.get('reply_audio_s')}s)" for u in cut) or "no cut reply found")
        elif k == "no_echo_messages":
            # the phone hearing its own reply (speaker → mic) must never become a message to MAIN
            said = [x["text"] for p in personas for t in p.turns for x in t.get("tts", [])]
            bad = []
            for p in personas:
                for t in p.turns:
                    for u in t["utterances"]:
                        h = speech.norm_words(u.get("box_heard") or "")
                        mine = set(speech.norm_words(u.get("spoken") or ""))
                        foreign = [w for w in h if w not in mine]
                        for ref in said:
                            rw = set(speech.norm_words(ref))
                            if len(foreign) >= 4 and sum(w in rw for w in foreign) / len(foreign) >= 0.6:
                                bad.append(u.get("box_heard"))
                                break
            add(name, not bad, "clean" if not bad else f"echo in MAIN's input: {bad[:2]}")
        elif k == "heard_regex":
            heard = " ".join(u.get("persona_heard") or "" for p in personas for t in p.turns for u in t["utterances"])
            m = re.search(c["regex"], heard, re.I | re.S)
            add(name, m, m.group(0)[:120] if m else "never heard")
        elif k == "box_heard_regex":
            heard = " ".join(u.get("box_heard") or "" for u in spoken)
            m = re.search(c["regex"], heard, re.I | re.S)
            add(name, m, m.group(0)[:120] if m else "the box never heard it")
        elif k == "proactive_spoken":
            auto = [x for x in acct if x["auto"]]
            if not auto:
                continue
            silent = [x for x in auto if not x["spoken"]]
            add(name, not silent, f"{len(auto) - len(silent)}/{len(auto)} read aloud" +
                (f"; silent: {[x['text'][:90] for x in silent[:3]]}" if silent else ""))
        if c.get("advisory") and len(res) > n0:
            res[-1]["advisory"] = True
    return res


VOICE_JUDGE_SYSTEM = hsim.JUDGE_SYSTEM.replace(
    "Then decide pass:",
    """- voice: as a VOICE conversation — did the box hear the person correctly (compare what they said with what the box's STT heard), did main SPEAK well (short, conversational, spoken-style; no markdown, tables, code, paths or URLs read aloud; the gist first), did it recover from a misheard or garbled word (re-interpreting from context or asking briefly, not acting on nonsense), and did voice commands / barge-ins work as the person meant?
Then decide pass:""").replace(
    "every other criterion >= 3", "every other criterion (voice included) >= 3").replace(
    '"honesty":n}', '"honesty":n,"voice":n}').replace(
    "You get the scenario,", "This run was SPOKEN: the person talked hands-free and heard main's replies through the phone's speaker. You get the scenario, a per-turn voice table (what they said, what the box heard, what main answered, what they heard back, error rates, latencies),")


def voice_table(personas, t0):
    rows = []
    for p in personas:
        for t in p.turns:
            for u in t["utterances"]:
                lat = u.get("latency") or {}
                rows.append(f"[{p.id}→{t['root']} +{((u.get('t0') or t0 * 1000) / 1000 - t0) / 60:.1f}m] {u['kind'].upper()}"
                            + (f"\n  person meant: {u['intended']!r}" if u.get("intended") and u["intended"] != u["spoken"] else "")
                            + (f"\n  person said: {u['spoken']!r}" if u.get("spoken") else "")
                            + (f"\n  box heard: {u.get('box_heard')!r} (WER {u.get('box_wer')})" if u["kind"] in ("turn", "barge") else "")
                            + (f"\n  main replied (text): {(u.get('main_reply') or '')[:700]!r}" if u.get("main_reply") else "")
                            + (f"\n  person heard back: {(u.get('persona_heard') or '')[:700]!r} (WER on what played {u.get('reply_wer_heard')}, {u.get('reply_audio_s')}s of audio)" if u["kind"] != "command" else "")
                            + (f"\n  latency: first audio {lat.get('first_audio_s')}s after they stopped talking, reply ended at {lat.get('reply_end_s')}s; main took {lat.get('main_s')}s" if lat else "")
                            + (f"\n  deck after command: {u.get('ui_after', [])[-3:]}" if u["kind"] == "command" else ""))
            if t.get("incidents"):
                rows.append(f"  incidents: {t['incidents']}")
    return "\n".join(rows)


# ── report ────────────────────────────────────────────────────────────────────
def esc(s, n=None):
    s = (s or "").replace("|", "\\|").replace("\n", " ")
    return s[:n] + "…" if n and len(s) > n else s


def write_report(outdir, sc, report, personas, checks, judgement, tree_lines, convo, engines, target):
    with open(os.path.join(outdir, "report.md"), "w") as f:
        f.write(f"# {sc['title']} — {'PASS' if report['pass'] else 'FAIL'}\n\n")
        f.write(f"voice sim · run `{report['run']}` · target {target} · {report['minutes']} min · persona+judge ${report['persona_judge_cost_usd']}\n\n")
        sc_ = judgement.get("scores") or {}
        f.write("judge: " + " · ".join(f"{k} **{v}**" for k, v in sc_.items()) + f" — pass={judgement.get('pass')}\n\n")
        f.write(f"{judgement.get('summary', '')}\n\n> worst moment: {judgement.get('worst_moment', '')}\n\n")
        v = report["voice"]
        f.write("## Numbers\n\n| | |\n|---|---|\n")
        f.write(f"| spoken turns (incl. barge-ins) | {v['turns']} · commands {v['commands']} · unprompted reports {v['reports']} |\n")
        f.write(f"| box STT WER (said → box heard) | mean {v['box_wer_mean']} · max {v['box_wer_max']} |\n")
        f.write(f"| persona STT WER (spoken reply → heard) | mean {v['reply_wer_mean']} on what played (full-reply mean {v['reply_wer_full_mean']}) |\n")
        f.write(f"| end of speech → first reply audio | p50 {v['first_audio_p50']}s · p90 {v['first_audio_p90']}s · max {v['first_audio_max']}s |\n")
        f.write(f"| end of speech → end of reply | p50 {v['reply_end_p50']}s · max {v['reply_end_max']}s |\n")
        f.write(f"| breakdown p50 | STT+commit {v['stt_commit_p50']}s · MAIN {v['main_p50']}s · TTS to first sound {v['tts_first_p50']}s |\n")
        f.write(f"| MAIN's messages read aloud | {v['main_msgs_spoken']}/{v['main_msgs']} (unprompted reports left silent: {v['main_auto_silent']}) |\n")
        f.write(f"| engines | {', '.join(f'{k}: {x}' for k, x in engines.items())} |\n\n")
        f.write("## Personas\n\n")
        for p in personas:
            vv = p.voice
            f.write(f"- **{p.id}** on {', '.join(p.lines)} — voice {vv['voice']} ×{vv.get('speed', 1)}, noise {p.spec.get('phone', {}).get('noiseDb')} dBFS, "
                    f"echo {p.spec.get('phone', {}).get('echo', 0)} — verdict: {json.dumps(p.verdict) if p.verdict else 'none (budget spent)'}\n")
        f.write("\n## Turns\n\n| # | who→root | kind | person said | box heard (WER) | MAIN replied (text) | person heard (WER) | first audio / end | audio |\n|---|---|---|---|---|---|---|---|---|\n")
        for p in personas:
            for t in p.turns:
                for u in t["utterances"]:
                    links = " ".join(f"[{lbl}]({u[key]})" for lbl, key in (("said", "wav"), ("reply", "reply_wav")) if u.get(key))
                    if u is t["utterances"][0] and t.get("mic_wav"):
                        links += f" [mic]({t['mic_wav']})"
                    said = esc(u.get("spoken"), 160) + (f" *(meant: {esc(u['intended'], 80)})*" if u.get("intended") and u["intended"] != u.get("spoken") and u["kind"] == "turn" and sc.get("mishear") else "")
                    box = (esc(u.get("box_heard"), 160) if u["kind"] in ("turn", "barge") else "—") + (f" ({u['box_wer']})" if u.get("box_wer") is not None else "")
                    back = esc(u.get("persona_heard"), 220) + (f" ({u['reply_wer_heard']})" if u.get("reply_wer_heard") is not None else "")
                    if u["kind"] == "command":
                        saw = [x for x in (u.get("agent_saw") or []) if "voice command" in x or "dropped" in x]
                        box = "agent: " + esc(saw[0], 80) if saw else ("not spoken (reply over)" if u.get("skipped") else "agent: ?")
                        ui = [x.split("|", 1)[-1] for x in (u.get("ui_after") or [])]
                        back = f"deck {esc((u.get('ui_before') or '').split('|', 1)[-1])} → {esc(' → '.join(ui[:3]))}"
                    f.write(f"| {t['n']} | {p.id}→{t['root']} | {u['kind']} | {said} | {box} | {esc(u.get('main_reply'), 220)} | {back} | "
                            f"{u.get('first_audio_s', '—')}s / {u.get('reply_end_s', '—')}s | {links} |\n")
                if t.get("incidents"):
                    f.write(f"| | | incident | {esc('; '.join(t['incidents']))} | | | | | |\n")
        f.write("\n## Voice commands and barge-ins\n\n")
        any_cmd = False
        for p in personas:
            for t in p.turns:
                for u in t["utterances"]:
                    if u["kind"] in ("command", "barge"):
                        any_cmd = True
                        f.write(f"- {p.id} turn {t['n']} {u['kind']} {u['spoken']!r} planned at +{u.get('planned_at_s')}s, deck before `{u.get('ui_before')}` → after `{(u.get('ui_after') or [])[-4:]}` · agent: {u.get('agent_saw')}\n")
        if not any_cmd:
            f.write("(none in this scenario)\n")
        f.write("\n## Conversation as the persona heard it\n\n")
        for p in personas:
            if len(personas) > 1:
                f.write(f"### {p.id}\n\n")
            multi = len(set(x["root"] for x in p.heard)) > 1
            f.write("\n\n".join(f"[+{(h['t'] - report['t0']) / 60:.1f}m] {h['who']}{' (' + h['root'] + ')' if multi else ''}: {h['text']}"
                                  for h in sorted(p.heard, key=lambda h: h["t"])) + "\n\n")
        f.write("## Conversation as the box holds it (MAIN, text)\n\n" + convo + "\n\n")
        f.write("## Session tree\n\n```\n" + "\n".join(tree_lines) + "\n```\n\n## Checks\n\n")
        f.write("\n".join(f"- {'✅' if c['ok'] else ('⚠️' if c.get('advisory') else '❌')} {c['name']}{' (advisory)' if c.get('advisory') else ''}: {esc(c['detail'], 300)}" for c in checks) + "\n")


# ── the run ───────────────────────────────────────────────────────────────────
def load_scenario(path):
    sc = jload(path)
    if sc.get("port_of"):  # a text-sim scenario spoken: persona, goals, script, seeds, peers and checks come from hsim's
        base = jload(os.path.join(os.path.dirname(HERE), "scenarios", sc["port_of"] + ".json"))
        merged = {k: v for k, v in base.items() if k not in ("id", "title")}
        merged.update(sc)
        sc = merged
    if "personas" not in sc:
        sc["personas"] = [{"id": "owner", "persona": sc["persona"], "goals": sc["goals"], "script": sc.get("script", []),
                           "voice": sc.get("voice", {}), "phone": sc.get("phone", {})}]
    if "roots" not in sc:
        sc["roots"] = [{"name": sc.get("root_name", "home"), "note": sc.get("root_note", ""), "seed": sc.get("seed", {})}] + \
            [{"name": p["name"], "note": p.get("note", ""), "seed": p.get("seed", {})} for p in sc.get("peers", [])]
    return sc


def kv(arg):
    if not arg:
        return {}
    if "=" in arg.split("://")[0]:
        return dict(x.split("=", 1) for x in arg.split(","))
    return {"*": arg}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario")
    ap.add_argument("--target", help="app URL (or root=URL,…) — default: start an own stack")
    ap.add_argument("--brain", help="brain URL (or root=URL,…) for transcripts and checks")
    ap.add_argument("--port", type=int, default=4170)
    ap.add_argument("--name")
    ap.add_argument("--keep", action="store_true", help="leave the own stack running")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default=os.path.expanduser("~/Work/bifrost/artifacts/voice-sim"))
    ap.add_argument("--auth", choices=["tailnet", "devices"], default="tailnet", help="own stack: the app's auth mode")
    ap.add_argument("--pair", action="store_true", help="pair each phone first (devices mode: QR code → /pair)")
    ap.add_argument("--admin-token", default=os.environ.get("VSIM_ADMIN_TOKEN"), help="mints pairing codes when not on the box's loopback")
    a = ap.parse_args()
    sc = load_scenario(a.scenario)
    name = a.name or sc["id"]
    run_id = time.strftime("%Y%m%dT%H%M%S") + f"-{name}"
    outdir = os.path.join(a.out, run_id)
    os.makedirs(outdir, exist_ok=True)
    librarian = None
    stack = None
    phones = {}
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))  # a stop still tears the stack down
    try:
        if a.target:
            tg, br = kv(a.target), kv(a.brain)
            roots = [{"name": r["name"], "app": tg.get(r["name"]) or tg.get("*"), "brain": br.get(r["name"]) or br.get("*"),
                      "work": None, "sim": None} for r in sc["roots"]]
            target = a.target
        else:
            stackmod.down(name)
            stackmod.wipe(name, sc["roots"])
            brain_env = dict(sc.get("brain_env", {}))
            if "librarian" in sc.get("extensions", {}):
                lport = a.port + 1000
                rdir = os.path.expanduser(f"~/.cache/root-sim/{name}")
                os.makedirs(rdir, exist_ok=True)
                largs = ["python3", os.path.join(os.path.dirname(os.path.dirname(HERE)), "root", "extensions", "librarian", "librarian.py"),
                         "--root", f"http://127.0.0.1:{a.port}", "--port", str(lport), "--db", os.path.join(rdir, "librarian.db"),
                         "--artifacts", os.path.join(rdir, "work", "artifacts"), "--poll", "5"]
                seed = sc["extensions"]["librarian"].get("seed")
                if seed:
                    json.dump(seed, open(os.path.join(rdir, "librarian-seed.json"), "w"))
                    largs += ["--seed", os.path.join(rdir, "librarian-seed.json")]
                librarian = subprocess.Popen(largs, stdout=open(os.path.join(rdir, "librarian.log"), "a"), stderr=subprocess.STDOUT)
                brain_env["SIM_EXTENSIONS"] = f"librarian=http://127.0.0.1:{lport}"
            stack = stackmod.up(name, sc["roots"], a.port, brain_env, auth=a.auth)
            roots = stack["roots"]
            target = ", ".join(f"{r['name']}={r['app']}" for r in roots) + " (own stack, tailnet mode, LiveKit on loopback)"
            if librarian:
                b = hsim.Brain(roots[0]["brain"])
                for _ in range(30):
                    if all(x.get("up") for x in b.req("GET", "/extensions")):
                        break
                    time.sleep(1)
        for r in roots:
            if a.pair or a.auth == "devices":
                r["pair"], r["admin_token"] = True, a.admin_token
        engines = dict(speech.engines())
        if stack:
            engines.update({"box_stt": stack["speech"]["box_stt"], "box_tts": stack["speech"]["box_tts_en"] + " (app /api/tts/stream)"})
        # ported checks: hsim's root_sim names → this run's
        for c in sc.get("checks", []):
            if c.get("root_sim"):
                for r in roots[1:]:
                    if c["root_sim"].endswith("-" + r["name"]) and r.get("sim"):
                        c["root_sim"] = r["sim"]
        personas = []
        for sp in sc["personas"]:
            pcfg = {"noiseDb": None, "echo": 0, "captureRtc": bool(sc.get("capture_rtc")), **(sp.get("phone") or {})}
            phones[sp["id"]] = Phone(sp["id"], os.path.join(outdir, "audio"), pcfg, a.headed)
            personas.append(Persona(sp, sc, roots, phones[sp["id"]], outdir))
        t0 = time.time()
        threads = []
        errors = []

        def runner(p):
            try:
                p.run(sc.get("max_minutes", 30), sc.get("max_turns", 12))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{p.id}: {e}")
                traceback.print_exc()

        for p in personas:
            th = threading.Thread(target=runner, args=(p,), daemon=True)
            th.start()
            threads.append(th)
            time.sleep(2)
        for th in threads:
            th.join()
        if errors or not utts_of(personas):
            log(f"rig error: {errors or 'nothing was spoken'} — not graded")
            json.dump({"run": run_id, "rig_errors": errors, "personas": [{"id": p.id, "turns": p.turns, "events": p.events} for p in personas]},
                      open(os.path.join(outdir, "rig-error.json"), "w"), indent=1, default=str)
            sys.exit(3)
        # settle, then grade
        settle_until = time.time() + sc.get("settle_seconds", 120)
        for r in roots:
            if not r.get("brain"):
                continue
            b = hsim.Brain(r["brain"])
            while time.time() < settle_until and any(x.get("busy") for x in b.tree()):
                time.sleep(5)
        checks, tree_lines, convo_parts = [], [], []
        for r in roots:
            if not r.get("brain"):
                continue
            b = hsim.Brain(r["brain"])
            mid = b.main_id()
            tree = b.tree()
            visible = b.visible(mid)
            # "on": which root's MAIN / workspace a check reads (hsim's proxy_on uses "root" for the card)
            mine = [c for c in sc.get("checks", []) if c.get("on", roots[0]["name"]) == r["name"]]
            if r.get("work") or not any(c.get("kind", "cmd") == "cmd" for c in mine):
                rc = hsim.run_checks({"checks": mine}, r.get("work") or "/nonexistent", tree, mid, visible, b)
            else:
                rc = hsim.run_checks({"checks": [c for c in mine if c.get("kind", "cmd") != "cmd"]}, "/nonexistent", tree, mid, visible, b)
                rc += [{"name": c.get("name", "cmd"), "ok": False, "detail": "not run: no workspace for a remote target"} for c in mine if c.get("kind", "cmd") == "cmd"]
            for c in rc:
                c["name"] = (f"[{r['name']}] " if len(roots) > 1 else "") + c["name"]
            checks += rc
            for x in tree:
                cd = x.get("card") or {}
                tree_lines.append(f"{'  ' * x['depth']}- {x['title']} [{x['agent']}, {cd.get('status')}{', archived' if x.get('archived') else ''}"
                                  f"{', on ' + cd['root'] if cd.get('root') else ''}] {cd.get('headline') or ''}")
            tz = None
            lines = []
            for m in visible:
                tz = tz or m["created"]
                lines.append(f"[+{(m['created'] - tz) / 60000:.1f}m] {'you' if m['role'] == 'user' else 'main'}{' (voice)' if m['voice'] else ''}: {m['text']}")
            convo_parts.append((f"### {r['name']}\n\n" if len(roots) > 1 else "") + "\n\n".join(lines))
        spoken_acct = main_spoken(personas)
        checks += voice_checks(sc, personas, spoken_acct)
        for c in checks:
            log(f"CHECK {'ok ' if c['ok'] else ('WARN' if c.get('advisory') else 'BAD')} {c['name']}: {c['detail'][:180]}")
        spoken = utts_of(personas)
        reports = utts_of(personas, ("report",))
        lat = lambda k: [(u.get("latency") or {}).get(k) for u in spoken]  # noqa: E731
        v = {"turns": len(spoken), "commands": len(utts_of(personas, ("command",))), "reports": len(reports),
             "box_wer_mean": mean([u.get("box_wer") for u in spoken]), "box_wer_max": max([u.get("box_wer") or 0 for u in spoken] + [0]),
             "reply_wer_mean": mean([u.get("reply_wer_heard") for u in spoken + reports]),
             "reply_wer_full_mean": mean([u.get("reply_wer") for u in spoken + reports]),
             "first_audio_p50": pct(lat("first_audio_s"), .5), "first_audio_p90": pct(lat("first_audio_s"), .9),
             "first_audio_max": pct(lat("first_audio_s"), 1), "reply_end_p50": pct(lat("reply_end_s"), .5), "reply_end_max": pct(lat("reply_end_s"), 1),
             "stt_commit_p50": pct(lat("stt_commit_s"), .5), "main_p50": pct(lat("main_s"), .5), "tts_first_p50": pct(lat("tts_first_s"), .5),
             "main_msgs": len(spoken_acct), "main_msgs_spoken": sum(x["spoken"] for x in spoken_acct),
             "main_auto_silent": sum(1 for x in spoken_acct if x["auto"] and not x["spoken"])}
        convo = "\n\n".join(convo_parts)
        judge_in = (f"SCENARIO\n{json.dumps({'title': sc['title'], 'personas': [{k: p[k] for k in ('id', 'persona', 'goals', 'script') if k in p} for p in sc['personas']], 'mishear': sc.get('mishear')}, indent=1)}\n\n"
                    f"VOICE TURNS (what was said, heard, answered, heard back)\n{voice_table(personas, t0)}\n\n"
                    f"VOICE NUMBERS {json.dumps(v)}\n\n"
                    f"CONVERSATION (as the box holds it: MAIN's text)\n{convo}\n\nSESSION TREE\n" + "\n".join(tree_lines) +
                    "\n\nDETERMINISTIC CHECKS\n" + "\n".join(f"- {'PASS' if c['ok'] else ('ADVISORY (a known product gap, not a failed check)' if c.get('advisory') else 'FAIL')} {c['name']}: {c['detail'][:300]}" for c in checks) +
                    "\n\nTHE PEOPLE'S OWN VERDICTS: " + json.dumps({p.id: p.verdict for p in personas}))
        cost = sum(p.cost for p in personas)
        try:
            jt, jc = hsim.claude(VOICE_JUDGE_SYSTEM, judge_in, JUDGE_MODEL, timeout=400)
            cost += jc
            judgement = hsim.jobj(jt)
        except Exception as e:  # noqa: BLE001
            judgement = {"pass": False, "summary": f"judge failed: {e}", "scores": {}}
        checks_ok = all(c["ok"] or c.get("advisory") for c in checks)
        persona_ok = all(p.verdict and p.verdict.get("satisfied") for p in personas)
        passed = bool(judgement.get("pass")) and checks_ok and persona_ok
        report = {"run": run_id, "scenario": sc["id"], "pass": passed, "checks_ok": checks_ok, "persona_satisfied": persona_ok,
                  "judge": judgement, "voice": v, "minutes": round((time.time() - t0) / 60, 1), "t0": t0, "target": target,
                  "engines": engines, "persona_judge_cost_usd": round(cost, 3), "checks": checks,
                  "personas": [{"id": p.id, "voice": p.voice, "phone": p.spec.get("phone"), "verdict": p.verdict, "events": p.events,
                                "turns": p.turns} for p in personas], "rig_errors": errors}
        json.dump(report, open(os.path.join(outdir, "report.json"), "w"), indent=1, default=str)
        write_report(outdir, sc, report, personas, checks, judgement, tree_lines, convo, engines, target)
        log(f"RESULT {'PASS' if passed else 'FAIL'} — judge {judgement.get('scores')} pass={judgement.get('pass')} checks_ok={checks_ok} "
            f"persona={persona_ok} box WER {v['box_wer_mean']} reply WER {v['reply_wer_mean']} first audio p50 {v['first_audio_p50']}s → {outdir}/report.md")
        sys.exit(0 if passed else 1)
    finally:
        for ph in phones.values():
            ph.close()
        if librarian:
            librarian.terminate()
        if stack and not a.keep:
            stackmod.down(name, keep_state=True)  # workspaces stay for a post-mortem; the next run wipes them


if __name__ == "__main__":
    main()
