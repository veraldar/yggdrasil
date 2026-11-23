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
