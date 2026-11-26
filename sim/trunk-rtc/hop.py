#!/usr/bin/env python3
"""hop.py LISTEN TARGET — a byte relay for the test harness, across network namespaces.

Each of LISTEN and TARGET is `host:port` or `unix:/path`. A unix socket lives in the filesystem,
not in a network namespace, so two hops — one inside a machine's namespace (unix → its loopback
service), one inside the harness's (loopback port → unix) — let the harness read a service on
another machine's loopback WITHOUT opening that machine's firewall (sim/trunk-rtc-v1-e2e.sh: the
harness at home reads lab's brain). Test instrument only; no product traffic takes this path.
"""
import asyncio
import os
import sys


def addr(a):
    if a.startswith("unix:"):
        return ("unix", a[5:])
    h, p = a.rsplit(":", 1)
    return ("tcp", (h, int(p)))


async def pipe(r, w):
    try:
        while True:
            b = await r.read(65536)
            if not b:
                break
            w.write(b)
            await w.drain()
    except OSError:
        pass
    finally:
        try:
            w.close()
        except (OSError, RuntimeError):
            pass


async def main(listen, target):
    lk, la = addr(listen)
    tk, ta = addr(target)

    async def one(r, w):
        try:
            ur, uw = await (asyncio.open_unix_connection(ta) if tk == "unix" else asyncio.open_connection(*ta))
        except OSError:
            w.close()
            return
        await asyncio.gather(pipe(r, uw), pipe(ur, w))

    if lk == "unix":
        if os.path.exists(la):
            os.unlink(la)
        srv = await asyncio.start_unix_server(one, la)
    else:
        srv = await asyncio.start_server(one, *la)
    print(f"hop: {listen} → {target}", flush=True)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__.splitlines()[0], file=sys.stderr)
        sys.exit(64)
    asyncio.run(main(sys.argv[1], sys.argv[2]))
