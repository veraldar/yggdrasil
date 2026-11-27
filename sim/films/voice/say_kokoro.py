#!/usr/bin/env python3
"""say_kokoro.py ITEMS.json — Kokoro (the owner's English voice, af_heart) for the films' narrator and the
person who asks. ITEMS: [{"out": path.wav, "voice": "af_heart", "text": …, "speed": 1.0}]. Run with the
venv that has kokoro-onnx (sound.py does). Models: KOKORO_DIR (kokoro-v1.0.onnx, voices-v1.0.bin)."""
import json, os, sys
import soundfile
from kokoro_onnx import Kokoro
d = os.environ["KOKORO_DIR"]
k = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
for it in json.load(open(sys.argv[1])):
    samples, sr = k.create(it["text"], voice=it["voice"], speed=it.get("speed", 1.0), lang="en-us")
    soundfile.write(it["out"], samples, sr)
