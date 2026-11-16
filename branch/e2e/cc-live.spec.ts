import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test } from '@playwright/test';

/** Claude Code live (11-14), driven like a person on a Pixel 7 against the preview
 *  (PW_BASE_URL = :8447): the running sessions are listed (background: "you can type",
 *  interactive: "watch only"); a background session opens with its history, a message typed on
 *  the phone reaches it, its permission prompt shows as buttons and a tap answers it, the tool
 *  call and the reply appear live, and `claude logs` (its terminal) shows the same; the terminal
 *  tab draws its screen; an interactive session is watch only (no box; input refused); a long
 *  transcript scrolls back.
 *
 *  CC_LIVE_SID=<sessionId of a background session in a trusted folder> reuses one (no extra
 *  turn); else the test starts one (`claude --bg --model haiku`) under ~/Work and removes it.
 *  One real haiku turn (Write + reply). Never touches a session it didn't start or wasn't given. */
test.use({ ...devices['Pixel 7'] });

type Live = {
  sessionId: string;
  short: string;
  name: string;
  kind: string;
  cwd: string;
  canType: boolean;
};
const agents = () =>
  JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' })) as {
    sessionId: string;
    id?: string;
    name: string;
    kind: string;
    cwd: string;
    status?: string;
  }[];
const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out: ${what}`);
};
/** a terminal's own interactive Claude Code session, held in a PTY (no turn is ever sent) */
const HOLD = `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1]); os.execvp('claude', ['claude', '--model', 'haiku', '-n', sys.argv[2]])
end = time.time() + 900
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: os.read(fd, 65536)
        except OSError: break
