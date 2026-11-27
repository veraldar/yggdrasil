#!/usr/bin/env python3
"""hear.py FILE… — what a film's sound track says, by speech-to-text (the rig's whisper-tiny): the check a
person makes by listening, for a machine that cannot. Prints the words per file, and how loud the track is.
Run with the voice server's venv python (it has sherpa-onnx): ~/.cache/trunk-rtc/voice/venv/bin/python."""
import array, os, subprocess, sys, tempfile, wave
import sherpa_onnx
D = os.path.expanduser(os.environ.get("WHISPER_DIR", "~/.cache/trunk-rtc/voice/models/sherpa-onnx-whisper-tiny.en"))
rec = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=f"{D}/tiny.en-encoder.int8.onnx", decoder=f"{D}/tiny.en-decoder.int8.onnx", tokens=f"{D}/tiny.en-tokens.txt", num_threads=2)
for f in sys.argv[1:]:
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vn", "-ac", "1", "-ar", "16000", tmp.name], check=True)
        with wave.open(tmp.name) as w:
            pcm = array.array("h", w.readframes(w.getnframes()))
    x = [s / 32768 for s in pcm]
    out = []
    step = 16000 * 12      # whisper-tiny loses the thread on long clips: 12 s at a time
    for o in range(0, len(x), step):
        s = rec.create_stream(); s.accept_waveform(16000, x[o:o + step]); rec.decode_stream(s); out.append(s.result.text.strip())
    vol = subprocess.run(["ffmpeg", "-v", "info", "-i", f, "-vn", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
    mean = next((l.split("mean_volume:")[1].strip() for l in vol.splitlines() if "mean_volume" in l), "?")
    peak = next((l.split("max_volume:")[1].strip() for l in vol.splitlines() if "max_volume" in l), "?")
    print(f"{os.path.basename(f)}  (mean {mean}, peak {peak})\n   " + " ".join(out))
