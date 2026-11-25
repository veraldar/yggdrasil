'use client';

/** /settings — about, world, engines, yours (+ "account & devices ›" behind a v1 trunk). The world list is the theme switch
 *  (components/world-picker.tsx, the same list a computer's settings tab
 *  shows). Tapping applies at once via next-themes — one data-theme
 *  attribute on <html>, transitions suppressed for the swap frame. Below it:
 *  the engines block (components/engines-block.tsx) — each engine's default
 *  model, saved to the brain on tap. */
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { EnginesBlock } from '@/components/engines-block';
import { LineIcon } from '@/components/line-icon';
import { HOME_ROOT_KEY, type Tree } from '@/components/roots-sheet';
import { WorldPicker } from '@/components/world-picker';
import { type EngineRow } from '@/lib/agents';
import { useTrunkMode } from '@/lib/auth-mode';
import { VERSION } from '@/lib/version';
import { VOICE_TEST_SLUG, ensureVoiceTestRoom, setVoiceTest, voiceTestOn } from '@/lib/voice-test';
import { chosenWorld } from '@/lib/worlds';

export default function SettingsPage() {
  const router = useRouter();
  // v1 (trunk mode): the account, its 2FA and the devices live on the trunk — one link there
  const trunk = useTrunkMode();
  const { theme, setTheme } = useTheme();
  // next-themes only knows the stored theme after mount — render no
  // "current" marker on the server pass instead of a wrong one
  const [mounted, setMounted] = useState(false);
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
  // the engines' default models (GET /api/engines); null until loaded or on an older brain (404)
  const [engines, setEngines] = useState<EngineRow[] | null>(null);

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
        // the home root's world only once one was picked (theme_rev > 0): its unpicked default
        // must not overwrite the world this phone shows (11-23: it flipped the app dark)
        const w = chosenWorld(t.home.theme, t.home.theme_rev);
        if (w) setTheme(w);
      })
      .catch(() => {});
  }, [setTheme]);

  // load engines on mount; retry on transient errors, stop cleanly on 404 (older brain)
  useEffect(() => {
    if (engines) return;
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const clear = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const load = () =>
      fetch('/api/engines', { cache: 'no-store' })
        .then(async (r) => {
          if (stop) return;
          if (r.status === 404) {
            clear();
            return;
          }
          const d = await r.json().catch(() => null);
          if (stop) return;
          if (r.ok && Array.isArray(d)) {
            setEngines(d);
            clear();
          }
        })
        .catch(() => {});
    void load();
    timer = setInterval(() => !document.hidden && void load(), 2000);
    return () => {
      stop = true;
      clear();
    };
  }, [engines]);

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
        <WorldPicker
          current={current}
          onPick={(w) => {
            setTheme(w);
            if (homeRoot) {
              void fetch(`/api/roots/${encodeURIComponent(homeRoot)}/theme`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ theme: w }),
              }).catch(() => {});
            }
          }}
        />
      </section>

      {engines && engines.length > 0 && <EnginesBlock engines={engines} onSaved={setEngines} />}

      {/* the simple menu (owner feedback): three rows, nothing else —
          roles opens the roles page; walk-through re-walks in the test room;
          voice tests toggle their own room */}
      <section className="oz-blk">
        <ul className="oz-kv">
          {trunk && (
            <li>
              <span>account &amp; devices</span>
              <span />
              {/* the trunk's own page (same origin, not this app's): a full navigation */}
              <a href="/account" data-testid="account-link" className="oz-k sm">
                ›
              </a>
            </li>
          )}
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