`;
const strip = (s: string) =>
  s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\s+/g, ' ');

test('Claude Code live: watch + type into a background session from the phone; interactive is watch only', async ({
  page,
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const work = join(homedir(), 'Work');
  let own = '';
  let sid = process.env.CC_LIVE_SID || '';
  let dir = '';
  if (!sid) {
    dir = join(work, `cc-live-e2e-${Date.now()}`);
    mkdirSync(dir);
    const out = execFileSync(
      'claude',
      ['--bg', '--model', 'haiku', '-n', 'cclive-e2e', 'Reply with exactly: history ready'],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
      }
    );
    // (the CLI may colour its line: match the words, not the bytes between them)
    own = /backgrounded\W+([0-9a-f]{8})/.exec(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))?.[1] || '';
    expect(own, out).not.toBe('');
    await until(
      () => agents().some((a) => a.id === own && a.status === 'idle'),
      120_000,
      'the new session idles'
    );
    sid = agents().find((a) => a.id === own)!.sessionId;
  }
  const bg = agents().find((a) => a.sessionId === sid)!;
  expect(bg?.kind).toBe('background');
  dir = dir || bg.cwd;
  const short = bg.id!;
  // a watch-only one: a scratch interactive session in the same folder, held open
  const watchName = `cclive-watch-${Date.now() % 100000}`;
  // without this run's own Claude Code markers (a child session would not save its transcript)
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE/.test(k)) delete env[k];
  const hold: ChildProcess = spawn('python3', ['-c', HOLD, dir, watchName], {
    env,
    stdio: 'ignore',
  });
  const n = Date.now() % 10000;
  try {
    await until(
      () => agents().some((a) => a.name === watchName && a.kind === 'interactive'),
      30_000,
      'the interactive scratch session is listed'
    );
    const isid = agents().find((a) => a.name === watchName)!.sessionId;

    // the phone: + new session → continue a terminal session → open ones first
    await page.goto('/');
    await page.getByRole('button', { name: 'new session' }).tap();
    await page.getByRole('button', { name: /continue a terminal session/ }).tap();
    const sheet = page.getByTestId('continue-terminal');
    const row = sheet.locator(`[data-term="${sid}"]`);
    await expect(row).toHaveAttribute('data-live', 'bg');
    await expect(row).toContainText('background · you can type');
    await expect(sheet.locator(`[data-term="${isid}"]`)).toContainText('open in a terminal');
    await page.screenshot({ path: 'test-results/cc-live-1-list.png' });
    await row.tap();
    await expect(page).toHaveURL(new RegExp(`/cc/${sid}$`));

    // history first: what the transcript already holds
    await expect(page.locator('[data-k="assistant"]').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-k="user"]').first()).toBeVisible();
    await expect(page.getByTestId('cc-status')).toBeVisible();
    await page.screenshot({ path: 'test-results/cc-live-2-history.png' });

    // type on the phone → the session gets it, asks to write the file, a tap says yes
    const file = `live-${n}.txt`;
    const msg = `Create a file named ${file} containing cc-live-${n} using the Write tool, then reply with exactly: done ${n}`;
    const box = page.getByRole('textbox', { name: 'message the session' });
    await box.tap();
    await box.fill(msg);
    await page.getByRole('button', { name: 'send', exact: true }).tap();
    await expect(
      page.locator('[data-k="user"]:not([data-pending])', { hasText: file })
    ).toBeVisible({ timeout: 30_000 });
    const ask = page.getByTestId('cc-prompt');
    await expect(ask).toContainText(file, { timeout: 90_000 });
    await expect(page.getByTestId('cc-status')).toHaveAttribute('data-state', 'blocked');
    await page.screenshot({ path: 'test-results/cc-live-3-prompt.png' });
    await ask.locator('[data-opt="1"]').tap();
    await expect(ask).toBeHidden({ timeout: 20_000 });

    // the tool call and the reply arrive live
    const card = page.locator('[data-tool="Write"]', { hasText: file });
    await expect(card).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await expect(page.locator('[data-k="assistant"]', { hasText: `done ${n}` })).toBeVisible({
      timeout: 90_000,
    });
    await card.locator('button').first().tap();
    await expect(card.getByTestId('cc-input')).toContainText(`cc-live-${n}`);
    await expect(card.getByTestId('cc-output')).toContainText(file);
    await page.screenshot({ path: 'test-results/cc-live-4-live.png' });
    expect(readFileSync(join(dir, file), 'utf8').trim()).toBe(`cc-live-${n}`);

    // the terminal shows the same
    const logs = strip(execFileSync('claude', ['logs', short], { encoding: 'utf8' }));
    expect(logs).toContain(file);
    expect(logs).toContain(`done ${n}`);

    // the raw terminal tab draws the session's screen (its name in the input box border)
    await page.getByRole('button', { name: 'terminal', exact: true }).tap();
    await expect(page.locator('[data-testid="cc-term"] .xterm-rows')).toContainText(bg.name, {
      timeout: 20_000,
    });
    await page.screenshot({ path: 'test-results/cc-live-5-terminal.png' });
    await page.getByRole('button', { name: 'chat', exact: true }).tap();

    // an interactive session: watch only, and the helper refuses input to it
    await page.goto(`/cc/${isid}`);
    await expect(page.getByTestId('cc-watch-only')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('textbox', { name: 'message the session' })).toHaveCount(0);
    const refused = await request.post(`/api/cc-live/s/${isid}/input`, { data: { text: 'hello' } });
    expect(refused.status()).toBe(403);
    await page.screenshot({ path: 'test-results/cc-live-6-watch-only.png' });

    // scroll back: a long transcript (any listed session whose history goes further back) — read only
    const list = (await (await request.get('/api/cc-live/sessions')).json()).sessions as Live[];
    for (const s of list) {
      const h = await (await request.get(`/api/cc-live/s/${s.sessionId}/history?limit=200`)).json();
      if (!h.cursor) continue;
      await page.goto(`/cc/${s.sessionId}`);
      const shown = page.locator('[data-testid="cc-scroll"] .cc-list > *');
      await expect(page.getByRole('button', { name: 'earlier…' })).toBeVisible({ timeout: 20_000 });
      const before = await shown.count();
      await page.getByRole('button', { name: 'earlier…' }).tap();
      await expect.poll(() => shown.count(), { timeout: 20_000 }).toBeGreaterThan(before);
      break;
    }
  } finally {
    hold.kill('SIGTERM');
    if (own) {
      execFileSync('claude', ['stop', own], { stdio: 'ignore' });
      execFileSync('claude', ['rm', own], { stdio: 'ignore' });
      if (dir.includes('cc-live-e2e-') && existsSync(dir)) rmSync(dir, { recursive: true });
    } else if (dir) {
      rmSync(join(dir, `live-${n}.txt`), { force: true });
    }
  }
});
