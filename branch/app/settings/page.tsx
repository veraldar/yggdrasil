'use client';

/** /settings — about, world, yours. The world list is the theme switch:
 *  each world is drawn with its own tree in its own palette (the button
 *  carries data-theme, so tokens.css scopes the colors to it), the choice is
 *  seen before it is made. Tapping applies at once via next-themes — one
 *  data-theme attribute on <html>, transitions suppressed for the swap
 *  frame — and that world's tree answers with one pulse up the trunk. */
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { HOME_ROOT_KEY, type Tree } from '@/components/roots-sheet';
import { YggTree } from '@/components/ygg';
import { VERSION } from '@/lib/version';
import { VOICE_TEST_SLUG, ensureVoiceTestRoom, setVoiceTest, voiceTestOn } from '@/lib/voice-test';
import { SWATCHES, WORLDS, cacheRootTheme, isWorld } from '@/lib/worlds';

export default function SettingsPage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  // next-themes only knows the stored theme after mount — render no
  // "current" marker on the server pass instead of a wrong one
  const [mounted, setMounted] = useState(false);
  // the world whose tree answers right now (+ a counter so a re-tap replays)
  const [wake, setWake] = useState<{ id: string; n: number } | null>(null);
  // voice tests in their own room (lib/voice-test.ts) — device-local
  const [vt, setVt] = useState(false);
  const [vtBusy, setVtBusy] = useState(false);
  const [vtErr, setVtErr] = useState('');
  // the walk-through again (UX-CALM): MAIN's first-turn card, in the test room
  const [walkBusy, setWalkBusy] = useState(false);
  const [walkErr, setWalkErr] = useState('');

  async function walkAgain() {
    setWalkBusy(true);
    setWalkErr('');
    try {
      await ensureVoiceTestRoom();
      router.push(`/session/${VOICE_TEST_SLUG}?teach=1`);
    } catch (e) {
      setWalkErr(e instanceof Error ? e.message : String(e));
      setWalkBusy(false);
    }
  }

  // the home root's name — picking a world here also persists it on the home root
  const [homeRoot, setHomeRoot] = useState('');

  useEffect(() => {
    setMounted(true);
    setVt(voiceTestOn());
    try {
      setHomeRoot(localStorage.getItem(HOME_ROOT_KEY) || '');
    } catch {
      /* private mode */
    }
    fetch('/api/roots', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Tree>) : null))
      .then((t) => {
        if (!t?.home?.name) return;
        setHomeRoot(t.home.name);
        if (isWorld(t.home.theme)) {
          cacheRootTheme(t.home.name, t.home.theme);
          setTheme(t.home.theme);
        }
      })
      .catch(() => {});
  }, [setTheme]);

  async function toggleVoiceTest() {
    const on = !vt;
    setVtBusy(true);
    setVtErr('');
    try {
      await setVoiceTest(on);
      setVt(on);
    } catch (e) {
      setVtErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVtBusy(false);
    }
  }

  useEffect(() => {
    if (!wake) return;
    const t = setTimeout(() => setWake(null), 2500);
    return () => clearTimeout(t);
  }, [wake]);

  const current = mounted ? theme : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">settings</span>
      </header>

      <section className="oz-blk">
        <h2>about</h2>
        <ul className="oz-kv">
          <li>
            <span>bifrost</span>
            <span>{VERSION} · a Veraldar product.</span>
            <span />
          </li>
          <li>
            <span>license</span>
            <span>AGPL-3.0</span>
            <span />
          </li>
        </ul>
      </section>

      <section className="oz-blk">
        <h2>world</h2>
        <div className="oz-worlds">
          {WORLDS.map((w) => (
            <button
              key={w.id}
              data-theme={w.id}
              aria-pressed={current === w.id}
              aria-label={`${w.id} — ${w.desc}`}
              onClick={() => {
                setTheme(w.id);
                setWake((p) => ({ id: w.id, n: (p?.n || 0) + 1 }));
                if (homeRoot) {
                  cacheRootTheme(homeRoot, w.id);
                  void fetch(`/api/roots/${encodeURIComponent(homeRoot)}/theme`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ theme: w.id }),
                  }).catch(() => {});
                }
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
      </section>

      {/* the simple menu (owner feedback): three rows, nothing else —
          roles opens the roles and engines; walk-through re-walks in the test room;
          voice tests toggle their own room */}
      <section className="oz-blk">
        <ul className="oz-kv">
          <li>
            <span>roles</span>
            <span />
            <Link href="/agents" data-testid="agents-link" className="oz-k sm">
              ›
            </Link>
          </li>
          <li>
            <span>walk-through</span>
            <span />
            <button
              type="button"
              data-testid="walk-again"
              disabled={walkBusy}
              onClick={() => void walkAgain()}
              className="oz-k sm"
            >
              walk it
            </button>
          </li>
          <li>
            <span>voice tests</span>
            <span data-testid="voice-test-state">
              {vt && <Link href={`/session/${VOICE_TEST_SLUG}`}>{VOICE_TEST_SLUG} ›</Link>}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={vt}
              aria-label="voice tests in their own room"
              data-testid="voice-test-toggle"
              disabled={vtBusy}
              onClick={() => void toggleVoiceTest()}
              className={`oz-k sm ${vt ? 'on' : ''}`}
            >
              {vt ? 'on' : 'off'}
            </button>
          </li>
        </ul>
        {walkErr && <p className="note text-[var(--oz-danger)]">{walkErr}</p>}
        {vtErr && <p className="note text-[var(--oz-danger)]">{vtErr}</p>}
      </section>
    </main>
  );
}
