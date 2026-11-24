/** A save a computer cannot take because its brain is older than the route that takes it.
 *
 *  Each computer keeps its own world, roles and engines; the hub brain only passes a save on
 *  (root/src/roots.rs put_peer_theme / put_root_agent / put_root_engine). A root whose brain
 *  is from before that route answers its router's own bare 404, and the hub brain hands it
 *  back as 502 {"error":"root <name>: 404 Not Found "} — what the owner got for every world
 *  picked for debian-box on 11-24 (its brain was a binary from 11-20). That is not an error
 *  to read: the phone says, in one line, that the computer needs an update.
 *
 *  A handler that says "not found" names what (the brain appends the root's own words after
 *  the status), so only a status with nothing after it means "no such route there". */

/** the hub brain's 502 line for a root that has no such route (a bare 404 or 405 from it) */
const NO_ROUTE = /^root [^\s:]+: (?:404 Not Found|405 Method Not Allowed)\s*$/;

export function rootLacksRoute(status: number, error: unknown): boolean {
  return status === 502 && typeof error === 'string' && NO_ROUTE.test(error);
}

/** the one line the phone shows instead */
export const needsUpdate = (root: string) => `${root} needs an update for this`;
