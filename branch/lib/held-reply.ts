/** L16 (owner rule 11-20): a turn you speak is answered aloud, a turn you type in writing.
 *  Hands-free speaks its own replies. For a HELD turn in text mode the session page asks here
 *  which reply to say, once: the completed answer to the spoken user message that landed after
 *  the press. The brain marks a spoken message `voice`; a typed one never is, so a hold that
 *  caught nothing can never make a later typed turn's answer talk. */
import type { Msg } from '../components/session-message';

export type Held = {
  /** server time of the newest user turn on screen when the mic was pressed (0: none yet) */
  before: number;
  /** the phone's clock at the press */
  at: number;
  /** the spoken turn's message, once it has landed */
  user?: string;
};

/** a turn stored long before the press is never this hold's (the page opened a moment ago and
 *  its list was still empty at the press); wide enough for a phone clock that is off */
const FLOOR_MS = 10 * 60_000;

/** `user`: the held turn's message id once it is on screen. `reply`: its answer, once complete
 *  (never a growing fragment, never another turn's answer). `over`: its run ended with nothing
 *  to say (it was stopped or it failed) — stop waiting. `claimed`: messages that are another
 *  hold's turn (two holds in a row each get their own). */
export function heldReply(
  msgs: Msg[],
  h: Held,
  claimed: string[] = []
): { user?: string; reply?: Msg; over?: boolean } {
  let ui = h.user ? msgs.findIndex((m) => m.id === h.user) : -1;
  if (ui < 0) {
    const floor = Math.max(h.before, h.at - FLOOR_MS);
    ui = msgs.findIndex(
      (m) =>
        m.role === 'user' &&
        m.modality === 'voice' &&
        m.time > floor &&
        !m.queued &&
        !m.from &&
        !m.auto &&
        !(m.id && claimed.includes(m.id))
    );
  }
  if (ui < 0) return {};
  const u = msgs[ui];
  const after = msgs.slice(ui + 1);
  // its own answer (the message it answers; the last one, should a brain store one per step).
  // A brain that does not say which message a reply answers: the next reply, unless another
  // user turn came first (then it may be that one's)
  let a = u.id
    ? [...after].reverse().find((m) => m.role === 'assistant' && m.parent === u.id)
    : undefined;
  if (!a) {
    const next = after.find((m) => m.role === 'user' || (m.role === 'assistant' && !m.parent));
    if (next?.role === 'assistant') a = next;
  }
  if (!a || a.done === false) return { user: u.id };
  if (a.stopped || !a.text.trim()) return { user: u.id, over: true };
  return { user: u.id, reply: a };
}

/** L16, strict (lead 11-20, the default while the owner has not said otherwise): a turn you TYPE
 *  is answered in writing — also while hands-free is on. True when `a` answers a user turn on
 *  screen that was typed (not spoken, not another session's, not the brain's own). A reply whose
 *  question is not on screen (MAIN coming back from its sessions) is not a typed turn's answer. */
export function answersTyped(msgs: Msg[], a: Msg): boolean {
  if (!a.parent) return false;
  const asked = msgs.find((m) => m.id === a.parent);
  return !!asked && asked.role === 'user' && !asked.from && !asked.auto && asked.modality !== 'voice';
}
