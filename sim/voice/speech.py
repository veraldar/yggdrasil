"""speech.py — the persona's own mouth and ears, plus the measures (WER, loudness).

Mouth: text → speech on an OpenAI-compatible /audio/speech (default: this box's speaches,
Kokoro-82M ONNX on CPU — never the Mac the box itself speaks and listens with, so the persona
side neither queues behind nor resets the box's own speech, and its ears are a different
recognizer than the box's). Voice and speed per persona; a long dictation is built sentence by
sentence with real pauses between them.
Ears: speech → text on /audio/transcriptions (default: faster-whisper-small on the same server).

Env: VSIM_PERSONA_SPEECH_URL (default http://127.0.0.1:8000/v1), VSIM_PERSONA_TTS_MODEL,
VSIM_PERSONA_STT_MODEL.
"""
import io, json, math, os, re, struct, urllib.request, uuid, wave
from array import array

URL = os.environ.get("VSIM_PERSONA_SPEECH_URL", "http://127.0.0.1:8000/v1").rstrip("/")
TTS_MODEL = os.environ.get("VSIM_PERSONA_TTS_MODEL", "speaches-ai/Kokoro-82M-v1.0-ONNX")
STT_MODEL = os.environ.get("VSIM_PERSONA_STT_MODEL", "Systran/faster-whisper-small")


def engines():
    return {"persona_tts": f"{TTS_MODEL} @ {URL}", "persona_stt": f"{STT_MODEL} @ {URL}"}


# ── wav helpers (pure python: int16 mono) ────────────────────────────────────
def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, "int16 only"
        rate, ch = w.getframerate(), w.getnchannels()
        a = array("h", w.readframes(w.getnframes()))
    if ch > 1:
        a = array("h", a[::ch])
    return rate, a


def write_wav(path, rate, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())


def duration(path):
    rate, a = read_wav(path)
    return len(a) / rate


def loud_spans(path, db=-42, win_ms=40, gap_ms=350):
    """[(start_s, end_s)] where the RMS over win_ms sits above `db` dBFS"""
    rate, a = read_wav(path)
    thr = 32767 * 10 ** (db / 20)
    n = max(1, int(rate * win_ms / 1000))
    spans = []
    for i in range(0, len(a), n):
        seg = a[i:i + n]
        if not seg:
            break
        rms = math.sqrt(sum(x * x for x in seg) / len(seg))
        if rms >= thr:
            t0, t1 = i / rate, (i + len(seg)) / rate
            if spans and t0 - spans[-1][1] < gap_ms / 1000:
                spans[-1][1] = t1
            else:
                spans.append([t0, t1])
    return [tuple(s) for s in spans]


def trim(path, out, start_s, end_s=None):
    rate, a = read_wav(path)
    a = a[int(start_s * rate):int(end_s * rate) if end_s else len(a)]
    write_wav(out, rate, a)
    return out


# ── mouth ────────────────────────────────────────────────────────────────────
def _post_json(url, body, timeout=180):
    r = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.read()


def tts(text, out, voice="af_heart", speed=1.0):
    raw = _post_json(f"{URL}/audio/speech", {"model": TTS_MODEL, "voice": voice, "input": text,
                                             "response_format": "wav", "speed": speed})
    open(out, "wb").write(raw)
    return out


def speak(text, out, voice="af_heart", speed=1.0, pause_s=0.0, lead_s=0.3, tail_s=0.4):
    """the whole utterance as one wav. pause_s > 0: one TTS call per sentence (or per '…' / '--'
    break) with that much silence between them — a person thinking while they dictate."""
    tmp = out + ".part.wav"
    pieces = [text] if pause_s <= 0 else [p for p in re.split(r"(?<=[.!?…])\s+|\s+--\s+", text) if p.strip()]
    rate, acc = None, array("h")
    for i, p in enumerate(pieces):
        tts(p, tmp, voice, speed)
        r, a = read_wav(tmp)
        if rate is None:
            rate = r
            acc.extend(array("h", [0]) * int(lead_s * rate))
        elif i:
            acc.extend(array("h", [0]) * int(pause_s * rate))
        acc.extend(a)
    acc.extend(array("h", [0]) * int(tail_s * rate))
    write_wav(out, rate, acc)
    os.remove(tmp)
    return out


# ── ears ─────────────────────────────────────────────────────────────────────
def stt(path, language="en", prompt=None):
    b = uuid.uuid4().hex
    fields = {"model": STT_MODEL, "language": language, "response_format": "json"}
    if prompt:
        fields["prompt"] = prompt
    body = io.BytesIO()
    for k, v in fields.items():
        body.write(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    body.write(f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
    body.write(open(path, "rb").read())
    body.write(f"\r\n--{b}--\r\n".encode())
    r = urllib.request.Request(f"{URL}/audio/transcriptions", data=body.getvalue(),
                               headers={"content-type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(r, timeout=600) as resp:
        return json.loads(resp.read()).get("text", "").strip()


# ── measures ─────────────────────────────────────────────────────────────────
_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def num_words(n):
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + num_words(n % 100))
    for div, name in ((10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand")):
        if n >= div:
            return num_words(n // div) + " " + name + ("" if n % div == 0 else " " + num_words(n % div))
    return str(n)


def norm_words(s):
    s = s.lower()
    s = re.sub(r"\[ctx:[^\]]*\]", " ", s)
    s = re.sub(r"(\d),(\d{3})", r"\1\2", s)
    s = re.sub(r"(\d+)\.(\d+)", lambda m: f"{m.group(1)} point {' '.join(m.group(2))}", s)
    s = re.sub(r"\d+", lambda m: " " + num_words(int(m.group(0))) + " " if len(m.group(0)) < 10 else m.group(0), s)
    s = s.replace("&", " and ").replace("%", " percent ").replace("'", "")
    s = re.sub(r"[^a-z0-9À-ɏ]+", " ", s)
    return s.split()


def _edits(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
            prev = cur
    return d[len(hyp)]


def wer(ref, hyp):
    r, h = norm_words(ref), norm_words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    return round(_edits(r, h) / len(r), 3)


def wer_prefix(ref, hyp):
    """WER of what was heard against the best-matching START of the reference: a reply stopped,
    paused or barged into mid-way is scored on what actually played. (wer, words covered)"""
    r, h = norm_words(ref), norm_words(hyp)
    if not r or not h:
        return (wer(ref, hyp), 0)
    best = (1e9, 0)
    lo, hi = max(1, int(len(h) * 0.6)), min(len(r), int(len(h) * 1.5) + 3)
    if lo > hi:  # far more was heard than the reference holds: score it whole
        return (wer(ref, hyp), len(r))
    for k in range(lo, hi + 1):
        e = _edits(r[:k], h) / k
        if e < best[0]:
            best = (e, k)
    return (round(best[0], 3), best[1])
