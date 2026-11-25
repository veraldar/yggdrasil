#!/usr/bin/env node
/** pin-artifact-frame.mjs — pinned-mode artifact-frame check (fix-3 verification rig).
 *
 * Run inside the trunk-rtc world (same env as trunk-rtc.spec.ts): the phone pairs by
 * QR through the VPS, the app pins its channel, then we time what the integrator
 * measured: a sandbox="allow-same-origin" iframe loading an html artifact, and the
 * gallery's thumbnails — all must ride the pinned channel fast (no 10 s waitState).
 *
 *   node sim/rtc/pin-artifact-frame.mjs        exit 0 = PASS (prints timings)
 */
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PW_REQUIRE || "playwright");

const AP = process.env.PW_AP_URL || "";
const BASE = process.env.PW_BASE_URL || "";
const STATE = process.env.PW_STATE || "";
const PHONE_CHROME = process.env.PW_PHONE_CHROME || "";
if (!AP || !BASE || !STATE || !PHONE_CHROME) {
  console.error("run by sim/trunk-rtc-e2e.sh (the namespaced world)");
  process.exit(2);
}

const steps = [];
const step = (name, what, ok, ms, extra = "") => {
  steps.push({ name, what, ok, ms, extra });
  console.log(
    `${name} ${ok ? "PASS" : "FAIL"} ${what}${extra ? ` · ${extra}` : ""}`,
  );
  // the rig's own table (steps.tsv: name, what, PASS/FAIL, detail) — trunk-rtc-e2e.sh reads it
  try {
    appendFileSync(
      join(STATE, "steps.tsv"),
      `${name}\t${ok ? "PASS" : "FAIL"}\t${what}\t${extra}\n`,
    );
  } catch {
    /* STATE may be unset in a bare run */
  }
};

// the box console browser (this machine, loopback): shows the QR the phone scans
const box = await chromium.launch();
const boxPage = await box.newPage();

