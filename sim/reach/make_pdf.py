#!/usr/bin/env python3
"""make_pdf.py — a real PDF of a given size whose text holds a marker word (stdlib only).

Page 1: a few lines of text in Helvetica, one of them "The marker word is <MARKER>." (text a PDF
reader extracts: pdftotext, Claude Code's Read). Page 2: one image of random pixels, uncompressed,
sized so the whole file is about --mb megabytes (random bytes: no transport can shrink it).

    make_pdf.py OUT.pdf [--mb 6] [--marker WORD]     prints {"path", "size", "marker", "sha256"}
"""
import argparse, hashlib, json, math, os, random, string


def build(marker, mb):
    lines = ["Quarterly notes from the lab", "", "Three things changed this quarter.",
             f"The marker word is {marker}.", "Everything else is filler on page two."]
    text = "BT /F1 16 Tf 72 720 Td 22 TL " + " ".join(f"({l}) Tj T*" for l in lines) + " ET"
    side = max(16, int(math.sqrt(mb * 1_000_000 / 3)))
    pixels = os.urandom(side * side * 3)
    page2 = "q 468 0 0 468 72 200 cm /Im1 Do Q"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(text) + text.encode() + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(page2) + page2.encode() + b"\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length %d >>\nstream\n"
        % (side, side, len(pixels)) + pixels + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--mb", type=float, default=6.0)
    ap.add_argument("--marker", default="")
    a = ap.parse_args()
    marker = a.marker or "".join(random.choice(string.ascii_uppercase) for _ in range(6)) + "-" + str(random.randint(1000, 9999))
    data = build(marker, a.mb)
    with open(a.out, "wb") as f:
        f.write(data)
    print(json.dumps({"path": os.path.abspath(a.out), "size": len(data), "marker": marker, "sha256": hashlib.sha256(data).hexdigest()}))


if __name__ == "__main__":
    main()
