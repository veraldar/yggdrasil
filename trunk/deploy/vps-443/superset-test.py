#!/usr/bin/env python3
"""superset-test.py — the new VPS :443 config does everything today's dispatcher does (and the ICE route).

It renders sni-443.conf with make-conf.sh, then puts a SHIM named turn-dispatcher.py in a temp dir: the
interface today's dispatcher has (handle(), sni_of(), the CADDY / COTURN / AP backends a test rebinds),
served by trunk/deploy/sni-443.py with exactly that config — the shim only swaps each backend's ADDRESS for
the test's fake, by role (default = caddy, stun = coturn, the proxied route = the ap, ice = the forward),
and refuses a config with any other shape. Then it runs a dispatcher test against the shim:

    superset-test.py                                   the cases of today's test (dispatch-cases.py), names
                                                       ap.example.org / example.org, + the ICE cases
    superset-test.py --old PATH/dispatch_test.py --name AP_NAME [--vps-ip IP]
                                                       YOUR copy of today's test, unmodified (it hardcodes
                                                       its names: pass the ap's name with --name)
exit 0 = GREEN. Needs python3 + openssl.
"""
import argparse, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SNI = os.path.join(HERE, "..", "sni-443.py")
SHIM = '''"""turn-dispatcher.py SHIM (superset-test.py): today's dispatcher interface, served by sni-443.py"""
import importlib.util
_s = importlib.util.spec_from_file_location("sni443", {sni!r})
sni = importlib.util.module_from_spec(_s)
_s.loader.exec_module(sni)
_cfg = sni.load({conf!r})
_proxied = [r for r in _cfg["routes"] if r[2]]
assert len(_proxied) == 1 and len(_cfg["routes"]) == 1 and _cfg["stun"] and _cfg["ice"], "not the VPS's config shape"
MAGIC = sni.MAGIC
AP_NAMES = {{_proxied[0][0]}}
CADDY, COTURN, AP, ICE = _cfg["default"], _cfg["stun"], _proxied[0][1], _cfg["ice"]
sni_of = sni.sni_of

def handle(client):
    cfg = dict(_cfg, default=CADDY, stun=COTURN, ice=ICE, routes=[(n, AP, p) for (n, _, p) in _cfg["routes"]])
    return sni.handle(cfg, client)
'''


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--old", help="today's dispatch_test.py (run unmodified)")
    a.add_argument("--name", default="ap.example.org", help="the trunk's TLS name")
    a.add_argument("--site", default="", help="the website's name (default: --name without its first label)")
    a.add_argument("--vps-ip", default="198.51.100.7", help="coturn's address in the config (rebound in the test)")
    o = a.parse_args()
    site = o.site or o.name.split(".", 1)[1]
    t = tempfile.mkdtemp(prefix="vps-443-superset.")
    try:
        conf = os.path.join(t, "sni-443.conf")
        with open(conf, "w") as f:
            f.write(subprocess.run([os.path.join(HERE, "make-conf.sh"), o.name, o.vps_ip], check=True,
                                   capture_output=True, text=True).stdout)
        print("config (make-conf.sh):", *[l for l in open(conf).read().splitlines() if l and not l.startswith("#")],
              sep="\n  ")
        with open(os.path.join(t, "turn-dispatcher.py"), "w") as f:
            f.write(SHIM.format(sni=os.path.abspath(SNI), conf=conf))
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                        "-keyout", os.path.join(t, "dt.key"), "-out", os.path.join(t, "dt.crt"), "-days", "1",
                        "-subj", f"/CN={o.name}", "-addext", f"subjectAltName=DNS:{o.name},DNS:{site}"],
                       check=True, capture_output=True)
        test = os.path.join(t, "dispatch_test.py")
        shutil.copy(o.old or os.path.join(HERE, "dispatch-cases.py"), test)
        print(f"running {'today' + chr(39) + 's test, unmodified: ' + o.old if o.old else 'dispatch-cases.py'} against sni-443.py\n")
        r = subprocess.run([sys.executable, test], env={**os.environ, "AP_NAME": o.name, "SITE_NAME": site}, timeout=120)
        return r.returncode
    finally:
        shutil.rmtree(t, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
