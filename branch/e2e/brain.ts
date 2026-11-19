import { readFileSync } from 'fs';
import path from 'path';

/** Which brain the e2e seeds/asserts against. The suite drives a SERVED app
 *  (PW_BASE_URL) — the brain it must talk to is the brain THAT app serves,
 *  never a hardcoded port:
 *    - E2E_OC_URL / OPENCODE_URL win explicitly (a runner pins the brain);
 *    - the live app (no PW_BASE_URL, or :8080) is the live brain (:4096);
 *    - any other app served from this tree (the sandbox :8090, a config's
 *      own webServer) reads the OPENCODE_URL of branch/.env.local — the env
 *      `next start` loads here (sandbox: yggdrasil :4100).
 *  Root cause fixed 10-23: three specs hardcoded the live brain (:4096) and
 *  seeded/asserted the WRONG store under the sandbox — sessions the proxy
 *  (:4100) could never see (context/wedge/subs RED under PW_BASE_URL=:8090,
 *  GREEN against :8080 — pure env drift, zero product surface). */

function envLocalBrain(): string | undefined {
  try {
    const env = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    return /^OPENCODE_URL=(.+)$/m.exec(env)?.[1].trim();
  } catch {
    return undefined;
  }
}

const LIVE_APP = !process.env.PW_BASE_URL || process.env.PW_BASE_URL.includes(':8080');

/** phase 0 (plan G7.3): a live brain is never a silent default. The twin (:4250) is.
 *  E2E_ALLOW_LIVE=1 is the explicit human override (a read-write run on live, on purpose). */
const FALLBACK = LIVE_APP ? 'http://127.0.0.1:4096' : envLocalBrain() || 'http://127.0.0.1:4096';
const NO_DEFAULT = process.env.E2E_OC_URL || process.env.OPENCODE_URL;
export const OC = NO_DEFAULT || (process.env.E2E_ALLOW_LIVE === '1' ? FALLBACK : 'http://127.0.0.1:4250');
if (!NO_DEFAULT && process.env.E2E_ALLOW_LIVE !== '1') {
  // said once per worker, not per test — the runner always sets E2E_OC_URL, so this
  // reaching a log means somebody ran a suite without a brain pinned
  console.warn('[e2e] no E2E_OC_URL: defaulting to the twin :4250 (E2E_ALLOW_LIVE=1 to touch live)');
}
