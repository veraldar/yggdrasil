"""Voice commands while a reply plays (owner 11-13): what counts as stop / pause / faster / slower /
resume, and what never does. `uv run python test_voice_commands.py` or pytest."""

from agent import command_of, strip_commands, strip_echo

# (heard, the deck is speaking, command)
CASES = [
    ("Stop.", False, "stop"),
    ("Okay, stop.", True, "stop"),
    ("Faster please.", True, "faster"),
    ("please slow down now", True, "slower"),
    ("Okay, pause.", True, "pause"),
    ("Continue please.", False, "resume"),
    # a real phone: the reply's own echo, then the keyword, in one utterance
    ("and the keeper climbed to the lamp, stop.", True, "stop"),
    # …but not when nothing is playing: then it is part of a message
    ("and the keeper climbed to the lamp, stop.", False, None),
    # ordinary speech and sentence ends that are not commands
    ("Hmm, that is interesting.", True, None),
    ("so we had to wait.", True, None),
    ("then the band started to play", True, None),
    ("tell me a story over", True, None),
]


def test_command_of() -> None:
    for heard, speaking, want in CASES:
        assert command_of(heard, speaking) == want, (heard, speaking, command_of(heard, speaking))


def test_strip_commands() -> None:
    assert strip_commands("Okay, stop. Tell me about the lighthouse over.") == "Tell me about the lighthouse over."


REPLY = ("Python was created by Guido van Rossum at CWI in the Netherlands, and he started it in December 1989 as a "
         "hobby project over the Christmas break, looking for something to do while his office was closed. He named it "
         "not after the snake, but after the British comedy group Monty Python.")


def test_strip_echo() -> None:
    """voice-fixes 11-14: the reply's echo around a barge-in goes; the person's words, "over" and
    the commands stay; speech that shares a word or two with the reply is not echo."""
    barge = ("Python was created by Guido van Rossum at CWI in the Netherlands. Actually, forget that, what is 342 "
             "times 7? Over. Looking for something to do while his office was closed. He named it not after the snake")
    assert strip_echo(barge, REPLY) == "Actually, forget that, what is 342 times 7? Over."
    assert strip_echo("he named it not after the snake, stop", REPLY) == "stop"
    assert strip_echo(REPLY, REPLY) == ""
    assert strip_echo("tell me more about Monty Python, over", REPLY) == "tell me more about Monty Python, over"
    assert strip_echo("anything", "") == "anything"


if __name__ == "__main__":
    test_command_of()
    test_strip_commands()
    test_strip_echo()
    print(f"ok: {len(CASES)} cases")
