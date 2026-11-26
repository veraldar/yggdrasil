'use client';

/**
 * The pinned channel's state, in one small honest line (lib/pinned.ts): is this phone's app
 * traffic end to end with the box, or on the trunk's TLS (the VPS can read it), or refused
 * (the box key did not match the pairing QR — someone in the middle; nothing is sent)?
 * Hidden when there is no pin (the box's own network, the tailnet).
 */
import { useEffect, useState } from 'react';
import { PIN_CHANGED_ALARM, type PinState, bootPinned, usePinState } from '@/lib/pinned';

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
  const s = usePinState();
  // /pair found this visitor is not paired (a phone that was, once, still holds its old pin): no road to name
  const [unpaired, setUnpaired] = useState(false);
  useEffect(() => {
    const on = () => setUnpaired(true);
    if (document.documentElement.dataset.unpaired) on();
    window.addEventListener('bifrost:unpaired', on);
    return () => window.removeEventListener('bifrost:unpaired', on);
  }, []);
  const text =
    s.state === 'refused' && s.why === PIN_CHANGED_ALARM ? PIN_CHANGED_ALARM : SAY[s.state];
  return (
    // the look and the place are styles/brand.css § pin (a caption like the band's, and a spot
    // no page's chrome uses — on the front page, the roots' top-right corner)
    <div
      className="oz-pin"
      data-testid="pin-state"
      data-state={s.state}
      role={s.state === 'refused' ? 'alert' : undefined}
      title={s.why}
      hidden={s.state === 'off' || unpaired}
    >
      <i aria-hidden="true" />
      {text}
    </div>
  );
}
