/**
 * HIDE-STATION-R1/R2 (ported from bifrost voice-delivery-r2): station machinery
 * lines are coordinator-ear-only. ASYNC-DONE / AUTO-VERDICT / SWAP-DONE /
 * SEND-LOST / FAILED-STUB notices ride user turns into the session store
 * (coordinator needs them), but must not render in the owner transcript.
 * Strip is LINE-based: every line that starts with a machinery token
 * (optionally markdown-quoted) is dropped wherever it sits; prose that merely
 * mentions the words survives. Runner progress narration (assistant turns that
 * are pure lane acks, "→ …: on its way") is hidden too — the "Done" follow-up
 * is the real answer. Filter at the render layer only; raw session JSON keeps
 * the full text.
 */
export const STATION_LINE_RE =
  /^\s*>?\s*(?:(?:ASYNC-DONE|AUTO-VERDICT REQUEST|SWAP-DONE|SEND-LOST(-ESCALATED)?|FAILED-STUB notice|LANE LANDED|LANE-WILL|STATION PING|ESCALATION)\b|\[auto-verdict\](?=\s|$))/;

const NARRATION_ACK_RE = /^→\s/;

export function stripStationLine(text: string): string {
  const lines = text.split('\n').filter((l) => !STATION_LINE_RE.test(l));
  return lines.length ? lines.join('\n').trim() : '';
}

/** Assistant messages that are pure lane-progress narration never render. */
export function hideNarration(text: string): boolean {
  return NARRATION_ACK_RE.test(text);
}

/**
 * HIDE-STATION-USER-R1: injected machinery in a turn shown in the owner's voice ("(you)": a user
 * turn with no `from` and no `auto`). Session reports ("# NAME-R2 — verdict …"), the brain's
 * `[inbox]` / `[tree]` / `[roots]` blocks and its `[clock …] [gap since last user turn …]
 * [context ≈ … tokens]` header can land in a user turn without a sender; on the phone they read
 * as words the owner typed.
 *
 * Conservative by design — losing words the owner typed is worse than a leak:
 * - a marker counts only at the very start of a line (leading spaces allowed, nothing else; a
 *   quoted `> [inbox]` is the owner quoting, and stays);
 * - the clock/gap/context header is a PREFIX: its tokens go, the rest of that line stays
 *   (`[clock …] hello` → `hello`);
 * - a block marker line goes with the list lines right under it (`- …`, `* …`, `1. …`,
 *   indented); the first other line — or a blank line — ends the block and is kept.
 * A turn whose every line is machinery comes back '' and is not rendered.
 */
const HEADER_LEAD_RE =
  /^\s*(?:\[clock \d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\]|\[gap since last user turn [^\]\n]*\]|\[context ≈ [^\]\n]*(?:\]|$))/;
// the tokens the brain's clock header chains after its lead (main.rs clock_header)
const HEADER_TOKEN_RE =
  /^\s*(?:\[clock \d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\]|\[gap since last user turn [^\]\n]*\]|\[context ≈ [^\]\n]*(?:\]|$)|\[rules: [^\]\n]*\]|\[meanwhile\])/;
// a whole line of machinery, nothing under it: the clock header's meanwhile line
const MACHINE_LINE_RE = /^\s*\[clock\](?:\s|$)/;
const BLOCK_RE = new RegExp(
  '^\\s*(?:' +
    [
      // a station turn folded to one line, the inbox (owner wake + per-turn), the tree view
      '\\[station turn\\]',
      '\\[inbox(?: since your last turn)?\\]',
      '\\[tree\\]',
      '\\[roots\\]',
      'other sessions active in the last ',
      'work other roots asked this machine for ',
      // a session report's header: "# PHONE-PAIR-R3 — …", "## HIDE-STATION-R2: …"
      '#{1,6} [A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-R\\d+(?:\\s+[—–:-](?:\\s|$)|:|\\s*$)',
      // …or stamped instead of numbered: "# PAIR-MINT 2026-11-23T11:00Z"
      '#{1,6} [A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+ \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?Z(?:\\s|$)',
    ].join('|') +
    ')'
);
// what sits under a block marker: list items, indented lines, the tree view's own notes
const BODY_RE = /^(?:\s*(?:[-*•]|\d+[.)])\s|\s+\S|\((?:none yet|\d+ closed session\(s\) hidden)\b)/;

export function stripUserMachinery(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw;
    if (inBlock) {
      if (BODY_RE.test(line)) continue;
      inBlock = false;
    }
    if (HEADER_LEAD_RE.test(line)) {
      let m: RegExpMatchArray | null;
      while ((m = line.match(HEADER_TOKEN_RE))) line = line.slice(m[0].length);
      line = line.replace(/^\s+/, '');
      if (!line) continue;
    }
    if (MACHINE_LINE_RE.test(line)) continue;
    if (BLOCK_RE.test(line)) {
      inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}