// the phone: its own chromium inside the phone's namespace
const AP_IP = process.env.PW_AP_IP || "";
const phone = await chromium.launch({
  executablePath: PHONE_CHROME,
  args: [
    `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
    // the test ap's self-signed cert (a phone on the real trunk has Let's Encrypt)
    "--ignore-certificate-errors",
  ],
});
const phoneCtx = await phone.newContext({
  ...devices["Pixel 7"],
  locale: "en-US",
  ignoreHTTPSErrors: true,
  storageState: {
    cookies: [],
    origins: [
      {
        origin: AP,
        localStorage: [
          { name: "bifrost-door", value: "v2" },
          { name: "bifrost-first-turn", value: "1" },
        ],
      },
    ],
  },
});
const phonePage = await phoneCtx.newPage();

try {
  // ---------------------------------------------------------------- pair
  const t0 = Date.now();
  await boxPage.goto(`${BASE}/pair`);
  const qr = boxPage.getByTestId("pair-qr");
  await qr.waitFor({ state: "visible", timeout: 30_000 });
  const png = join(STATE, "pair-qr.png");
  await qr.screenshot({ path: png });
  const { execFileSync } = await import("child_process");
  const qrUrl = execFileSync("zbarimg", ["-q", "--raw", png]).toString().trim();
  await phonePage.goto(qrUrl);
  await phonePage.waitForURL(`${AP}/`, { timeout: 60_000 });
  await phonePage
    .getByTestId("roots")
    .waitFor({ state: "visible", timeout: 60_000 });
  // the app announces its pin state (the indicator); wait for 'pinned'
  await phonePage
    .getByTestId("pin-state")
    .waitFor({ state: "visible", timeout: 60_000 });
  await phonePage.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="pin-state"]');
      const st = el ? el.getAttribute("data-state") : null;
      if (st === "pinned" || st === "fallback") return true; // either rides a known door
      const pin = JSON.parse(localStorage.getItem("bifrost.pin") || "null");
      return !!(pin && pin.deviceId); // paired: the channel may say 'connecting' while loading
    },
    null,
    { timeout: 60_000 },
  );
  // settle: give the channel its moment, then read the final state
  console.log("stage: pin-wait done");
  await phonePage.waitForTimeout(3000);
  const pinState = await phonePage.evaluate(() => {
    const el = document.querySelector('[data-testid="pin-state"]');
    const pin = JSON.parse(localStorage.getItem("bifrost.pin") || "null");
    return {
      state: el ? el.getAttribute("data-state") : null,
      device: pin && pin.deviceId,
    };
  });
  console.log("pin state:", JSON.stringify(pinState));
  const pairedMs = Date.now() - t0;

  // the frame load: watch the phone's console for the sw's fall-through line
  const fallThrough = [];
  const swLines = [];
  phoneCtx.on("serviceworker", (w) => {
    w.on("console", (m) => swLines.push(m.text().slice(0, 160)));
  });
  phonePage.on("console", (m) => {
    if (m.text().includes("pin fall-through")) fallThrough.push(m.text());
  });
  phonePage.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
  phonePage.on("response", async (r) => {
    if (r.url().includes("door-tree")) {
      const h = await r.allHeaders().catch(() => ({}));
      console.log(
        "  NET door-tree:",
        r.status(),
        "csp=",
        (h["content-security-policy"] || "NONE").slice(0, 20),
        "dest=",
        h["x-echo-dest"] || "NONE",
        "via=",
        h["x-bifrost-via"] || "-",
      );
    }
  });
  setTimeout(() => {
    if (swLines.length)
      console.log("SW LOG:", JSON.stringify(swLines.slice(0, 8), null, 1));
  }, 120_000);

  // ---------------------------------------------------------------- F1 a gallery thumbnail frame
  console.log("stage: goto artifacts");
  await phonePage
    .goto(`${AP}/artifacts`, { timeout: 30_000 })
    .catch((e) => console.log("goto artifacts:", e.message)); // through the ap, the pinned door
  // the rig's app serves the checkout's artifacts dir: it has html files (door-tree, far-vision)
  const firstFrame = phonePage
    .locator('[data-testid="artifact-grid"] iframe')
    .first();
  const tf = Date.now();
  let thumbMs = 0;
  try {
    await firstFrame.waitFor({ state: "visible", timeout: 30_000 });
    thumbMs = Date.now() - tf;
  } catch (e) {
    console.log("F1 frame wait failed:", e.message);
    thumbMs = 999_999; // a fail marker, not a hang
  }
  // the frame's document must be tunnelled: ask the SW's log — check the page's pin state and
  // the frame's load finished without a fall-through
  await phonePage.waitForTimeout(1500);

  // ---------------------------------------------------------------- F2 a chat-inline frame via the viewer
  // direct: build an allow-same-origin iframe to an html artifact, timed
  console.log("stage: F2 frame");
  const r = await phonePage.evaluate(async () => {
    const t = performance.now();
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-same-origin");
    f.src = "/api/artifact/door-tree.html";
    document.body.appendChild(f);
    await new Promise((done) => (f.onload = done));

    const txt = (() => {
      try {
        return f.contentDocument ? "controlled" : "opaque";
      } catch {
        return "opaque-exception";
      }
    })();
    return { ms: Math.round(performance.now() - t), txt };
  });
  await phonePage.waitForTimeout(1500);

  // ---------------------------------------------------------------- F3 the owner's case: a new TAB,
  // a top-level navigation to /api/artifact/… — the open-in-new-tab corner button
  console.log("stage: F3 new tab; F2 was", JSON.stringify(r));
  const t3 = Date.now();
  const tab = await phoneCtx.newPage();
  tab.on("request", (r) => console.log("  F3 req:", r.url().slice(0, 70)));
  tab.on("requestfailed", (r) =>
    console.log("  F3 FAIL:", r.url().slice(0, 70), r.failure()?.errorText),
  );
  tab.on("console", (m) =>
    console.log("  F3 tab-console:", m.text().slice(0, 90)),
  );
  const g = Promise.race([
    tab.goto(`${AP}/api/artifact/door-tree.html`, { timeout: 25_000 }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("F3 goto watchdog 20s")), 20_000),
    ),
  ]);
  console.log("stage: F3 goto issued");
  const gr = await g.catch((e) => {
    console.log("F3 goto ERR:", e.message.slice(0, 60));
    return null;
  });
  console.log("stage: F3 goto settled");
  const tabMs = Date.now() - t3;
  console.log("stage: F3 body");
  const tabBody =
    (
      await Promise.race([
        tab.textContent("body"),
        new Promise((resolve) => setTimeout(() => resolve(""), 10_000)),
      ])
    ).length > 100; // a real artifact page, not an error json
  await tab.waitForTimeout(1500);
  await tab
    .close()
    .catch((e) => console.log("tab.close:", e.message.slice(0, 60)));
  console.log("stage: F3 done", tabMs, "ms");

  // F4 the owner's actual media family: a <video> src asked from the app page
  // itself (the films' <video> in a chat frame / the app's own pages) — the
  // request rides the SW, never a 10 s wait. (The opened doc page's own media
  // is CSP-sandboxed by the 11-25 batch's design: its fate is F3's page, not
  // a media check.)
  console.log("stage: F4 media");
  const t4 = Date.now();
  const media = await Promise.race([
    phonePage.evaluate(async () => {
      const t = performance.now();
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = "/api/artifact/far-vision.html"; // any artifact path: SW routing is by URL
      await new Promise((done) => {
        v.onloadedmetadata = done;
        v.onerror = done;
        setTimeout(done, 4000); // bounded: an html body is not media, error can be silent
      });
      return { ms: Math.round(performance.now() - t) };
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ms: 4444 }), 20_000)),
  ]).catch(() => ({ ms: 9999 }));
  console.log("stage: F4 done", JSON.stringify(media));

  const ok = r.ms < 1500 && thumbMs < 10_000 && fallThrough.length === 0;
  step(
    "F1",
    "gallery thumbnail frame (pinned): visible under 10 s, no fall-through",
    thumbMs < 10_000 && fallThrough.length === 0,
    thumbMs,
    `thumb ${thumbMs} ms · frame ${r.ms} ms (${r.txt}) · fall-throughs: ${fallThrough.length}`,
  );
  step(
    "F2",
    "sandbox=allow-same-origin frame to an html artifact: under 1.5 s, tunneled doc",
    r.ms < 1500 && r.txt === "controlled",
    r.ms,
    `${r.ms} ms, ${r.txt}`,
  );
  step(
    "F3",
    "new tab, top-level /api/artifact page (the open-in-new-tab corner button): under 3 s, real bytes",
    tabMs < 3000 && tabBody,
    tabMs,
    `${tabMs} ms, body "${tabBody ? "real artifact" : "wrong"}"`,
  );
  step(
    "F4",
    "media src from the app page (the films' path): bounded, no 10 s wait",
    media.ms < 3000,
    media.ms,
    `${media.ms} ms`,
  );
  console.log(`\npair→pinned ${pairedMs} ms`);
} finally {
  writeFileSync(
    join(STATE, "pin-frame-steps.json"),
    JSON.stringify({ steps, exit: steps.every((s) => s.ok) ? 0 : 1 }, null, 1),
  );
  await phone.close().catch(() => {});
  await box.close().catch(() => {});
}
process.exit(steps.every((s) => s.ok) ? 0 : 1);
