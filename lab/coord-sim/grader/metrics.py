"""coord-sim metric library — deterministic, no LLM judge (harness-bench grader lineage).

LAW: same inputs -> same score, always. No network, no clock, no RNG.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SUITE = Path(__file__).resolve().parent


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


# ---- laziness signals -------------------------------------------------------

LAZY_PATTERNS = [
    (r"\b(rest of the (implementation|code|details) (omitted|left out|truncated))\b", "omitted-rest"),
    (r"\b(and so on|et cetera|\.{3,}\s*$)", "trails-off"),
    (r"\bI (can't|cannot|won't|will not) (finish|complete|do all)\b", "refuses-to-finish"),
    (r"\b(as an ai|as a language model)\b", "ai-disclaimer"),
    (r"\b\(continued|truncated|cut for brevity\)", "cut-for-brevity"),
    (r"\b(left as an exercise|implement yourself|you can add)\b", "delegated-to-user"),
]


def laziness_score(reply: str) -> tuple[float, list[str]]:
    """0.0 = no laziness signals, 1.0 = every pattern hit. Also returns hit names."""
    hits = []
    for pat, name in LAZY_PATTERNS:
        if re.search(pat, (reply or "").lower()):
            hits.append(name)
    # an extremely short non-answer to a task that asked for structure
    return round(len(hits) / len(LAZY_PATTERNS), 3), hits


# ---- drift signals ----------------------------------------------------------

DRIFT_MARKERS = [
    (r"UNKNOWN:\s*\S", "declared-unknown"),        # honest unknown (t5 protocol) — counted, not penalized twice
]


def drift_score(reply: str, expected: list[str]) -> tuple[float, list[str]]:
    """Fraction of `expected` facts ABSENT from the reply (the t5 drift probe's core)."""
    hay = _norm(reply)
    missing = [e for e in expected if _norm(e) not in hay]
    declared = [name for pat, name in DRIFT_MARKERS if re.search(pat, reply or "")]
    return round(len(missing) / max(1, len(expected)), 3), missing + declared


# ---- task grading (harness-bench grader methods) ----------------------------

def grade_contains(reply: str, spec: dict) -> tuple[float, str]:
    hay = _norm(reply)
    missing = [e for e in spec["expected"] if _norm(e) not in hay]
    if not missing:
        return 1.0, ""
    return round(1 - len(missing) / len(spec["expected"]), 3), f"missing {missing}"


def grade_word_cap(reply: str, spec: dict) -> tuple[float, str]:
    cap = spec["expected"]["max"]
    n = len((reply or "").split())
    if n <= cap:
        return 1.0, ""
    return 0.0, f"{n} words > cap {cap}"


def grade_code(reply: str, spec: dict, workdir: Path | None = None) -> tuple[float, str]:
    """Hidden pytest suite vs the delivered module.

    coord-sim shape: the worker had tools, so the module SHOULD be on disk in
    `workdir` (the arm's scratch task dir). Falls back to the reply's fenced
    python block if the file is missing (laziness signal in itself).
    """
    fname = spec["expected"]["filename"]
    src = None
    if workdir:
        cand = workdir / fname
        if cand.is_file():
            src = cand.read_text()
    if src is None:
        m = re.search(r"HARNESS-BENCH:FILE (\S+)", reply or "")
        if m and Path(m.group(1)).is_file():
            src = Path(m.group(1)).read_text()
    if src is None:
        blocks = re.findall(r"```(?:python|py)\s*\n(.*?)```", reply or "", re.S)
        if not blocks:
            return 0.0, "no file on disk and no code block (possible laziness)"
        src = max(blocks, key=len)
    with tempfile.TemporaryDirectory(prefix="cs-submit-") as td:
        sub = Path(td) / fname
        sub.write_text(src)
        tests_dir = SUITE / "tests" / spec["expected"]["tests_dir"].removeprefix("tests/")
        for f in tests_dir.iterdir():
            if f.suffix == ".py":
                (Path(td) / f.name).write_text(f.read_text())
        (Path(td) / "conftest.py").write_text((SUITE / "tests" / "conftest.py").read_text())
        py = os.environ.get("HB_PYTHON", sys.executable)
        cmd = [py, "-m", "pytest", "-q", "--tb=no", "-p", "no:cacheprovider",
               f"--submitted={sub.parent}", str(td)]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=td,
                               env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
        except subprocess.TimeoutExpired:
            return 0.0, "hidden tests timed out (60s)"
        if not r.stdout.strip():
            return 0.0, f"pytest produced no output: {r.stderr[:160]!r}"
        tail = r.stdout.strip().splitlines()[-1]
        nums = {w: int(n) for n, w in re.findall(r"(\d+) (passed|failed|error)", tail)}
        total = sum(nums.values())
        if total == 0:
            return 0.0, f"no tests ran: {tail[:120]!r}"
        return round(nums.get("passed", 0) / total, 3), tail[:120]


GRADERS = {"contains": grade_contains, "word_cap": grade_word_cap}


def grade_task(reply: str, spec: dict, workdir: Path | None = None) -> tuple[float, str]:
    if spec["method"] == "code":
        return grade_code(reply, spec, workdir)
    return GRADERS[spec["method"]](reply, spec)
