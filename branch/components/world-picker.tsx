'use client';

/** The world list, one design wherever a world is picked: /settings (the app's world) and a
 *  computer's settings tab (/roots/[root]). Each world is drawn with its own tree in its own
 *  palette (the button carries data-theme, so tokens.css scopes the colors to it): the choice
 *  is seen before it is made, and the tapped world's tree answers with one pulse up the trunk. */
import { useEffect, useState } from 'react';
import { YggTree } from '@/components/ygg';
import { SWATCHES, WORLDS, type WorldId } from '@/lib/worlds';

export function WorldPicker({
  current,
  onPick,
  disabled = false,
}: {
  /** the world ringed as current (undefined: none yet, e.g. before mount) */
  current: string | null | undefined;
  onPick: (w: WorldId) => void;
  disabled?: boolean;
}) {
  // the world whose tree answers right now (+ a counter so a re-tap replays)
  const [wake, setWake] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!wake) return;
    const t = setTimeout(() => setWake(null), 2500);
    return () => clearTimeout(t);
  }, [wake]);

  return (
    <div className="oz-worlds">
      {WORLDS.map((w) => (
        <button
          key={w.id}
          type="button"
          data-theme={w.id}
          data-testid="world-pick"
          data-world={w.id}
          aria-pressed={current === w.id}
          aria-label={`${w.id} — ${w.desc}`}
          disabled={disabled}
          onClick={() => {
            onPick(w.id);
            setWake((p) => ({ id: w.id, n: (p?.n || 0) + 1 }));
          }}
          className="oz-world"
        >
          <span
            key={wake?.id === w.id ? wake.n : 0}
            className={`oz-ygg block ${wake?.id === w.id ? 'wake' : ''}`}
          >
            <YggTree />
          </span>
          <span>
            <b>{w.id}</b>
            <small>{w.desc}</small>
            <span className="sw6">
              {SWATCHES.map((r) => (
                <i key={r} style={{ background: `var(--oz-${r})` }} />
              ))}
            </span>
            <span className="cur">current</span>
          </span>
        </button>
      ))}
    </div>
  );
}
