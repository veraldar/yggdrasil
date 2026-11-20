"""Drive a command on a pty, typing the answers a person would type: when the output so
far ends with ': ' (a prompt: no newline after the colon), type the next answer from
MSM_INPUTS. Transcript (what the terminal showed) on stdout, DRIVE-EXIT=<rc> at the end."""
import os, pty, select, sys, time

inputs = os.environ.get("MSM_INPUTS", "").split("\n")
argv = ["bash"] + sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
buf = ""
sent = 0
deadline = time.time() + 900
status = None

def done():
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
        buf += chunk.decode("utf-8", "replace")
    elif done():
        break
    if sent < len(inputs) and buf.endswith(": "):
        time.sleep(0.25)
        os.write(fd, (inputs[sent] + "\r").encode())
        sent += 1
        buf = buf[:-2] + "\x00\r"  # don't re-trigger on the same prompt
if status is None:
    try:
        for _ in range(200):          # drain until the child exits
            if done():
                break
            r, _, _ = select.select([fd], [], [], 0.4)
            if r:
                try:
                    buf += os.read(fd, 4096).decode("utf-8", "replace")
                except OSError:
                    break
        if status is None:
            _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
sys.stdout.write(buf)
rc = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
print(f"\nDRIVE-EXIT={rc if isinstance(rc, int) else -1}")
sys.exit(0)
