/**
 * Voice over the trunk: the media path into LiveKit at home, through the
 * access point's port 443 (docs/own-trunk.md, "Voice over the trunk").
 *
 * The box's LiveKit only advertises candidates on the box's own addresses,
 * which a phone outside can never reach (the box takes no inbound
 * connection). The trunk carries ICE over TCP instead: the VPS's port 443
 * hands an RFC 4571-framed STUN connection to the access point's raw
 * `livekit-ice` forward, which rides the box's dial-out channel to LiveKit's
 * TCP port. LiveKit cannot advertise that address itself — it advertises the
 * port it binds, and :443 is not its to bind at home — so the phone adds it:
 * after every remote description, one passive TCP host candidate per address
 * /api/token named (`iceTcp`), with that description's ICE username fragment.
 * ICE then checks it like any other candidate; DTLS-SRTP runs end to end
 * between this browser and the box, and the VPS only moves its bytes.
 *
 * Installed once per page, and only when a token carried `iceTcp`; a LAN or
 * tailnet connection never gets it.
 */
export type IceTcp = { ip: string; port: number };

let addrs: IceTcp[] = [];
let installed = false;
const done = new WeakMap<RTCPeerConnection, string>();

const valid = (c: IceTcp) =>
  typeof c?.ip === 'string' &&
  /^[0-9a-fA-F:.]+$/.test(c.ip) &&
  Number.isInteger(c.port) &&
  c.port > 0 &&
  c.port < 65536;

/** the candidate lines for these addresses (exported for the tests) */
export function trunkCandidates(list: IceTcp[]): string[] {
  // host type, tcp passive: priority (2^24)*90 + (2^8)*(65535-i) + 255 — below a UDP host
  // candidate (126), so a phone on the box's own network still prefers its direct path
  return list.filter(valid).map((c, i) => {
    const prio = 90 * 2 ** 24 + (65535 - i) * 2 ** 8 + 255;
    return `candidate:${7443 + i} 1 tcp ${prio} ${c.ip} ${c.port} typ host tcptype passive`;
  });
}

async function addTrunk(pc: RTCPeerConnection): Promise<void> {
  const sdp = pc.remoteDescription?.sdp || '';
  const ufrag = /a=ice-ufrag:(\S+)/.exec(sdp)?.[1];
  const mid = /a=mid:(\S+)/.exec(sdp)?.[1];
  if (!ufrag || mid === undefined || done.get(pc) === ufrag) return; // once per ICE session
  done.set(pc, ufrag);
  for (const candidate of trunkCandidates(addrs)) {
    await pc.addIceCandidate({ candidate, sdpMid: mid, sdpMLineIndex: 0, usernameFragment: ufrag });
  }
}

/** this page's voice rides the trunk (a token named its ICE-TCP address) */
export const trunkActive = (): boolean => addrs.length > 0;

/** remember where the trunk takes ICE-TCP, and make every peer connection
 *  offer it (idempotent; the latest token's list wins) */
export function trunkIce(list: IceTcp[] | undefined): void {
  if (!Array.isArray(list)) return;
  addrs = list.filter(valid);
  if (installed || !addrs.length || typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  const proto = RTCPeerConnection.prototype;
  const original = proto.setRemoteDescription;
  proto.setRemoteDescription = async function (
    this: RTCPeerConnection,
    ...args: Parameters<RTCPeerConnection['setRemoteDescription']>
  ) {
    await original.apply(this, args);
    try {
      await addTrunk(this);
    } catch (e) {
      console.warn('trunk ICE-TCP candidate not added:', e);
    }
  } as RTCPeerConnection['setRemoteDescription'];
}
