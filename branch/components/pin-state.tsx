'use client';

/**
 * The pinned channel's state, in one small honest line (lib/pinned.ts): is this phone's app
 * traffic end to end with the box, or on the trunk's TLS (the VPS can read it), or refused
 * (the box key did not match the pairing QR — someone in the middle; nothing is sent)?
 * Hidden when there is no pin (the box's own network, the tailnet).
 */
import { useEffect, useState } from 'react';
import { type PinState, bootPinned, onPinState, pinState } from '@/lib/pinned';

// as early as the page's code runs: requests wait for the channel instead of leaking ahead of it
if (typeof window !== 'undefined') bootPinned();

const SAY: Record<PinState, string> = {
  off: '',
  connecting: 'pinning…',
  pinned: 'end to end',
  fallback: "via the trunk's TLS",
  reconnecting: 'reconnecting — nothing sent meanwhile',
  refused: 'box key mismatch — nothing sent',
};

export function PinStateLine() {
  const [s, setS] = useState(pinState());
  useEffect(() => onPinState((state, why) => setS({ state, why })), []);
  return (
    // the look and the place are styles/brand.css § pin (a caption like the band's, and a spot
    // no page's chrome uses — on the front page, the roots' top-right corner)
    <div
      className="oz-pin"
      data-testid="pin-state"
      data-state={s.state}
      title={s.why}
      hidden={s.state === 'off'}
    >
      <i aria-hidden="true" />
      {SAY[s.state]}
    </div>
  );
}
