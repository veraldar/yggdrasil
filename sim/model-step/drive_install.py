"""Drive a command on a pty, typing the answers a person would type: when the output so
far ends with ': ' (a prompt), type the next answer from MSM_INPUTS. The transcript goes
to TRANSCRIPT (what the terminal showed — with the key, if the tty wrongly echoed it) and
'msm-done <rc>' is touched at the end, so the caller never depends on streaming stdout.
"""
import os, pty, re, select, sys, time

inputs = os.environ.get("MSM_INPUTS", "").split("\n")
out = open(os.environ["TRANSCRIPT"], "w", buffering=1)
argv = sys.argv[1:] or ["bash"]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
buf = ""
sent = 0
deadline = time.time() + 240
status = None

def reap():
    global status
    try:
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            status = st
            return True
    except ChildProcessError:
        status = 0
        return True
    return False

while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.4)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        s = chunk.decode("utf-8", "replace")
        buf += s
        out.write(s)
    elif reap():
        break
    if sent < len(inputs) and re.search(r":[ \t]\Z", buf):
        time.sleep(0.4)
        os.write(fd, (inputs[sent] + "\r").encode())
        sent += 1
        buf = ""
if status is None:
    if not reap():
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = -1
rc = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
out.write(f"\nDRIVE-EXIT={rc}\n")
out.close()
open(os.environ["DONEFILE"], "w").write(f"{rc}\n")
sys.exit(0)
