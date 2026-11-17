/** QUIET-ASSESS law (owner 11-10): an assistant reply to an automated
 *  verdict request (brain stamps info.meta.autoReply) is not spoken on arrival — the
 *  coordinator assesses silently and only speaks when the owner must act.
 *  OWNER-ACTION: in the text keeps the voice. A manual replay tap bypasses this.
 *
 *  THE DOOR (voice-fixes 11-14): on MAIN the brain already keeps the silent ones out of
 *  sight — a woken coordinator with nothing to say answers (quiet), and that reply is
 *  stored internal, never shown. A VISIBLE autoReply on MAIN is MAIN coming back to the
 *  person ("done: …"), and hands-free they cannot see the screen: it is spoken like any
 *  reply (`door` = this reply is MAIN's, on its own page). */
export const OWNER_ACTION_MARKER = 'OWNER-ACTION:';

export function shouldAutoSpeak(m: { text: string; autoReply?: boolean }, door = false): boolean {
  return door || !m.autoReply || m.text.includes(OWNER_ACTION_MARKER);
}
