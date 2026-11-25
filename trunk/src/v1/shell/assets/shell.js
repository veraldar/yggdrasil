// The trunk's pages — vanilla JS, nothing third-party, no inline handlers (CSP script-src 'self').
// One file; each page names itself in <body data-page="…">.
'use strict';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { if (el) el.hidden = !on; };

function say(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('err', 'ok');
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

async function call(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    return { status: 0, data: { error: 'the trunk is not answering — check your connection' } };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, data };
}
const post = (path, body) => call('POST', path, body || {});

// A signed-in call: an expired (or moved) access token is refreshed once; anything else → /login.
async function authed(method, path, body) {
  let r = await call(method, path, body);
  if (r.status === 401 && r.data && r.data.reauth === 'refresh') {
    const f = await post('/t/auth/refresh');
    if (f.status === 200) r = await call(method, path, body);
  }
  if (r.status === 401) {
    location.replace('/login?next=' + encodeURIComponent(location.pathname));
    return null;
  }
  return r;
}

function errText(r, fallback) {
  const d = (r && r.data) || {};
  let t = d.error || fallback || 'something went wrong';
  if (r && r.status === 429 && d.retry_after) t += ' (' + fmtWait(d.retry_after) + ')';
  return t;
}

function fmtWait(s) {
  s = Math.max(0, Math.round(s));
  return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60 ? (s % 60) + ' s' : '') : s + ' s';
}

function mmss(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// The server renders the QR as plain SVG (no inline style, no data: URI).
function putSvg(el, svg) {
  if (!el) return;
  const doc = new DOMParser().parseFromString(svg || '', 'image/svg+xml');
  const node = doc.documentElement;
  el.textContent = '';
  if (node && node.nodeName.toLowerCase() === 'svg') el.appendChild(document.importNode(node, true));
}

function putCodes(el, codes) {
  el.textContent = '';
  for (const c of codes || []) {
    const d = document.createElement('div');
    d.className = 'recovery-code';
    d.textContent = c;
    el.appendChild(d);
  }
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
}

function digitsOnly(v) { return String(v || '').replace(/\D/g, ''); }

// a `next` that stays on this origin
function nextPath() {
  const n = new URLSearchParams(location.search).get('next') || '/';
  return /^\/(?!\/)[^\\]*$/.test(n) && !n.startsWith('/t/') ? n : '/';
}

// ---- /claim ------------------------------------------------------------------------------

async function claimPage() {
  // the agent may open the link in a tab already on /claim: a new fragment is a new claim
  window.addEventListener('hashchange', () => location.reload());
  const ticket = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  const steps = ['c-wait', 'c-approve', 'c-signup', 'c-totp', 'c-codes'];
  const pills = { 'c-wait': 'admin claim', 'c-approve': 'agent claim', 'c-signup': 'admin claim', 'c-totp': '2FA required', 'c-codes': 'claimed ✓' };
  const only = (...ids) => {
    steps.forEach((s) => show($(s), ids.includes(s)));
    if (pills[ids[0]]) $('claim-pill').textContent = pills[ids[0]];
  };
  if (!ticket) { only('c-wait'); return; }
  const info = await post('/t/claim/ticket', { ticket });
  if (info.status === 410) { location.replace('/claim'); return; }
  if (info.status !== 200) {
    only('c-wait');
    say($('c-wait-err'), errText(info, 'this claim link is not valid'), 'err');
    return;
  }
  const d = info.data;
  // the digits the agent verified (display only)
  const slots = $('c-slots');
  slots.textContent = '';
  if (d.code) {
    for (const ch of d.code) {
      const s = document.createElement('span');
      s.className = ch === '-' ? 'slot dash' : 'slot';
      s.textContent = ch === '-' ? '–' : ch;
      slots.appendChild(s);
    }
  } else {
    show(slots, false);
  }
  if (d.via === 'console') {
    $('c-via').textContent = 'server console ✓';
    $('c-approve-lead').textContent = 'This link was made on the server console — confirm to claim admin:';
  }
  let left = d.expires_in;
  const tick = () => { $('c-left').textContent = 'link valid ' + mmss(left); left -= 1; };
  tick();
  setInterval(tick, 1000);

  const toSignup = () => {
    only('c-signup');
    show($('c-ribbon'));
    if (d.pending_email) $('c-email').value = d.pending_email;
    $('c-email').focus();
  };
  if (d.state === 'approved') toSignup(); else only('c-approve');

  $('c-approve-btn').addEventListener('click', async () => {
    busy($('c-approve-btn'), true);
    const r = await post('/t/claim/approve', { ticket });
    busy($('c-approve-btn'), false);
    if (r.status === 200) toSignup(); else say($('c-approve-err'), errText(r), 'err');
  });
  $('c-refuse-btn').addEventListener('click', async () => {
    const r = await post('/t/claim/refuse', { ticket });
    if (r.status === 200) {
      history.replaceState(null, '', '/claim');
      only('c-wait');
      say($('c-wait-err'), 'Refused. The claim code rotated; nothing was created.', 'ok');
    } else {
      say($('c-approve-err'), errText(r), 'err');
    }
  });
  $('c-signup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    busy($('c-signup-btn'), true);
    say($('c-signup-err'), '');
    const r = await post('/t/auth/signup', { ticket, email: $('c-email').value, password: $('c-password').value });
    busy($('c-signup-btn'), false);
    if (r.status !== 200) { say($('c-signup-err'), errText(r), 'err'); return; }
    putSvg($('c-qr'), r.data.qr_svg);
    $('c-secret').textContent = (r.data.secret || '').replace(/(.{4})/g, '$1 ').trim();
    only('c-totp');
    show($('c-ribbon'), false);
    show($('c-ribbon2'));
    $('c-code').focus();
  });
  $('c-totp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    busy($('c-totp-btn'), true);
    const r = await post('/t/auth/totp/confirm', { ticket, code: digitsOnly($('c-code').value) });
    busy($('c-totp-btn'), false);
    if (r.status !== 200) { say($('c-totp-err'), errText(r), 'err'); return; }
    history.replaceState(null, '', '/claim');
    show($('c-ribbon'), false);
    show($('c-ribbon2'), false);
    putCodes($('c-codes-grid'), r.data.recovery_codes);
    only('c-codes');
  });
}

