#!/usr/bin/env python3
"""sound.py VIDEO VO.json OUT — a voice track for a film.

  VIDEO    the silent film (mp4)             OUT   the name without ending: OUT.mp4 (aac) and OUT.webm (opus)
  VO.json  [{"t": seconds, "voice": "narrator" | "you" | "app", "text": "…"}, …]  in the order they are said
           narrator = Kokoro af_heart (the owner's English voice) · you = Kokoro am_michael (the person
           who asks) · app = piper lessac, the voice a home computer really answers with (install.sh's own)
The picture is not touched (mp4: copied; webm: encoded once from it). A line that would run into the next
one, or past the end, fails the run with the seconds it needs: the film's timing makes room, not the voice.
Lines are kept by their words (FILMS_TTS/cache): a film made again says them with the same sound.
Env: FILMS_TTS (default ~/.cache/p5-films/tts: venv/ with kokoro-onnx, the two Kokoro files, cache/),
     PIPER_VENV + PIPER_DIR (default: ~/.cache/trunk-rtc/voice, what sim/trunk-rtc/setup.sh made).
"""
import hashlib, json, os, pathlib, subprocess, sys, wave

HERE = pathlib.Path(__file__).resolve().parent
TTS = pathlib.Path(os.environ.get("FILMS_TTS", "~/.cache/p5-films/tts")).expanduser()
PIPER_VENV = pathlib.Path(os.environ.get("PIPER_VENV", "~/.cache/trunk-rtc/voice/venv")).expanduser()
PIPER_DIR = pathlib.Path(os.environ.get("PIPER_DIR", "~/.cache/trunk-rtc/voice/models/vits-piper-en_US-lessac-low")).expanduser()
VOICES = {"narrator": ("kokoro", "af_heart", 0.96), "you": ("kokoro", "am_michael", 1.0), "app": ("piper", "", 1.0)}
GAP = 0.12


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def dur_wav(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


def dur(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)]).stdout)


def speak(items):
    """→ a wav per item (cached by voice and words)"""
    cache = TTS / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    todo = {"kokoro": [], "piper": []}
    for it in items:
        engine, voice, speed = VOICES[it["voice"]]
        key = hashlib.sha256(f"{engine}|{voice}|{speed}|{it['text']}".encode()).hexdigest()[:20]
        raw, it["wav"] = cache / f"{key}.raw.wav", cache / f"{key}.wav"
        if not it["wav"].exists():
            todo[engine].append({"out": str(raw), "voice": voice, "text": it["text"], "speed": speed, "final": str(it["wav"])})
    for engine, lst in todo.items():
        if not lst:
            continue
        job = cache / f".job-{engine}.json"
        job.write_text(json.dumps(lst))
        if engine == "kokoro":
            run([str(TTS / "venv/bin/python"), str(HERE / "say_kokoro.py"), str(job)], env={**os.environ, "KOKORO_DIR": str(TTS)})
        else:
            run([str(PIPER_VENV / "bin/python"), str(HERE / "say_piper.py"), str(job)], env={**os.environ, "PIPER_DIR": str(PIPER_DIR)})
        for x in lst:  # one shape for all: 48 kHz mono, the silence at both ends cut
            run(["ffmpeg", "-v", "error", "-y", "-i", x["out"], "-af",
                 "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse,aresample=48000",
                 "-ac", "1", x["final"]])
            os.remove(x["out"])
    for it in items:
        it["dur"] = dur_wav(it["wav"])


def main():
    if sys.argv[1] == "--measure":       # sound.py --measure VO.json : how long each line is, nothing else
        items = json.load(open(sys.argv[2]))
        speak(items)
        for it in items:
            print(f"{it['dur']:5.2f} s  {it['voice']:<8} {it['text']}")
        return 0
    queue = "--queue" in sys.argv          # a line waits for the one before it instead of failing (the short clips)
    args = [a for a in sys.argv[1:] if a != "--queue"]
    video, items, out = pathlib.Path(args[0]), json.load(open(args[1])), args[2]
    speak(items)
    length = dur(video)
    if queue:
        for i in range(1, len(items)):
            items[i]["t"] = round(max(items[i]["t"], items[i - 1]["t"] + items[i - 1]["dur"] + GAP), 2)
    bad = []
    for i, it in enumerate(items):
        end = it["t"] + it["dur"]
        nxt = items[i + 1]["t"] if i + 1 < len(items) else length - 0.15
        if end + (GAP if i + 1 < len(items) else 0) > nxt:
            bad.append(f"{it['t']:6.2f} + {it['dur']:.2f} s runs {end + GAP - nxt:.2f} s into {'the next line' if i + 1 < len(items) else 'the end'}: “{it['text'][:50]}”")
    for it in items:
        print(f"  {it['t']:6.2f}–{it['t'] + it['dur']:6.2f}  {it['voice']:<8} {it['text']}")
    if bad:
        print("FAIL  the voice does not fit:\n      ↳ " + "\n      ↳ ".join(bad))
        return 1
    # the track: every line at its second; the app's voice a little lower (it comes from a phone)
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for it in items:
        cmd += ["-i", str(it["wav"])]
    parts = [f"[{i}:a]adelay={int(it['t'] * 1000)}:all=1,volume={'0.85' if it['voice'] == 'app' else '1.0'}[a{i}]" for i, it in enumerate(items)]
    mix = "".join(f"[a{i}]" for i in range(len(items))) + f"amix=inputs={len(items)}:normalize=0:dropout_transition=0,apad=whole_dur={length:.3f},loudnorm=I=-17:TP=-2.5:LRA=11,aresample=48000[a]"
    track = pathlib.Path(out + ".voice.wav")
    run(cmd + ["-filter_complex", ";".join(parts) + ";" + mix, "-map", "[a]", "-t", f"{length:.3f}", "-ac", "1", str(track)])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-i", str(track), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", "-ac", "1",
         "-movflags", "+faststart", "-shortest", out + ".mp4"])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-i", str(track), "-map", "0:v", "-map", "1:a", "-c:v", "libvpx-vp9", "-crf", "40" if length > 40 else "38",
         "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-c:a", "libopus", "-b:a", "40k", "-ac", "1", "-shortest", out + ".webm"])
    track.unlink()
    for ext in ("mp4", "webm"):
        a = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration", "-of", "csv=p=0", f"{out}.{ext}"]).stdout.split()
        print(f"PASS  {pathlib.Path(out).name}.{ext}: {os.path.getsize(f'{out}.{ext}') // 1024} kB · sound {' '.join(a)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
