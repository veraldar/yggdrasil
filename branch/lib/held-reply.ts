/** L16 (owner rule 11-20): a turn you speak is answered aloud, a turn you type in writing.
 *  Hands-free speaks its own replies. For a HELD turn in text mode the session page asks here
 *  which reply to say, once: the completed answer to the spoken user message that landed after
 *  the press. The brain marks a spoken message `voice`; a typed one never is, so a hold that
 *  caught nothing can never make a later typed turn's answer talk. */
import type { Msg } from '../components/session-message';

export type Held = {
  /** server time of the newest user turn on screen when the mic was pressed */
  before: number;
  /** the spoken turn's message, once it has landed */
  user?: string;
};

/** `user`: the held turn's message id once it is on screen. `reply`: its answer, once complete
 *  (never a growing fragment, never another turn's answer). */
export function heldReply(msgs: Msg[], h: Held): { user?: string; reply?: Msg } {
  let ui = h.user ? msgs.findIndex((m) => m.id === h.user) : -1;
  if (ui < 0) {
    ui = msgs.findIndex(
      (m) =>
        m.role === 'user' &&
        m.modality === 'voice' &&
        m.time > h.before &&
        !m.queued &&
        !m.from &&
        !m.auto
    );
  }
  if (ui < 0) return {};
  const u = msgs[ui];
  const after = msgs.slice(ui + 1);
  // its own answer (the message it answers). A brain that does not say which message a reply
  // answers: the next reply, unless another user turn came first (then it may be that one's)
  let a = u.id ? after.find((m) => m.role === 'assistant' && m.parent === u.id) : undefined;
  if (!a) {
    const next = after.find((m) => m.role === 'user' || (m.role === 'assistant' && !m.parent));
    if (next?.role === 'assistant') a = next;
  }
  if (!a || a.done === false || !a.text.trim()) return { user: u.id };
  return { user: u.id, reply: a };
}
