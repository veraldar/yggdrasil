#!/usr/bin/env python3
"""say_piper.py ITEMS.json — the product's own voice: piper en_US-lessac through sherpa-onnx, the engine and
model install.sh puts on a home computer (bifrost-voice). ITEMS: [{"out": path.wav, "text": …}]. Run with the
voice server's venv (sound.py does). Model: PIPER_DIR (vits-piper-en_US-lessac-low)."""
import array, json, os, sys, wave
import sherpa_onnx
d = os.environ["PIPER_DIR"]
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
    vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=os.path.join(d, "en_US-lessac-low.onnx"), tokens=os.path.join(d, "tokens.txt"),
                                               data_dir=os.path.join(d, "espeak-ng-data")), num_threads=2)))
for it in json.load(open(sys.argv[1])):
    a = tts.generate(it["text"], sid=0, speed=it.get("speed", 1.0))
    pcm = array.array("h", (max(-32767, min(32767, int(x * 32767))) for x in a.samples))
    with wave.open(it["out"], "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate); w.writeframes(pcm.tobytes())
