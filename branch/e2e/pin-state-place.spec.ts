import { type Page, expect, test } from '@playwright/test';

/** The pinned channel's word (components/pin-state.tsx, styles/brand.css § pin) on the S22
 *  (360×780): one square caption, the app's own tag, that never sits on the chrome. 11-23 the
 *  owner's phone showed "end to end" — a round pill fixed at the bottom-left — across MAIN's
 *  name box in the roots. A real state needs a trunk and a pinned channel (trunk-rtc.spec.ts
 *  drives that); here the element is put in each state the way React renders it (data-state
 *  + the words), and its place and look are measured, in a dark and a light world. */

const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

// as components/pin-state.tsx says them — the long ones are the width test
const SAY = {
  connecting: 'pinning…',
  pinned: 'end to end',
  fallback: "via the trunk's TLS",
  reconnecting: 'reconnecting — nothing sent meanwhile',
  refused: 'box key mismatch — nothing sent',
} as const;
type State = keyof typeof SAY;
const STATES = Object.keys(SAY) as State[];

type R = { l: number; t: number; r: number; b: number };

async function show(page: Page, state: State) {
  await page.evaluate(
    ([s, say]) => {
      const el = document.querySelector<HTMLElement>('[data-testid="pin-state"]')!;
      el.hidden = false;
      el.dataset.state = s;
      for (const n of [...el.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove();
      el.append(say);
    },
    [state, SAY[state]] as const
  );
}

/** the indicator, the things it must stay off, and how it is drawn */
const measure = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element | null): R | null => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    };
    const pin = document.querySelector<HTMLElement>('[data-testid="pin-state"]')!;
    const roots = document.querySelector('[data-testid="roots"]');
    // the stop key shows only while MAIN works or talks: measure where its rule puts it
    let stop: R | null = null;
    if (roots && !roots.querySelector('.oz-roots-stop')) {
      const k = document.createElement('button');
      k.className = 'oz-roots-stop';
      roots.append(k);
      stop = r(k);
      k.remove();
    } else stop = r(document.querySelector('.oz-roots-stop'));
    const token = (v: string) => {
      const p = document.createElement('span');
      p.style.color = `var(${v})`;
      pin.append(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    };
    const cs = getComputedStyle(pin);
    return {
      pin: r(pin)!,
      roots: r(roots),
      name: r(document.querySelector('[data-testid="roots-name"]')),
      say: r(document.querySelector('[data-testid="roots-say"]')),
      stop,
      dock: [...document.querySelectorAll('.oz-dock > *')].map(r) as R[],
      phase: r(document.querySelector('.oz-phase')),
      vw: innerWidth,
      oneLine: pin.scrollHeight <= pin.clientHeight + 1,
      cut: pin.scrollWidth > pin.clientWidth + 1,
      look: {
        radius: cs.borderTopLeftRadius,
        borderW: cs.borderTopWidth,
        bg: cs.backgroundColor,
        color: cs.color,
        borderColor: cs.borderTopColor,
        overflow: cs.textOverflow,
      },
      tok: {
        surface: token('--oz-surface'),
        dim: token('--oz-dim'),
        active: token('--oz-active'),
        danger: token('--oz-danger'),
      },
    };
  });

const apart = (a: R, b: R) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;
const inside = (a: R, box: R) => a.l >= box.l && a.r <= box.r && a.t >= box.t && a.b <= box.b;

async function open(page: Page, path: string, world: string) {
  await page.addInitScript((w) => localStorage.setItem('theme', w), world);
  await page.goto(path);
}

function looksLikeTheApp(m: Awaited<ReturnType<typeof measure>>, state: State) {
  expect(m.look.radius, 'square, like every tag here').toBe('0px');
  expect(m.look.borderW, 'one hairline').toBe('1px');
  expect(m.look.bg, 'opaque: nothing under it shows through').toBe(m.tok.surface);
  const ink = state === 'refused' ? m.tok.danger : state === 'fallback' ? m.tok.active : m.tok.dim;
  expect(m.look.color, `${state}: the world's own colour`).toBe(ink);
  expect(m.oneLine, `${state}: one line`).toBe(true);
  if (m.cut) expect(m.look.overflow, `${state}: cut with …`).toBe('ellipsis');
  expect(m.pin.l, 'inside the screen').toBeGreaterThanOrEqual(0);
  expect(m.pin.r, 'inside the screen').toBeLessThanOrEqual(m.vw);
}

// the phone in a dark and a light world, and a wide screen (the roots: a centred 28rem column)
for (const [world, width] of [
  ['aether', 360],
  ['utopia', 360],
  ['aether', 1280],
] as const) {
  test(`front page (${world}, ${width}px): the word sits in the roots, off MAIN's name, words and stop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 500 ? 800 : S22.height });
    await open(page, '/', world);
    await expect(page.getByTestId('roots-name'), 'the roots are up').toBeVisible();
    // no pin (the tailnet, the box's own network): nothing shown
    await expect(page.getByTestId('pin-state'), 'no pin: hidden').toBeHidden();
    for (const state of STATES) {
      await show(page, state);
      await expect(page.getByTestId('pin-state'), `${state}: shown`).toBeVisible();
      const m = await measure(page);
      expect(apart(m.pin, m.name!), `${state}: off MAIN's name box`).toBe(true);
      expect(apart(m.pin, m.say!), `${state}: off the words line`).toBe(true);
      expect(apart(m.pin, m.stop!), `${state}: off the stop key`).toBe(true);
      expect(inside(m.pin, m.roots!), `${state}: inside the roots, not across their edge`).toBe(
        true
      );
      looksLikeTheApp(m, state);
    }
  });
}

test('session page: the word sits in the footer’s empty line, off the dock', async ({ page }) => {
  await open(page, '/session/main', 'aether');
  await expect(page.locator('.oz-dock'), 'the dock is up').toBeVisible();
  for (const state of STATES) {
    await show(page, state);
    const m = await measure(page);
    expect(inside(m.pin, m.phase!), `${state}: inside the footer's words line`).toBe(true);
    for (const k of m.dock) expect(apart(m.pin, k), `${state}: off the dock`).toBe(true);
    looksLikeTheApp(m, state);
  }
});
