"""vt — a small terminal emulator: enough of xterm to read what Claude Code's TUI shows.

`Screen(cols, rows).feed(bytes)` keeps a grid of characters; `lines()` is the visible text. It
handles what Ink (Claude Code's renderer) emits: printable text (wide characters take two cells),
CR/LF/BS/TAB, cursor moves (CSI A B C D E F G H f d), erase (J K X), insert/delete lines and
characters (L M @ P), scroll regions (r) with scrolling (S T, index/reverse index), save/restore
cursor, the alternate screen (?1049/?47/?1047) and OSC/DCS strings (skipped). Colours and other
modes are ignored: the helper only needs the text (permission prompts, the input box, the session
name in its border). Standard library only.
"""
import unicodedata


def _width(ch):
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Screen:
    def __init__(self, cols=100, rows=40):
        self.cols, self.rows = cols, rows
        self._dec = None  # incremental utf-8 tail
        self.reset()

    def reset(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.alt = None  # the main grid while the alternate screen shows
        self.x = self.y = 0
        self.top, self.bot = 0, self.rows - 1
        self.saved = (0, 0)
        self.state = "text"
        self.seq = ""
        self.pending_wrap = False

    def resize(self, cols, rows):
        g = [[" "] * cols for _ in range(rows)]
        for y in range(min(rows, self.rows)):
            for x in range(min(cols, self.cols)):
                g[y][x] = self.grid[y][x]
        self.grid, self.cols, self.rows = g, cols, rows
        self.top, self.bot = 0, rows - 1
        self.x, self.y = min(self.x, cols - 1), min(self.y, rows - 1)

    # ---- text out -------------------------------------------------------------------------
    def lines(self):
        return ["".join(c for c in row if c is not None).rstrip() for row in self.grid]

    def text(self):
        return "\n".join(self.lines()).rstrip("\n")

    # ---- feeding --------------------------------------------------------------------------
    def feed(self, data):
        if isinstance(data, (bytes, bytearray)):
            import codecs

            if self._dec is None:
                self._dec = codecs.getincrementaldecoder("utf-8")("replace")
            data = self._dec.decode(bytes(data))
        for ch in data:
            self._ch(ch)

    def _ch(self, ch):
        st = self.state
        if st == "text":
            o = ord(ch)
            if ch == "\x1b":
                self.state, self.seq = "esc", ""
            elif o < 0x20 or o == 0x7F:
                self._ctrl(ch)
            else:
                self._put(ch)
        elif st == "esc":
            if ch == "[":
                self.state, self.seq = "csi", ""
            elif ch == "]":
                self.state, self.seq = "osc", ""
            elif ch in "PX^_":
                self.state = "str"
            elif ch in "()*+#%":
                self.state = "esc1"  # charset / line attrs: one more byte
            else:
                self.state = "text"
                if ch == "7":
                    self.saved = (self.x, self.y)
                elif ch == "8":
                    self.x, self.y = self.saved
                elif ch == "D":
                    self._index()
                elif ch == "E":
                    self.x = 0
                    self._index()
                elif ch == "M":
                    self._rindex()
                elif ch == "c":
                    self.reset()
        elif st == "esc1":
            self.state = "text"
        elif st == "csi":
            if "\x40" <= ch <= "\x7e":
                self.state = "text"
                self._csi(self.seq, ch)
            elif ch == "\x1b":
                self.state = "esc"
            else:
                self.seq += ch
                if len(self.seq) > 64:
                    self.state = "text"
        elif st in ("osc", "str"):
            if ch == "\x07":
                self.state = "text"
            elif ch == "\x1b":
                self.state = "stresc"
        elif st == "stresc":
            self.state = "text" if ch == "\\" else "osc"

    def _ctrl(self, ch):
        if ch == "\r":
            self.x, self.pending_wrap = 0, False
        elif ch in "\n\x0b\x0c":
            self.pending_wrap = False
            self._index()
        elif ch == "\b":
            self.x, self.pending_wrap = max(0, self.x - 1), False
        elif ch == "\t":
            self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)

    def _put(self, ch):
        w = _width(ch)
        if w == 0:
            return
        if self.pending_wrap:
            self.x, self.pending_wrap = 0, False
            self._index()
        if self.x + w > self.cols:
            self.x = 0
            self._index()
        row = self.grid[self.y]
        row[self.x] = ch
        if w == 2 and self.x + 1 < self.cols:
            row[self.x + 1] = None  # the right half of a wide character
        self.x += w
        if self.x >= self.cols:
            self.x, self.pending_wrap = self.cols - 1, True

    def _index(self):
        if self.y == self.bot:
            self._scroll_up(1)
        elif self.y < self.rows - 1:
            self.y += 1

    def _rindex(self):
        if self.y == self.top:
            self._scroll_down(1)
        elif self.y > 0:
            self.y -= 1

    def _blank(self):
        return [" "] * self.cols

    def _scroll_up(self, n):
        for _ in range(n):
            del self.grid[self.top]
            self.grid.insert(self.bot, self._blank())

    def _scroll_down(self, n):
        for _ in range(n):
            del self.grid[self.bot]
            self.grid.insert(self.top, self._blank())

    def _csi(self, seq, final):
        priv = seq[:1] if seq[:1] in "?>=<" else ""
        body = seq[len(priv):].rstrip(" !\"'$")
        try:
            ps = [int(p) if p else 0 for p in body.split(";")] if body else []
        except ValueError:
            ps = []
        p1 = ps[0] if ps else 0
        n = max(1, p1)
        self.pending_wrap = False
        if priv == "?":
            if final in "hl" and set(ps) & {1049, 47, 1047}:
                self._alt(final == "h")
            return
        if priv:
            return
        if final == "A":
            self.y = max(self.top if self.y >= self.top else 0, self.y - n)
        elif final == "B":
            self.y = min(self.bot if self.y <= self.bot else self.rows - 1, self.y + n)
        elif final == "C":
            self.x = min(self.cols - 1, self.x + n)
        elif final == "D":
            self.x = max(0, self.x - n)
        elif final == "E":
            self.x, self.y = 0, min(self.rows - 1, self.y + n)
        elif final == "F":
            self.x, self.y = 0, max(0, self.y - n)
        elif final == "G" or final == "`":
            self.x = min(self.cols - 1, n - 1)
        elif final == "d":
            self.y = min(self.rows - 1, n - 1)
        elif final in "Hf":
            r = ps[0] if len(ps) > 0 and ps[0] else 1
            c = ps[1] if len(ps) > 1 and ps[1] else 1
            self.y, self.x = min(self.rows - 1, r - 1), min(self.cols - 1, c - 1)
        elif final == "J":
            if p1 == 0:
                self._erase_line(self.x, self.cols, self.y)
                for y in range(self.y + 1, self.rows):
                    self.grid[y] = self._blank()
            elif p1 == 1:
                for y in range(0, self.y):
                    self.grid[y] = self._blank()
                self._erase_line(0, self.x + 1, self.y)
            else:
                for y in range(self.rows):
                    self.grid[y] = self._blank()
        elif final == "K":
            if p1 == 0:
                self._erase_line(self.x, self.cols, self.y)
            elif p1 == 1:
                self._erase_line(0, self.x + 1, self.y)
            else:
                self.grid[self.y] = self._blank()
        elif final == "X":
            self._erase_line(self.x, min(self.cols, self.x + n), self.y)
        elif final == "@":
            row = self.grid[self.y]
            row[self.x:self.x] = [" "] * n
            del row[self.cols:]
        elif final == "P":
            row = self.grid[self.y]
            del row[self.x:self.x + n]
            row.extend([" "] * (self.cols - len(row)))
        elif final == "L" and self.top <= self.y <= self.bot:
            for _ in range(n):
                del self.grid[self.bot]
                self.grid.insert(self.y, self._blank())
        elif final == "M" and self.top <= self.y <= self.bot:
            for _ in range(n):
                del self.grid[self.y]
                self.grid.insert(self.bot, self._blank())
        elif final == "S":
            self._scroll_up(n)
        elif final == "T":
            self._scroll_down(n)
        elif final == "r":
            t = (ps[0] if len(ps) > 0 and ps[0] else 1) - 1
            b = (ps[1] if len(ps) > 1 and ps[1] else self.rows) - 1
            if 0 <= t < b < self.rows:
                self.top, self.bot = t, b
                self.x = self.y = 0
        elif final == "s":
            self.saved = (self.x, self.y)
        elif final == "u":
            self.x, self.y = self.saved

    def _erase_line(self, a, b, y):
        row = self.grid[y]
        for x in range(max(0, a), min(self.cols, b)):
            row[x] = " "

    def _alt(self, on):
        if on and self.alt is None:
            self.alt = self.grid
            self.grid = [self._blank() for _ in range(self.rows)]
        elif not on and self.alt is not None:
            self.grid, self.alt = self.alt, None
