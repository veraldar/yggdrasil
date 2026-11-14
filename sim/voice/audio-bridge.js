/* audio-bridge.js — injected into every page of a simulated phone (Playwright addInitScript,
 * before any app script). It turns the page into a phone with a REAL audio path:
 *
 *   mic   getUserMedia({audio}) returns a WebAudio stream fed by the "mic bus": per-turn speech
 *         injected with __vsim.say(wav) (any audio, any time — not one static wav per launch),
 *         an optional noise bed, and an optional echo of the phone's own speaker.
 *   ear   every audio the page plays is captured on the "reply bus": <audio>/<video> elements
 *         (blob/http sources through createMediaElementSource, MediaStream sources such as a
 *         WebRTC remote track through createMediaStreamSource) and, with captureRtc, every
 *         remote audio track of every RTCPeerConnection (the trunk's WebRTC voice path).
 *   log   loud spans of the reply bus (onset/end of speech), mic mute/unmute (track.enabled),
 *         media element events, the app's diag ring (localStorage 'oz-diag'), and the
 *         hands-free UI state, all on the wall clock (Date.now()).
 *
 * Both buses are recorded at 16 kHz mono by an AudioWorklet; __vsim.pull(bus) hands the audio
 * recorded since the previous pull to the rig (base64 int16) and forgets it.
 * Config: the rig replaces the __VSIM_CFG__ token with a JSON object
 *   {noiseDb: -50 | null, noiseColor: 'pink'|'white'|'brown', echo: 0..1, captureRtc: bool,
 *    loudDb: -42}
 */