// ---- /login --------------------------------------------------------------------------------

async function loginPage() {
  // a page sent here by an expired (or moved) access token: the refresh cookie (path /t/auth)
  // may still be good — try it once, quietly, before asking for the password
  const f = await post('/t/auth/refresh');
  if (f.status === 200) { location.replace(nextPath()); return; }
  let mode = 'totp';
  const setMode = (m) => {
    mode = m;
    show($('l-code-field'), m === 'totp');
    show($('l-recovery-field'), m === 'recovery');
    (m === 'totp' ? $('l-code') : $('l-recovery')).focus();
  };
  $('l-use-recovery').addEventListener('click', () => setMode('recovery'));
  $('l-use-code').addEventListener('click', () => setMode('totp'));
  let ticket = '';
  const finish = (r) => {
    if (r.data.recovery_codes) {
      putCodes($('l-codes-grid'), r.data.recovery_codes);
      $('l-done').href = nextPath();
      show($('l-signin'), false);
      show($('l-enroll'), false);
      show($('l-codes'));
      return;
    }
    location.replace(nextPath());
  };
  $('l-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    say($('l-err'), '');
    const code = digitsOnly($('l-code').value);
    const rec = $('l-recovery').value.trim();
    busy($('l-btn'), true);
    try {
      if (!ticket) {
        const r = await post('/t/auth/login', { email: $('l-email').value, password: $('l-password').value });
        if (r.status !== 200) { say($('l-err'), errText(r), 'err'); return; }
        ticket = r.data.mfa_ticket;
        if (r.data.enroll) {
          putSvg($('l-qr'), r.data.enroll.qr_svg);
          $('l-secret').textContent = (r.data.enroll.secret || '').replace(/(.{4})/g, '$1 ').trim();
          show($('l-signin'), false);
          show($('l-enroll'));
          $('l-enroll-code').focus();
          return;
        }
      }
      if (mode === 'totp' && code.length !== 6) { say($('l-err'), 'enter the 6-digit code from your authenticator', 'err'); $('l-code').focus(); return; }
      if (mode === 'recovery' && !rec) { say($('l-err'), 'enter one of your recovery codes', 'err'); return; }
      const m = await post('/t/auth/mfa', mode === 'totp' ? { mfa_ticket: ticket, totp: code } : { mfa_ticket: ticket, recovery: rec });
      if (m.status === 200) { finish(m); return; }
      if (m.data && m.data.why === 'ticket') ticket = '';
      say($('l-err'), errText(m), 'err');
    } finally {
      busy($('l-btn'), false);
    }
  });
  $('l-enroll-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const m = await post('/t/auth/mfa', { mfa_ticket: ticket, totp: digitsOnly($('l-enroll-code').value) });
    if (m.status === 200) finish(m); else say($('l-enroll-err'), errText(m), 'err');
  });
  $('l-email').focus();
}

// ---- /account ------------------------------------------------------------------------------

