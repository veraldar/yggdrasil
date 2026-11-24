#!/usr/bin/env python3
"""site-films-split.py — the 11-24 first-open fix 1 transform (reproducible audit copy).

site-preview.html carried 4.26 MB of base64 MP4 inside the page: one tap moved 4.69 MB
before first paint (1.55 s on the phone's relay path, the tree's most-opened artifact).
The films now live as their own .mp4 artifacts beside the page; the page links them
(poster + <source>): 173 KB, films load on play only.

Run on the ORIGINAL page (embedded films); writes the split page to stdout and the eight
artifact files (film + poster each) next to the source file:

    python3 scripts/site-films-split.py path/to/site-preview.html > split.html
    mv split.html site-preview.html   # then serve it as the page
"""
import base64
import os
import re
import sys

FILMS = ['yggdrasil', 'talk', 'tree', 'file']


def split(src: str, out_dir: str) -> str:
    """Rewrite the page; write site-film-<name>.{mp4,-poster.jpg} into out_dir."""
    src_seen: list[str] = []

    def sub_src(m: re.Match) -> str:
        short = FILMS[len(src_seen)]
        src_seen.append(short)
        data = base64.b64decode(m.group(1))
        with open(os.path.join(out_dir, f'site-film-{short}.mp4'), 'wb') as f:
            f.write(data)
        return f'<source src="/api/artifact/site-film-{short}.mp4" type="video/mp4">'

    out, n = re.subn(
        r'<source src="data:video/mp4;base64,([A-Za-z0-9+/=]*)" type="video/mp4">',
        sub_src,
        src,
    )
    assert n == 4, f'expected 4 films, found {n}'

    post_seen: list[str] = []

    def sub_post(m: re.Match) -> str:
        short = FILMS[len(post_seen)]
        post_seen.append(short)
        data = base64.b64decode(m.group(1))
        with open(os.path.join(out_dir, f'site-film-{short}-poster.jpg'), 'wb') as f:
            f.write(data)
        return f'poster="/api/artifact/site-film-{short}-poster.jpg"'

    out, n = re.subn(r'poster="data:image/jpeg;base64,([A-Za-z0-9+/=]*)"', sub_post, out)
    assert n == 4, f'expected 4 posters, found {n}'
    return out


def main() -> None:
    page = sys.argv[1]
    out = split(open(page, encoding='utf-8').read(), os.path.dirname(os.path.abspath(page)))
    sys.stdout.write(out)


if __name__ == '__main__':
    main()