(function (CFG) {
  if (window.top !== window || window.__vsim) return;
  const RATE = 16000;
  const V = (window.__vsim = {
    cfg: CFG || {},
    events: [], // {t, kind, ...}
    diag: [], // the app's own diag events (voice timeline)
    ui: [], // hands-free UI transitions {t, state}
    spans: { reply: [], mic: [] }, // loud spans {a, b, peak}
    ready: null,
  });
  const now = () => Date.now();
  const ev = (kind, data) => {
    V.events.push(Object.assign({ t: now(), kind }, data || {}));
    if (V.events.length > 4000) V.events.splice(0, 1000);
  };
  const LOUD = Math.pow(10, (V.cfg.loudDb == null ? -42 : V.cfg.loudDb) / 20);

  // ── recorder worklet: posts 2048-frame blocks with their exact start frame ──
  const WORKLET = `
    class Rec extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.f0 = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        const len = ch ? ch.length : 128;
        if (this.n === 0) this.f0 = currentFrame;
        for (let i = 0; i < len; i++) this.buf[this.n++] = ch ? ch[i] : 0;
        if (this.n >= 2048) { this.port.postMessage({ f0: this.f0, d: this.buf }); this.buf = new Float32Array(2048); this.n = 0; }
        return true;
      }
    }
    registerProcessor('vsim-rec', Rec);`;

  let ctx = null;
  function C() {
    if (ctx) {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      return ctx;
    }
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    V.ctx = ctx;
    V.base = now() - ctx.currentTime * 1000; // wall ms of context frame 0
    V.micBus = ctx.createGain();
    V.replyBus = ctx.createGain();
    // the phone hears itself: speaker → mic at `echo` gain (0 = a perfect headset)
    V.echoGain = ctx.createGain();
    V.echoGain.gain.value = Number(V.cfg.echo || 0);
    V.replyBus.connect(V.echoGain);
    V.echoGain.connect(V.micBus);
    // a sink that keeps both buses pulled even when nothing else listens
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    V.micBus.connect(sink);
    V.replyBus.connect(sink);
    if (V.cfg.noiseDb != null) noiseBed(V.cfg.noiseDb, V.cfg.noiseColor || 'pink');
    V.rec = { reply: [], mic: [] };
    V.ready = ctx.audioWorklet
      .addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
      .then(() => {
        for (const bus of ['reply', 'mic']) {
          const n = new AudioWorkletNode(ctx, 'vsim-rec', { numberOfInputs: 1, numberOfOutputs: 0 });
          n.port.onmessage = (m) => onBlock(bus, m.data.f0, m.data.d);
          (bus === 'reply' ? V.replyBus : V.micBus).connect(n);
        }
        ev('recorder-up', { rate: ctx.sampleRate });
      })
      .catch((e) => ev('recorder-failed', { msg: String(e) }));
    ctx.onstatechange = () => ev('ctx-' + ctx.state, {});
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  function noiseBed(db, color) {
    const n = ctx.sampleRate * 4;
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0, max = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      let x = w;
      if (color === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        x = b0 + b1 + b2 + w * 0.1848;
      } else if (color === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        x = last * 3.5;
      }
      d[i] = x;
      max = Math.max(max, Math.abs(x));
    }
    let ss = 0;
    for (let i = 0; i < n; i++) ss += d[i] * d[i];
    const rms = Math.sqrt(ss / n) || 1;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, db / 20) / rms; // the bed's RMS sits at `db` dBFS
    src.connect(g);
    g.connect(V.micBus);
    src.start();
  }

  // 48k blocks → 16k int16 chunks + loud spans
  function onBlock(bus, f0, d) {
    const sr = ctx.sampleRate;
    const step = sr / RATE;
    const outN = Math.floor(d.length / step);
    const out = new Int16Array(outN);
    let ss = 0;
    for (let i = 0; i < outN; i++) {
      const a = Math.floor(i * step);
      let s = 0;
      const k = Math.max(1, Math.floor(step));
      for (let j = 0; j < k; j++) s += d[a + j] || 0;
      s /= k;
      ss += s * s;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    const t = V.base + (f0 / sr) * 1000;
    V.rec[bus].push({ t, d: out });
    const rms = Math.sqrt(ss / Math.max(1, outN));
    if (rms >= LOUD) {
      const sp = V.spans[bus];
      const last = sp[sp.length - 1];
      const tb = t + (d.length / sr) * 1000;
      if (last && t - last.b < 350) {
        last.b = tb;
        last.peak = Math.max(last.peak, rms);
      } else {
        sp.push({ a: t, b: tb, peak: rms });
        if (sp.length > 2000) sp.splice(0, 500);
      }
    }
  }

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ── the rig's API ──────────────────────────────────────────────────────────
  let sayN = 0;
  V.say = async (b64, opts) => {
    C();
    await V.ready;
    const buf = await ctx.decodeAudioData(b64ToBuf(b64));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = (opts && opts.gain) || 1;
    src.connect(g);
    g.connect(V.micBus);
    const id = ++sayN;
    const t0 = now();
    src.start();
    ev('say-start', { id, dur: buf.duration });
    V.saying = { id, t0, dur: buf.duration };
    return new Promise((r) => {
      src.onended = () => {
        g.disconnect();
        const t1 = now();
        ev('say-end', { id });
        if (V.saying && V.saying.id === id) V.saying = null;
        r({ id, t0, t1, dur: buf.duration });
      };
    });
  };
  /** everything a bus recorded since the previous pull (then forgotten) */
  V.pull = (bus) => {
    const ch = V.rec ? V.rec[bus] : [];
    if (!ch.length) return { t0: now(), rate: RATE, n: 0, b64: '' };
    const n = ch.reduce((a, c) => a + c.d.length, 0);
    const all = new Int16Array(n);
    let o = 0;
    for (const c of ch) {
      all.set(c.d, o);
      o += c.d.length;
    }
    const t0 = ch[0].t;
    V.rec[bus] = [];
    return { t0, rate: RATE, n, b64: bytesToB64(new Uint8Array(all.buffer)) };
  };
  V.since = (t) => ({
    now: now(),
    events: V.events.filter((e) => e.t >= t),
    diag: V.diag.filter((e) => e.t >= t),
    ui: V.ui.filter((e) => e.t >= t),
    reply: V.spans.reply.filter((s) => s.b >= t),
    playing: playingNow(),
    uiState: uiState(),
    saying: !!V.saying,
    ctx: ctx ? ctx.state : 'none',
  });
  V.setEcho = (g) => {
    C();
    V.echoGain.gain.value = g;
  };

  // ── mic: every audio-only getUserMedia gets a fresh stream off the mic bus ──
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      if (c && c.audio && !c.video) {
        C();
        const dst = ctx.createMediaStreamDestination();
        V.micBus.connect(dst);
        for (const tr of dst.stream.getAudioTracks()) tr.__vsimMic = true;
        ev('gum', {});
        return dst.stream;
      }
      return orig(c);
    };
  }
  const en = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
  if (en && en.set) {
    Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
      configurable: true,
      get() {
        return en.get.call(this);
      },
      set(v) {
        if (this.__vsimMic && en.get.call(this) !== !!v) ev(v ? 'mic-on' : 'mic-off', {});
        en.set.call(this, v);
      },
    });
  }
  const stop0 = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () {
    if (this.__vsimMic) ev('mic-stop', {});
    return stop0.apply(this, arguments);
  };

  // ── ear: hook every media element the page plays ──────────────────────────
  const hooked = new Set();
  const rtcTracks = new Set();
  let elN = 0;
  function hook(el) {
    if (el.__vsim) return;
    C();
    el.__vsim = ++elN;
    try {
      if (el.srcObject instanceof MediaStream) {
        const tracks = el.srcObject.getAudioTracks();
        if (tracks.length && !tracks.every((t) => rtcTracks.has(t.id))) {
          ctx.createMediaStreamSource(el.srcObject).connect(V.replyBus); // native playback stays
        }
      } else {
        const s = ctx.createMediaElementSource(el); // reroutes: play it out AND record it
        s.connect(ctx.destination);
        s.connect(V.replyBus);
      }
    } catch (e) {
      ev('hook-failed', { el: el.__vsim, msg: String(e) });
    }
    hooked.add(el);
    for (const n of ['playing', 'pause', 'ended', 'ratechange', 'error', 'stalled', 'waiting', 'emptied', 'abort', 'suspend'])
      el.addEventListener(n, () => ev('media-' + n, { el: el.__vsim, rate: el.playbackRate, at: +el.currentTime.toFixed(2) }));
  }
  const play0 = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      hook(this);
    } catch (e) {
      ev('hook-failed', { msg: String(e) });
    }
    return play0.apply(this, arguments);
  };
  function playingNow() {
    for (const el of hooked) if (!el.paused && !el.ended && el.readyState > 2) return true;
    return false;
  }

  // the trunk's voice path: replies may arrive as a WebRTC remote track
  if (V.cfg.captureRtc && window.RTCPeerConnection) {
    const PC = window.RTCPeerConnection;
    const Wrapped = function (...a) {
      const pc = new PC(...a);
      pc.addEventListener('track', (e) => {
        if (e.track.kind !== 'audio') return;
        C();
        rtcTracks.add(e.track.id);
        ctx.createMediaStreamSource(new MediaStream([e.track])).connect(V.replyBus);
        ev('rtc-track', { id: e.track.id });
      });
      return pc;
    };
    Wrapped.prototype = PC.prototype;
    Object.setPrototypeOf(Wrapped, PC);
    window.RTCPeerConnection = Wrapped;
  }

  // ── the app's own voice timeline: its diag ring lives in localStorage ──────
  let lastDiag = null; // the newest event already taken (several share one millisecond)
  const set0 = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'oz-diag') {
      try {
        const arr = JSON.parse(v);
        let i = -1;
        if (lastDiag)
          for (let j = arr.length - 1; j >= 0; j--)
            if (arr[j].t === lastDiag.t && arr[j].msg === lastDiag.msg && arr[j].kind === lastDiag.kind) {
              i = j;
              break;
            }
        const fresh = i >= 0 ? arr.slice(i + 1) : arr.filter((e) => !lastDiag || e.t >= lastDiag.t);
        for (const e of fresh) if (/voice|tts|speech|free|first-turn/i.test(e.kind + ' ' + e.msg)) V.diag.push(e);
        if (arr.length) lastDiag = arr[arr.length - 1];
        if (V.diag.length > 3000) V.diag.splice(0, 1000);
      } catch {
        /* not ours */
      }
    }
    return set0.apply(this, arguments);
  };

  // ── hands-free UI state (bifrost's MAIN page; 'n/a' elsewhere) ─────────────
  function uiState() {
    const q = (s) => document.querySelector(s);
    const strip = q('[data-testid="free-strip"]');
    const deck = !!q('.oz-rate');
    const paused = !!q('[aria-label="resume speech"]');
    let rate = '1';
    try {
      rate = localStorage.getItem('oz-tts-rate') || '1';
    } catch {
      /* private */
    }
    const cyc = !strip
      ? 'off'
      : q('[data-testid="free-exit"]')
        ? 'listening'
        : strip.querySelector('.oz-bars')
          ? 'speaking'
          : strip.textContent.includes('○')
            ? 'connecting'
            : 'working';
    return `${cyc}|${deck ? (paused ? 'paused' : 'deck') : 'nodeck'}@${rate}`;
  }
  let lastUi = '';
  setInterval(() => {
    let s = '';
    try {
      s = uiState();
    } catch {
      return;
    }
    if (s !== lastUi) {
      lastUi = s;
      V.ui.push({ t: now(), state: s });
      if (V.ui.length > 3000) V.ui.splice(0, 1000);
    }
  }, 200);

  // the context starts with the page (autoplay policy is lifted by the rig's flags)
  try {
    C();
  } catch (e) {
    ev('ctx-failed', { msg: String(e) });
  }
})(__VSIM_CFG__);
