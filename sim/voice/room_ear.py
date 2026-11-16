#!/usr/bin/env python3
"""room_ear.py — what the voice agent's room actually carries from the phone's microphone.

A HIDDEN participant (nobody in the room sees it: the agent's sibling check and the phone's
deck_state target stay as they are) joins a voice-sim stack's LiveKit room, subscribes to the
phone's mic track and writes it, continuously, to a wav — the audio exactly as LiveKit forwards
it to the agent, before any VAD. Compared with the phone's own mic recording (vsim's *-mic.wav),
a lost word is either already missing here (phone → LiveKit) or here and lost later (the agent).

    branch/voice/.venv/bin/python room_ear.py STACK_NAME ROOM OUT.wav [--secs 120]
"""
import argparse, asyncio, json, os, wave

from livekit import api, rtc


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stack")
    ap.add_argument("room")
    ap.add_argument("out")
    ap.add_argument("--secs", type=float, default=120)
    a = ap.parse_args()
    st = json.load(open(os.path.expanduser(f"~/.cache/voice-sim/{a.stack}/stack.json")))["livekit"]
    tok = (api.AccessToken(st["key"], st["secret"]).with_identity("vsim-ear").with_name("vsim-ear")
           .with_grants(api.VideoGrants(room_join=True, room=a.room, can_subscribe=True, can_publish=False, hidden=True)).to_jwt())
    room = rtc.Room()
    w = wave.open(a.out, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(48000)
    done = asyncio.Event()

    async def pump(track):
        stream = rtc.AudioStream(track, sample_rate=48000, num_channels=1)
        async for ev in stream:
            w.writeframes(bytes(ev.frame.data))
            if done.is_set():
                break

    @room.on("track_subscribed")
    def _sub(track, pub, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO and participant.identity.startswith("user_"):
            print(f"ear: recording {participant.identity}", flush=True)
            asyncio.ensure_future(pump(track))

    await room.connect(f"ws://127.0.0.1:{st['port']}", tok)
    try:
        await asyncio.wait_for(done.wait(), a.secs)
    except asyncio.TimeoutError:
        pass
    done.set()
    await room.disconnect()
    w.close()


if __name__ == "__main__":
    asyncio.run(main())
