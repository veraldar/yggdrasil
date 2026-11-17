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
    <div
      data-testid="pin-state"
      data-state={s.state}
      title={s.why}
      hidden={s.state === 'off'}
      style={{
        position: 'fixed',
        left: 8,
        bottom: 'calc(6px + env(safe-area-inset-bottom))',
        zIndex: 60,
        font: '10px/1.4 var(--font-commit-mono, monospace)',
        padding: '1px 6px',
        borderRadius: 8,
        pointerEvents: 'none',
        opacity: s.state === 'pinned' ? 0.55 : 0.9,
        color:
          s.state === 'refused' ? '#ff6b6b' : s.state === 'fallback' ? '#e0b44c' : 'currentColor',
        border: '1px solid currentColor',
      }}
    >
      {SAY[s.state]}
    </div>
  );
}
