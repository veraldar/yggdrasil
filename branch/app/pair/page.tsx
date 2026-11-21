'use client';

/** /pair — both halves of the QR handshake (v0.9 no-tailscale).
 *  On the box's console (no fragment): mints a one-time code and shows the
 *  QR, re-minting at expiry. On the phone (fragment v=1&code=…&fp=…&bridge=…):
 *  redeems the code, pins the bridge fingerprint (trust-on-first-scan) and
 *  lands on home — zero typing, this IS the auto-setup. Home decides: the
 *  tree door for a device that never walked it (its last step is MAIN), the
 *  session list for one that did. Never straight into MAIN: a fresh phone
 *  would skip the door (11-14, a phone paired through the trunk). The
 *  fragment is wiped from history before anything else runs.
 *  Anyone else (no fragment, and the box refuses to mint: a phone that is not paired, a
 *  stranger at the public address) is shown one quiet line and nothing of the console:
 *  no heading, no QR frame, no link they cannot use. The owner's rule (11-21): "if there
 *  is nothing I should be seeing then I should see nothing". */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import { savePin } from '@/lib/p2p';
import { pinSaved } from '@/lib/pinned';

type Code = {
  url: string;
  svg: string;
  exp: number;
  fingerprint: string | null;
  bridge: string | null;
  warning?: string;
};

const WHY: Record<string, string> = {
  used: 'this code was already used — ask the box for a fresh QR',
  expired: 'this code expired — ask the box for a fresh QR',
  invalid: 'this code is not one the box issued',
};

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'browser';
}

export default function PairPage() {
  const [mode, setMode] = useState<'console' | 'phone' | 'quiet' | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const frag = new URLSearchParams(location.hash.slice(1));
    if (frag.get('code')) {
      setMode('phone');
      history.replaceState(null, '', '/pair');
      void claim(frag);
    } else {
      // the console or not: only the box's answer to the mint tells. Until it comes, nothing is drawn.
      void mint();
    }
  }, []);

  // console: re-mint when the shown code expires
  useEffect(() => {
    if (mode !== 'console' || !code) return;
    const t = setTimeout(() => void mint(), Math.max(1000, code.exp - Date.now()));
    return () => clearTimeout(t);
  }, [mode, code]);

  async function mint() {
    const r = await fetch('/api/pair/code', { method: 'POST' }).catch(() => null);
    if (r && (r.status === 401 || r.status === 403)) {
      // not the box's console: codes are made there only, and nothing here is for this visitor
      setMode('quiet');
      return;
    }
    setMode('console');
    if (!r || !r.ok) {
      setError('no pairing code yet — trying again');
      setTimeout(() => void mint(), 5_000);
      return;
    }
    setError('');
    if (new URLSearchParams(location.search).get('unpaired')) {
      setStatus('this device is not paired — scan the QR on the box');
    }
    setCode(await r.json());
  }

  async function claim(frag: URLSearchParams) {
    setStatus('pairing…');
    const r = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: frag.get('code'), name: deviceName() }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus('');
      setError(WHY[body.why] || 'pairing failed');
      return;
    }
    const fp = frag.get('fp');
    const bridge = frag.get('bridge');
    if (fp && bridge) {
      savePin({
        fp,
        bridge,
        box: frag.get('box') || 'box',
        deviceId: body.id,
        pairedAt: new Date().toISOString(),
      });
      pinSaved();
    }
    setStatus(`paired as ${body.name} — opening`);
    // the service worker carries the box's data over the pinned channel (lib/pinned.ts): it must
    // be in charge before the first page of the app asks for any
    await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 3_000))]);
    location.replace('/');
  }

  if (mode === null) return <main className="min-h-dvh" />;
  if (mode === 'quiet') {
    return (
      <main className="flex min-h-dvh items-center justify-center px-3">
        <p data-testid="pair-quiet" className="text-[12px] text-[var(--oz-dim)]">
          not paired
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">pair a device</span>
      </header>

      {mode === 'console' && (
        <section className="oz-blk">
          <h2>scan with the phone</h2>
          {code && (
            <>
              <div
                data-testid="pair-qr"
                className="mx-auto my-3 w-64 bg-white p-2"
                dangerouslySetInnerHTML={{ __html: code.svg }}
              />
              <ul className="oz-kv">
                <li>
                  <span>expires</span>
                  <span>{new Date(code.exp).toLocaleTimeString()}</span>
                  <span />
                </li>
                <li>
                  <span>box key</span>
                  <span data-testid="pair-fp" className="break-all">
                    {code.fingerprint || '—'}
                  </span>
                  <span />
                </li>
              </ul>
              {code.warning && <p className="note">{code.warning}</p>}
            </>
          )}
          <p className="note">
            <Link href="/devices">devices · revoke · kill-switch</Link>
          </p>
        </section>
      )}

      {(status || error) && (
        <section className="oz-blk">
          <p data-testid="pair-status" className="note">
            {error || status}
          </p>
        </section>
      )}
    </main>
  );
}