async function accountPage() {
  let pending = null; // an action waiting for step-up
  const load = async () => {
    const r = await authed('GET', '/t/account');
    if (!r) return null;
    const a = r.data;
    $('a-email').textContent = a.account.email || 'account';
    $('a-pw-user').value = a.account.email || '';
    $('a-dev-name').textContent = a.device.name;
    $('a-dev-role').textContent = a.device.role;
    $('a-dev-via').textContent = a.device.created_via + ' · ' + new Date(a.device.created_at).toLocaleDateString();
    const fresh = $('a-dev-fresh');
    if (a.device.fresh) {
      fresh.textContent = 'fresh until ' + new Date(a.device.fresh_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      fresh.className = 'v ok';
    } else {
      fresh.textContent = 'changes need a fresh code';
      fresh.className = 'v warn';
    }
    $('a-totp').textContent = a.totp.enrolled ? 'on · since ' + new Date(a.totp.enrolled_at).toLocaleDateString() : 'not set';
    $('a-recovery').textContent = a.recovery.left + ' of ' + a.recovery.total + ' left';
    $('a-recovery').className = a.recovery.left < 3 ? 'v warn' : 'v';
    return a;
  };
  // run `fn`; when the trunk asks for step-up, ask for a code first and run it again
  const guarded = async (fn) => {
    const r = await fn();
    if (r && r.status === 403 && r.data && r.data.step_up) {
      pending = fn;
      show($('a-stepup'));
      $('a-stepup-code').focus();
      window.scrollTo(0, 0);
      return null;
    }
    return r;
  };
  $('a-stepup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = $('a-stepup-code').value.trim();
    const body = /^\d[\d ]*$/.test(v) ? { totp: digitsOnly(v) } : { recovery: v };
    const r = await authed('POST', '/t/auth/step-up', body);
    if (!r) return;
    if (r.status !== 200) { say($('a-stepup-err'), errText(r), 'err'); return; }
    say($('a-stepup-err'), '');
    $('a-stepup-code').value = '';
    show($('a-stepup'), false);
    await load();
    if (pending) { const fn = pending; pending = null; await fn(); }
  });

  const msg2 = $('a-2fa-msg');
  const resetTotp = async () => {
    const r = await guarded(() => authed('POST', '/t/account/totp/reset'));
    if (!r) return r;
    if (r.status !== 200) { say(msg2, errText(r), 'err'); return r; }
    putSvg($('a-qr'), r.data.qr_svg);
    $('a-secret').textContent = (r.data.secret || '').replace(/(.{4})/g, '$1 ').trim();
    show($('a-codes-box'), false);
    show($('a-totp-box'));
    $('a-totp-code').focus();
    return r;
  };
  $('a-totp-reset').addEventListener('click', () => { pending = null; resetTotp(); });
  $('a-totp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await guarded(() => authed('POST', '/t/account/totp/confirm', { code: digitsOnly($('a-totp-code').value) }));
    if (!r) return;
    if (r.status === 200) {
      show($('a-totp-box'), false);
      say(msg2, 'new authenticator is on — the old one stopped working', 'ok');
      load();
    } else {
      say(msg2, errText(r), 'err');
    }
  });
  const newCodes = async () => {
    const r = await guarded(() => authed('POST', '/t/account/recovery/regenerate'));
    if (!r) return r;
    if (r.status !== 200) { say(msg2, errText(r), 'err'); return r; }
    putCodes($('a-codes-grid'), r.data.recovery_codes);
    show($('a-totp-box'), false);
    show($('a-codes-box'));
    load();
    return r;
  };
  $('a-recovery-new').addEventListener('click', () => newCodes());
  $('a-pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { current: $('a-pw-current').value, new: $('a-pw-new').value };
    const r = await guarded(() => authed('POST', '/t/account/password', body));
    if (!r) return;
    if (r.status === 200) {
      $('a-pw-current').value = '';
      $('a-pw-new').value = '';
      say($('a-pw-msg'), 'password changed', 'ok');
    } else {
      say($('a-pw-msg'), errText(r), 'err');
    }
  });
  $('a-logout').addEventListener('click', async () => {
    await post('/t/auth/logout');
    location.replace('/login');
  });
  await load();
}

// ---- / (signed in, no root yet) and /offline -------------------------------------------------

async function whoami() {
  const r = await authed('GET', '/t/me');
  if (r && r.status === 200) {
    const e = $('e-email') || $('o-email');
    if (e && r.data.account.email) e.textContent = r.data.account.email;
    return r.data;
  }
  return null;
}

async function emptyPage() {
  whoami();
  const poll = async () => {
    const r = await call('GET', '/t/state');
    if (r.status === 200 && r.data.has_roots) {
      $('e-roots').textContent = 'roots 1';
      $('e-listen').textContent = 'connected ✓';
      setTimeout(() => location.reload(), 600);
      return;
    }
    setTimeout(poll, 3000);
  };
  setTimeout(poll, 3000);
}

async function offlinePage() {
  whoami();
  // back to the door as soon as one answers (the trunk sends us here again while none does)
  setTimeout(() => location.replace('/'), 10000);
}

const pages = { claim: claimPage, login: loginPage, account: accountPage, empty: emptyPage, offline: offlinePage };
const run = pages[document.body.dataset.page];
if (run) run();
