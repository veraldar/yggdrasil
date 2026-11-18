import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { devices, expect, type Page, test } from '@playwright/test';
import { slugify } from '../lib/slug';

/** The terminal's sessions, both ways (11-15), as the owner uses them on the stack they open
 *  (PW_BASE_URL = :8447), a Pixel 7 with taps:
 *   - the session list shows what is open in a terminal right now (Claude Code, Antigravity),
 *     watch only;
 *   - a scratch conversation of each harness (Claude Code, Antigravity, opencode) — started in a
 *     terminal in ~/Work/cc-live-scratch — continues from the phone: THE same conversation (the
 *     reply lands in its own transcript, no fork), then the terminal goes on and the phone shows
 *     that live;
 *   - one writer at a time: while a terminal has the conversation open, the phone is watch only
 *     and the brain refuses a turn; closed again, the phone continues.
 *  Scratch ids: TS_CLAUDE, TS_AGY, TS_OC (the conversations the run uses — never the owner's). */
test.use({ ...devices['Pixel 7'] });
test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const HOME = process.env.HOME || '';
const SCRATCH = `${HOME}/Work/cc-live-scratch`;
const IDS: Record<string, string> = {
  claude: process.env.TS_CLAUDE || '',
  antigravity: process.env.TS_AGY || '',
  opencode: process.env.TS_OC || '',
};
const tag = Date.now().toString(36).slice(-5);
const shot = (page: Page, n: string) =>
  page.screenshot({ path: `test-results/ts-${n}.png`, fullPage: false });
const href = (kind: string, id: string) => (kind === 'claude' ? `/cc/${id}` : `/cc/${id}?k=${kind}`);

/** a terminal's environment: none of the markers of the Claude Code session running this test
 *  (a child of one inherits CLAUDE_CODE_CHILD_SESSION: no transcript, not in `claude agents`) */
const termEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))) as NodeJS.ProcessEnv;

/** the terminal side: one turn on the same conversation, as the owner would type it there */
function terminalTurn(kind: string, id: string, text: string): ChildProcess {
  const argv: Record<string, string[]> = {
    claude: ['claude', '-p', '--resume', id, '--model', 'haiku', text],
    antigravity: ['agy', '-p', text, '--conversation', id, '--model', 'gemini-3.8-flash-low'],
    opencode: ['opencode', 'run', '--session', id, text],
  };
  const [cmd, ...args] = argv[kind];
  return spawn(cmd, args, { cwd: SCRATCH, stdio: 'ignore', env: termEnv() });
}

/** the conversation's own store has this text (the phone's turn reached THAT conversation) */
function inConversation(kind: string, id: string, text: string): boolean {
  const py = {
    claude: `import glob,sys; sys.exit(0 if any(sys.argv[2] in open(p).read() for p in glob.glob('${HOME}/.claude/projects/*/'+sys.argv[1]+'.jsonl')) else 1)`,
    antigravity: `import sys; sys.exit(0 if sys.argv[2] in open('${HOME}/.gemini/antigravity-cli/brain/'+sys.argv[1]+'/.system_generated/logs/transcript.jsonl').read() else 1)`,
    opencode: `import sqlite3,sys; c=sqlite3.connect('file:${HOME}/.local/share/opencode/opencode.db?mode=ro',uri=True); n=c.execute("select count(*) from part where session_id=? and data like ?",(sys.argv[1],'%'+sys.argv[2]+'%')).fetchone()[0]; sys.exit(0 if n else 1)`,
  }[kind]!;
  try {
    execFileSync('python3', ['-c', py, id, text]);
    return true;
  } catch {
    return false;
  }
}

const said = (page: Page, t: string) =>
  page.locator('[data-k="assistant"]').getByText(t, { exact: true });

/** stop what a test opened in a terminal, by its command line (tmux/script may outlive it) */
function stopTerminal(pattern: string) {
  try {
    execFileSync('pkill', ['-9', '-f', pattern]); // test terminals only: a TUI may shrug off the first TERM
  } catch {
    /* none left */
  }
}

/** who has the conversation open, as the live helper says (null: nobody) */
async function liveOf(page: Page, id: string): Promise<string | null> {
  const r = await page.request.get('/api/cc-live/harness');
  const d = (await r.json()) as { sessions: { id: string; live: string | null }[] };
  return d.sessions.find((x) => x.id === id)?.live ?? null;
}

const claudeTranscripts = () =>
  execFileSync('bash', ['-c', `ls ${HOME}/.claude/projects/*cc-live-scratch/*.jsonl | wc -l`], {
    encoding: 'utf8',
  }).trim();

test('the session list shows what is open in a terminal; open, it is watch only', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('terminal-key').tap();
  const strip = page.getByTestId('continue-terminal');
  await expect(strip).toBeVisible({ timeout: 20_000 });
  for (const kind of ['claude', 'antigravity'])
    await expect(strip.locator(`[data-kind="${kind}"][data-live="cmd"]`).first()).toBeVisible();
  await shot(page, '1-strip');
  // every row carries a three-letter tag (owner 11-17): the sessions, MAIN, the terminal strip
  const titles = await page.locator('.oz-row .t').allInnerTexts();
  expect(titles.length).toBeGreaterThan(2);
  for (const t of titles) expect(t.trim(), 'a row without its tag').toMatch(/^\[[A-Z]{3}\]/);
  await strip.locator('[data-kind="antigravity"][data-live="cmd"]').first().tap();
  await expect(page).toHaveURL(/\/cc\/[0-9a-f-]{36}\?k=antigravity/);
  await expect(page.locator('.cc-list > *').nth(2)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('cc-status')).toHaveText(/open in a terminal/);
  await expect(page.getByTestId('cc-fork')).toBeVisible(); // only the icon: continue in a new session
  await expect(page.getByTestId('cc-continue')).toHaveCount(0);
  await shot(page, '2-agy-watch');
  await page.goBack();
  await page.getByTestId('terminal-key').tap();
  await strip.locator('[data-kind="claude"][data-live="cmd"]').first().tap();
  await expect(page.locator('.cc-list > *').nth(2)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('cc-watch-only')).toBeVisible();
  await shot(page, '3-claude-watch');
});

for (const kind of ['claude', 'antigravity', 'opencode']) {
  test(`${kind}: continued from the phone, then from the terminal — one conversation`, async ({
    page,
  }) => {
    const id = IDS[kind];
    test.skip(!id, `no scratch ${kind} conversation`);
    const before = kind === 'claude' ? claudeTranscripts() : '';
    // the owner finds it in the sheet: session list → all… → the conversation
    await page.goto('/');
    await page.getByTestId('terminal-key').tap();
    const sheet = page.getByTestId('continue-terminal');
    await sheet.locator(`[data-term="${id}"]`).tap();
    await expect(page).toHaveURL(new RegExp(href(kind, id).replace('?', '\\?')));
    const box = page.getByTestId('cc-continue');
    await expect(box).toBeVisible({ timeout: 20_000 });
    const phone = `phone-${kind}-${tag}`;
    await box.locator('textarea').fill(`Reply with exactly: ${phone}`);
    await box.getByRole('button', { name: 'send' }).tap();
    // the tag as a word of its own (a model that saw many runs may add a guessed next line)
    const said = (t: string) =>
      page.locator('[data-k="assistant"]').getByText(new RegExp(`(^|\\s)${t}(\\s|$)`));
    await expect(said(phone)).toBeVisible({ timeout: 240_000 });
    await expect(page.getByTestId('cc-bifrost')).toBeVisible();
    // the sent message is the one in the transcript now (no "sending…" left), and no error
    // turns up after (a turn that reached the conversation is never reported as lost)
    await expect(page.locator('[data-k="user"][data-pending]')).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(8_000);
    await expect(page.locator('main [role="alert"]')).toHaveCount(0);
    await shot(page, `4-${kind}-from-phone`);
    expect(inConversation(kind, id, phone), 'the reply is in THAT conversation').toBe(true);
    if (kind === 'claude') expect(claudeTranscripts(), 'no fork: no new transcript').toBe(before);

    // the terminal goes on with the same conversation: the phone shows it live
    // its own random tag: the conversation's earlier runs make "term-<same tag>" guessable
    const term = `term-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    const p = terminalTurn(kind, id, `Reply with exactly: ${term}`);
    await expect(said(term)).toBeVisible({ timeout: 240_000 });
    await shot(page, `5-${kind}-from-terminal`);
    p.kill();
  });
}

test('one writer at a time: open in a terminal → watch only and the brain refuses', async ({
  page,
}) => {
  const id = IDS.claude;
  test.skip(!id, 'no scratch Claude Code conversation');
  // nobody has it open yet (a terminal turn of the test before may still be closing)
  stopTerminal(`[c]laude -p --resume ${id}`);
  await expect.poll(() => liveOf(page, id), { timeout: 30_000 }).toBeNull();
  await page.goto(href('claude', id));
  await expect(page.getByTestId('cc-continue')).toBeVisible({ timeout: 20_000 });
  // the owner opens it in a terminal (a real TTY: script)
  const tui = spawn('script', ['-qfec', `claude --resume ${id} --model haiku`, '/dev/null'], {
    cwd: SCRATCH,
    stdio: 'ignore',
    detached: true,
    env: { ...termEnv(), TERM: 'xterm-256color' },
  });
  try {
    // THIS terminal holds it (Claude Code registers a new terminal a few seconds after it starts)
    await expect.poll(() => liveOf(page, id), { timeout: 30_000 }).toBe('cmd');
    await expect(page.getByTestId('cc-watch-only')).toBeVisible({ timeout: 30_000 });
    await shot(page, '6-open-in-terminal');
    // the brain says no too: a turn sent straight to THE bifrost session on it
    const a = await page.request.post('/api/session', {
      data: { attach: { kind: 'claude', id, cwd: SCRATCH } },
    });
    const s = await a.json();
    expect(s.id).toBeTruthy();
    const slug = slugify(String(s.title));
    const sent = Date.now();
    await page.request.post(`/api/session/${slug}/messages`, {
      data: { text: `Reply with exactly: must-not-run-${tag}`, async: true },
      headers: { 'X-Session-Pin': s.id },
    });
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`/api/session/${slug}/messages?limit=2&errors=1`, {
            headers: { 'X-Session-Pin': s.id },
          });
          const ms = (await r.json()) as { role: string; error?: string; time: number }[];
          const last = ms[ms.length - 1];
          return last?.role === 'assistant' && last.time > sent ? last.error || '' : '';
        },
        { timeout: 30_000 }
      )
      .toContain('open in a terminal right now');
    expect(inConversation('claude', id, `must-not-run-${tag}`)).toBe(false);
  } finally {
    // the terminal closes: script and the claude under it (its own process group)
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-tui.pid!, sig);
      } catch {
        /* already gone */
      }
      if (sig === 'SIGTERM') await page.waitForTimeout(1500);
    }
    // script runs claude in a session of its own: stop it by its command line too
    try {
      execFileSync('pkill', ['-f', `[c]laude --resume ${id}`]);
    } catch {
      /* none left */
    }
  }
  // closed there: the phone continues again
  await expect(page.getByTestId('cc-continue')).toBeVisible({ timeout: 30_000 });
  await shot(page, '7-closed-again');
});

for (const kind of ['claude', 'antigravity']) {
  test(`${kind} open in tmux: typed from the phone, shown in the terminal — both ways`, async ({
    page,
  }) => {
    const id = IDS[kind];
    test.skip(!id, `no scratch ${kind} conversation`);
    const name = `ts-${kind}-${tag}`;
    const cmd =
      kind === 'claude'
        ? `claude --resume ${id} --model haiku`
        : `agy --conversation ${id} --model gemini-3.8-flash-low`;
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '120', '-y', '40', cmd], {
      cwd: SCRATCH,
      env: { ...termEnv(), TERM: 'xterm-256color' },
    });
    try {
      await page.goto(href(kind, id));
      const box = page.getByTestId('cc-type');
      await expect(box).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('cc-status')).toBeVisible();
      await page.waitForTimeout(kind === 'antigravity' ? 6_000 : 3_000); // the TUI comes up
      // Antigravity opens with a notice ("esc to dismiss"): the owner taps esc, as they would there
      if (kind === 'antigravity') await box.getByRole('button', { name: 'interrupt (esc)' }).tap();
      const msg = `tmux-${kind}-${tag}`;
      await box.locator('textarea').fill(`Reply with exactly: ${msg}`);
      await box.getByRole('button', { name: 'send' }).tap();
      await expect(said(page, msg)).toBeVisible({ timeout: 180_000 });
      await shot(page, `8-${kind}-tmux`);
      const pane = execFileSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' });
      expect(pane, 'the owner sees it in their terminal').toContain(msg);
      expect(inConversation(kind, id, msg)).toBe(true);
    } finally {
      try {
        execFileSync('tmux', ['kill-session', '-t', name]);
      } catch {
        /* gone */
      }
      stopTerminal(kind === 'claude' ? `[c]laude --resume ${id}` : `[a]gy --conversation ${id}`);
    }
  });
}

test('open in a plain terminal: "continue in a new session" — a copy, the original untouched', async ({
  page,
}) => {
  const id = IDS.claude;
  test.skip(!id, 'no scratch Claude Code conversation');
  stopTerminal(`[c]laude --resume ${id}`);
  await expect.poll(() => liveOf(page, id), { timeout: 30_000 }).toBeNull();
  const before = claudeTranscripts();
  const tui = spawn('script', ['-qfec', `claude --resume ${id} --model haiku`, '/dev/null'], {
    cwd: SCRATCH,
    stdio: 'ignore',
    detached: true,
    env: { ...termEnv(), TERM: 'xterm-256color' },
  });
  try {
    await expect.poll(() => liveOf(page, id), { timeout: 30_000 }).toBe('cmd');
    await page.goto(href('claude', id));
    await expect(page.getByTestId('cc-watch-only')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cc-status')).toHaveText(/open in a terminal/);
    await shot(page, '9-watch-with-copy');
    await page.getByTestId('cc-fork').tap();
    await expect(page).toHaveURL(/\/session\/[^?]+\?id=ses_/, { timeout: 20_000 });
    const msg = `copy-${tag}`;
    await page.getByPlaceholder('message…').fill(`Reply with exactly: ${msg}`);
    await page.getByRole('button', { name: 'send', exact: true }).tap();
    await expect(page.getByText(msg, { exact: true }).last()).toBeVisible({ timeout: 180_000 });
    await shot(page, '10-copy-session');
    expect(inConversation('claude', id, msg), 'the terminal\'s conversation is untouched').toBe(false);
    // the copy: another Claude Code conversation in that folder (made once; tapping again reuses it)
    const inCopy = execFileSync(
      'python3',
      ['-c', `import glob,sys; print(sum(sys.argv[2] in open(p).read() for p in glob.glob('${HOME}/.claude/projects/*cc-live-scratch/*.jsonl') if sys.argv[1] not in p))`, id, msg],
      { encoding: 'utf8' }
    ).trim();
    expect(Number(inCopy), 'the reply is in the copy').toBe(1);
    expect(Number(claudeTranscripts()) - Number(before), 'at most one new conversation').toBeLessThanOrEqual(1);
  } finally {
    try {
      process.kill(-tui.pid!, 'SIGTERM');
    } catch {
      /* gone */
    }
    stopTerminal(`[c]laude --resume ${id}`);
  }
});

test('while it works here, messages typed on the phone wait their turn and each is answered once', async ({
  page,
}) => {
  const id = IDS.claude;
  test.skip(!id, 'no scratch Claude Code conversation');
  stopTerminal(`[c]laude --resume ${id}`);
  await expect.poll(() => liveOf(page, id), { timeout: 30_000 }).toBeNull();
  await page.goto(href('claude', id));
  const box = page.getByTestId('cc-continue');
  await expect(box).toBeVisible({ timeout: 20_000 });
  const first = `first-${tag}`;
  const second = `second-${tag}`;
  const third = `third-${tag}`;
  await box.locator('textarea').fill(`Run the shell command \`sleep 12\`, then reply with exactly: ${first}`);
  await box.getByRole('button', { name: 'send' }).tap();
  // bifrost is working on it: the box stays open, a message waits its turn
  await expect(page.getByTestId('cc-status')).toHaveText(/working here/, { timeout: 60_000 });
  await expect(box.locator('textarea')).toBeEnabled();
  await box.locator('textarea').fill(`Reply with exactly: ${second}`);
  await box.getByRole('button', { name: 'send' }).tap();
  // two waiting: each turn sends its OWN message (11-17: they all sent the newest — the third
  // went twice, the second never)
  await box.locator('textarea').fill(`Reply with exactly: ${third}`);
  await box.getByRole('button', { name: 'send' }).tap();
  await expect(page.locator('[data-k="user"][data-pending="queued"]')).toHaveCount(2);
  await shot(page, '11-queued');
  await expect(said(page, first)).toBeVisible({ timeout: 240_000 });
  await expect(said(page, second)).toBeVisible({ timeout: 240_000 });
  await expect(said(page, third)).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('[data-k="user"][data-pending]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(8_000);
  await expect(said(page, third), 'the newest is answered once, not once per message waiting').toHaveCount(1);
  await expect(page.locator('main [role="alert"]')).toHaveCount(0); // the earlier turn's reply was not taken for this one's
  expect(inConversation('claude', id, second)).toBe(true);
  expect(inConversation('claude', id, third)).toBe(true);
});
