// engine.worker.js — GZDoom engine running in a Web Worker with OffscreenCanvas.
//
// The single-threaded baseline (see index-singlethread.html) stop-motions
// because emscripten_sleep(0) yields drain into the main thread's microtask
// queue and Chrome's compositor never gets a paint slot. Moving the engine off
// the main thread lets the compositor pull frames from the OffscreenCanvas at
// vsync regardless of how busy the engine is. That's the unlock.
//
// Audio: emscripten's OpenAL bridge checks `globalThis.AudioContext` in
// `alcOpenDevice` and returns NULL when absent. Workers have no AudioContext,
// so audio degrades to silent — acceptable for the MVP (per the 2026-05-15
// perf handoff; audio re-routing is follow-up work).

'use strict';

// ---------------------------------------------------------------------------
// 1. DOM SHIMS
//
// emscripten's SDL2 port reaches for `window`, `document`, `location`, and
// `navigator`. None exist in a DedicatedWorker. Provide just enough surface to
// avoid TypeErrors at engine boot. Anything not stubbed here will throw the
// first time the engine touches it — we'll patch as bugs surface.
// ---------------------------------------------------------------------------

// Instrumented EventTarget shim — logs when listeners are added so we can
// see exactly where emscripten/SDL2 attached its input handlers.
const _attachLog = [];
function makeEventTarget(label) {
  const map = new Map(); // type -> Set<listener>
  const target = {
    __label: label,
    __listenerCounts: () => Object.fromEntries([...map].map(([t, s]) => [t, s.size])),
    addEventListener(type, fn, opts) {
      if (!fn) return;
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      _attachLog.push({ on: label, type, capture: !!(opts && opts.capture || opts === true) });
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      const list = map.get(evt.type);
      if (!list || list.size === 0) return true;
      // Real EventTarget.dispatchEvent populates `target` and `currentTarget`
      // for the duration of dispatch. Our shim objects aren't real EventTargets,
      // so emscripten listeners reading `e.target.id` crashed (target was null).
      // Override the read-only properties for the duration of the dispatch.
      try {
        Object.defineProperty(evt, 'target',        { value: target, configurable: true });
        Object.defineProperty(evt, 'currentTarget', { value: target, configurable: true });
        Object.defineProperty(evt, 'srcElement',    { value: target, configurable: true });
      } catch (_) {}
      for (const fn of [...list]) {
        try { fn.call(target, evt); } catch (e) {
          self.postMessage({ type: 'log', stream: 'stderr',
            msg: '[worker] listener threw for ' + evt.type + ': ' + (e && e.message) });
        }
      }
      return !evt.defaultPrevented;
    },
  };
  return target;
}

// Pointer-lock state lives on `document`. Engine reads
// `document.pointerLockElement` to decide whether to consume mouse-look deltas.
const docTarget = makeEventTarget('document');
const winTarget = makeEventTarget('window');

// Build the `document` shim. Some methods (createElement, getElementById)
// MUST return sensible objects — emscripten's SDL2 setup probes them.
// `id`/`nodeName` — emscripten focus/blur/etc. handlers read `e.target.id` and
// `e.target.nodeName` when reporting events. Provide them so handlers don't NPE.
const documentShim = Object.assign(docTarget, {
  id: '',
  nodeName: '#document',
  // emscripten calls getElementById('canvas') in autoResumeAudioContext (which
  // we don't care about) and in a couple of GL helpers. Return our canvas when
  // asked for 'canvas', null otherwise.
  getElementById(id) {
    if (id === 'canvas' && self.__moduleCanvas) return self.__moduleCanvas;
    return null;
  },
  querySelector(sel) {
    if (sel === '#canvas' || sel === 'canvas') return self.__moduleCanvas || null;
    return null;
  },
  createElement(tag) {
    const t = String(tag || '').toLowerCase();
    // SDL_CreateColorCursor (EM_ASM at gzdoom.js:1141602) does
    // `document.createElement('canvas')` then `getContext('2d')` to render a
    // pixel-data cursor. Returning a real OffscreenCanvas lets that path work.
    if (t === 'canvas') {
      const c = new OffscreenCanvas(1, 1);
      // Some emscripten paths assign `c.style`; give it a soft target.
      try { c.style = {}; } catch (_) {}
      // SDL_CreateColorCursor stores the result of `canvas.toDataURL('image/png')`.
      // OffscreenCanvas doesn't have toDataURL (only convertToBlob, which is async).
      // In our pointer-lock setup the cursor data URL is stored but never rendered
      // as a CSS cursor (no DOM cursor in the worker), so an empty data URL works.
      try { c.toDataURL = () => 'data:image/png;base64,'; } catch (_) {}
      return c;
    }
    // Anything else — inert stub.
    return { tagName: t.toUpperCase(), style: {}, addEventListener(){}, removeEventListener(){}, appendChild(){} };
  },
  // Pointer-lock surface. We mutate `pointerLockElement` from main-side input
  // forwarding when the canvas enters / exits pointer lock on the real DOM.
  pointerLockElement: null,
  // Visibility / focus. Engine pauses gametics on visibilitychange.
  visibilityState: 'visible',
  hidden: false,
  hasFocus() { return true; },
  // body — emscripten uses `document.body?.requestPointerLock` as a *feature
  // probe* to decide whether to register a pointerlockchange callback. If
  // it's falsy, the callback is never registered and the engine never learns
  // the pointer locked → SDL2 keeps mouse in absolute (cursor) mode and view
  // rotation never happens. Provide the same surface a real HTMLBodyElement
  // has so the probe passes.
  body: {
    appendChild() {}, removeChild() {}, style: {},
    requestPointerLock() {},
    requestFullscreen() { return Promise.reject(new Error('blocked')); },
    addEventListener() {}, removeEventListener() {},
  },
  documentElement: {
    style: {}, clientWidth: 320, clientHeight: 200,
    requestPointerLock() {},
    requestFullscreen() { return Promise.reject(new Error('blocked')); },
  },
  // Some emscripten paths probe `document.exitPointerLock`. Make it a noop.
  exitPointerLock() {},
});

const windowShim = Object.assign(winTarget, {
  id: '',
  nodeName: '#window',
  // emscripten's openal bridge does `var AudioContext = window.AudioContext || window.webkitAudioContext`
  // and the `_alcOpenDevice` check uses globalThis. Leave both undefined so the
  // null-device fallback kicks in (audio is silent — by design for MVP).
  AudioContext: undefined,
  webkitAudioContext: undefined,
  innerWidth: 320,
  innerHeight: 200,
  devicePixelRatio: 1,
  document: documentShim,
  // Some emscripten helpers reach for `performance` and `console` via window —
  // workers have both globally, but the lookup chain `window.performance` would
  // be undefined without forwarding.
  performance,
  console,
  navigator: self.navigator,
  location: { href: '/', search: '', protocol: 'https:' },
  // The single-threaded harness wrapped requestAnimationFrame. In a worker,
  // rAF doesn't exist by default. Provide a Promise-resolved-microtask fallback
  // so anything that calls rAF gets serviced — but it won't be vsync-paced.
  // The engine doesn't use rAF under asyncify/JSPI; this is just a safety net.
  requestAnimationFrame(cb) {
    const id = ++rafCounter;
    Promise.resolve().then(() => cb(performance.now()));
    return id;
  },
  cancelAnimationFrame() {},
});

// Install on globalThis so unqualified `document.X` and `window.X` work.
// NOTE: `self.location` is read-only in a worker (WorkerLocation), so don't
// reassign it — emscripten reads location.href via the native one, which has
// the same shape. windowShim.location stays for window.location.X chains.
self.window = windowShim;
self.document = documentShim;

// ---------------------------------------------------------------------------
// AUDIO SHIM
//
// Emscripten's OpenAL bridge (library_openal.js, baked into gzdoom.js) needs
// a working `AudioContext` constructor in worker scope or `alcOpenDevice`
// returns NULL and the engine falls back to nosound. AudioContext isn't
// available in DedicatedWorkerGlobalScope (main thread only per spec), so we
// shim it.
//
// Strategy: capture audio data at `source.start()` (the moment openal hands a
// filled AudioBuffer to Web Audio for playback) and post the int16-equivalent
// PCM to main, where a real AudioContext replays via a real BufferSourceNode
// chain. Main is the thing actually wired to speakers; worker just produces
// data.
//
// What this misses (acceptable trade for MVP audio):
// - 3D positional audio (panner nodes are stubbed; everything plays stereo)
// - Doppler / cone gain (skipped)
// - Param automation (setValueAtTime curves applied at value-set time only)
// - playbackRate scrubbing during playback (snapshot at start)
//
// What this gets right:
// - Music (long-running buffered stream from ZMusic ADL OPL3 synth)
// - SFX (one-shot buffer playback)
// - Gain control (master gain + per-source gain)
// - Looping (passes loop/loopStart/loopEnd through)
// - Timing alignment (start(when) honored via AudioContext-time arithmetic)
let _audioId = 1;
const _audioCtxStartWall = performance.now() / 1000;

class _FakeAudioParam {
  constructor(initial) { this.value = initial; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  setValueCurveAtTime() { return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}

class _FakeAudioBuffer {
  constructor(channels, frames, sampleRate) {
    this._id = _audioId++;
    this.numberOfChannels = channels;
    this.length = frames;
    this.sampleRate = sampleRate;
    this.duration = frames / sampleRate;
    this._channels = [];
    for (let c = 0; c < channels; c++) this._channels.push(new Float32Array(frames));
    // openal sets these as custom props for loop point handling
    this._loopStart = 0;
    this._loopEnd = 0;
  }
  getChannelData(c) { return this._channels[c]; }
  copyToChannel(src, channel, offset) {
    this._channels[channel].set(src, offset || 0);
  }
  copyFromChannel(dst, channel, offset) {
    const c = this._channels[channel];
    for (let i = 0; i < dst.length; i++) dst[i] = c[(offset || 0) + i] || 0;
  }
}

class _FakeGainNode {
  constructor() {
    this._id = _audioId++;
    this.gain = new _FakeAudioParam(1);
    this._connectedTo = null;
  }
  connect(target) {
    this._connectedTo = target;
    self.postMessage({ audio: 'connect', src: this._id, dst: target ? target._id : -1, dstKind: target && target._kind });
    return target;
  }
  disconnect() {
    self.postMessage({ audio: 'disconnect', src: this._id });
    this._connectedTo = null;
  }
}

class _FakePannerNode {
  constructor() {
    this._id = _audioId++;
    this._connectedTo = null;
    this.positionX = new _FakeAudioParam(0);
    this.positionY = new _FakeAudioParam(0);
    this.positionZ = new _FakeAudioParam(0);
    this.orientationX = new _FakeAudioParam(1);
    this.orientationY = new _FakeAudioParam(0);
    this.orientationZ = new _FakeAudioParam(0);
    this.panningModel = 'HRTF';
    this.distanceModel = 'inverse';
    this.refDistance = 1; this.maxDistance = 10000; this.rolloffFactor = 1;
    this.coneInnerAngle = 360; this.coneOuterAngle = 360; this.coneOuterGain = 0;
  }
  setPosition() {} setOrientation() {} setVelocity() {}
  connect(target) { this._connectedTo = target; return target; }
  disconnect() { this._connectedTo = null; }
}

class _FakeBufferSource {
  constructor() {
    this._id = _audioId++;
    this._buffer = null;
    this._connectedTo = null;
    this.playbackRate = new _FakeAudioParam(1);
    this.detune = new _FakeAudioParam(0);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this._duration = 0;
    this._startOffset = 0;
    this._skipCount = 0;
    this._started = false;
    this._stopped = false;
    this.onended = null;
  }
  get buffer() { return this._buffer; }
  set buffer(b) { this._buffer = b; }
  connect(target) {
    this._connectedTo = target;
    return target;
  }
  disconnect() { this._connectedTo = null; }
  start(when, offset, duration) {
    if (this._started) return;
    this._started = true;
    const buf = this._buffer;
    if (!buf) return;
    // Pack channels for transfer. We slice to detach our local copy (so engine
    // can reuse the buffer for the next playback without our pending message
    // seeing stale data).
    const ch0 = new Float32Array(buf._channels[0]);
    const ch1 = buf._channels[1] ? new Float32Array(buf._channels[1]) : null;
    // Resolve gain by walking the connect chain — typical openal pattern is
    // BufferSource -> GainNode -> destination (or BufferSource -> Panner -> GainNode -> destination).
    let gain = 1;
    let node = this._connectedTo;
    while (node) {
      if (node.gain && typeof node.gain.value === 'number') gain *= node.gain.value;
      node = node._connectedTo;
    }
    self.postMessage({
      audio: 'play',
      sourceId: this._id,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      ch0, ch1,
      when: when || 0,
      offset: offset || 0,
      duration: duration === undefined ? -1 : duration,
      loop: !!this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      playbackRate: this.playbackRate.value,
      gain,
    }, ch1 ? [ch0.buffer, ch1.buffer] : [ch0.buffer]);
  }
  stop(when) {
    if (this._stopped) return;
    this._stopped = true;
    self.postMessage({ audio: 'stop', sourceId: this._id, when: when || 0 });
  }
  addEventListener() {} removeEventListener() {}
}

class _FakeAudioListener {
  constructor() {
    this.positionX = new _FakeAudioParam(0);
    this.positionY = new _FakeAudioParam(0);
    this.positionZ = new _FakeAudioParam(0);
    this.forwardX = new _FakeAudioParam(0);
    this.forwardY = new _FakeAudioParam(0);
    this.forwardZ = new _FakeAudioParam(-1);
    this.upX = new _FakeAudioParam(0);
    this.upY = new _FakeAudioParam(1);
    this.upZ = new _FakeAudioParam(0);
  }
  setPosition() {} setOrientation() {} setVelocity() {}
}

class _FakeAudioContext {
  constructor(opts) {
    this._id = _audioId++;
    this.sampleRate = (opts && opts.sampleRate) || 44100;
    this.state = 'running';
    this.destination = { _id: -1, _kind: 'destination', connect() {}, disconnect() {} };
    this.listener = new _FakeAudioListener();
    self.postMessage({ audio: 'ctx-new', id: this._id, sampleRate: this.sampleRate });
  }
  get currentTime() {
    return performance.now() / 1000 - _audioCtxStartWall;
  }
  createBuffer(channels, frames, sampleRate) { return new _FakeAudioBuffer(channels, frames, sampleRate); }
  createBufferSource() { return new _FakeBufferSource(); }
  createGain() { return new _FakeGainNode(); }
  createPanner() { return new _FakePannerNode(); }
  createStereoPanner() { return new _FakeGainNode(); /* close enough */ }
  createDelay() { return new _FakeGainNode(); }
  createBiquadFilter() { return new _FakeGainNode(); }
  createDynamicsCompressor() { return new _FakeGainNode(); }
  createAnalyser() { return new _FakeGainNode(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  addEventListener() {} removeEventListener() {}
  decodeAudioData(arrayBuf, success, fail) {
    // Best-effort stub — engine doesn't typically call this for music/SFX
    // (which come through openal buffer queue, not Web Audio decode).
    const reject = new Error('decodeAudioData stub — no decoder in worker');
    if (typeof fail === 'function') fail(reject);
    return Promise.reject(reject);
  }
}

self.AudioContext = _FakeAudioContext;
self.webkitAudioContext = _FakeAudioContext;
windowShim.AudioContext = _FakeAudioContext;
windowShim.webkitAudioContext = _FakeAudioContext;

// `screen` is a window-only global. emscripten_get_screen_size reads
// `screen.width` and `screen.height` during I_InitGraphics. Provide our own
// — the engine just needs SOMETHING here, the value is mostly used to clamp
// "fullscreen" video modes which we never enter.
self.screen = self.screen || {
  width: 1920, height: 1080,
  availWidth: 1920, availHeight: 1080,
  colorDepth: 24, pixelDepth: 24,
};
windowShim.screen = self.screen;

// `localStorage` is not available in DedicatedWorker. emscripten's
// SDL_GetPrefPath / IDBFS may probe for it. Provide an in-memory stub so
// nothing throws — savegame persistence is out of scope for the smoke harness.
const _lsStore = new Map();
self.localStorage = self.localStorage || {
  getItem(k) { return _lsStore.has(k) ? _lsStore.get(k) : null; },
  setItem(k, v) { _lsStore.set(String(k), String(v)); },
  removeItem(k) { _lsStore.delete(k); },
  clear() { _lsStore.clear(); },
  key(i) { return [..._lsStore.keys()][i] || null; },
  get length() { return _lsStore.size; },
};
windowShim.localStorage = self.localStorage;
// matchMedia is sometimes consulted for `prefers-color-scheme` etc. — never
// matches in our shim.
windowShim.matchMedia = (q) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){} });

let rafCounter = 0;

// ---------------------------------------------------------------------------
// 2. CANVAS WRAP
//
// OffscreenCanvas IS an EventTarget and supports getContext('webgl2'), but
// it's missing DOM-only properties the SDL2 port touches: `style`,
// `clientWidth`, `clientHeight`, `getBoundingClientRect`, `focus()`,
// `requestPointerLock()`, etc. We monkey-patch them onto the instance.
//
// We do NOT proxy the OffscreenCanvas — emscripten's `instanceof` checks and
// canvas-identity lookups (`Module.canvas === <result of registration>`) rely
// on real-identity, and proxies break those.
// ---------------------------------------------------------------------------

// Backbuffer pin: defaults to 320x200 (Doom's true native res). Configurable
// via boot message {pinW, pinH} so the smoke harness can sweep canvas sizes
// for perf testing. SBARINFO + menu coords were authored against 320x200;
// larger backbuffers render the world correctly but UI elements stay at
// their authored size unless uiscale/st_scale cvars are bumped.
let PIN_W = 320, PIN_H = 200;

function instrumentCanvasAddListener(canvas) {
  const origAdd = canvas.addEventListener.bind(canvas);
  canvas.addEventListener = function (type, fn, opts) {
    _attachLog.push({ on: 'canvas', type, capture: !!(opts && opts.capture || opts === true) });
    return origAdd(type, fn, opts);
  };
}

function augmentOffscreenCanvas(canvas) {
  const styleStub = new Proxy({}, {
    get(t, prop) { return t[prop] !== undefined ? t[prop] : ''; },
    set(t, prop, v) { t[prop] = v; return true; },
  });
  // OffscreenCanvas in Chrome is fairly permissive about adding own properties.
  // Where direct assignment fails, fall back to defineProperty with configurable.
  function pin(name, getter, setter) {
    try {
      Object.defineProperty(canvas, name, {
        configurable: true,
        get: getter,
        set: setter || (() => {}),
      });
    } catch (_) {
      // best effort — if defineProperty refuses, the engine usually still works
    }
  }
  // Force backbuffer to the pinned size, then trap further writes.
  try { canvas.width = PIN_W; canvas.height = PIN_H; } catch (_) {}
  let _w = PIN_W, _h = PIN_H;
  const origDescW = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), 'width');
  const origDescH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), 'height');
  if (origDescW && origDescH && origDescW.set && origDescH.set) {
    pin('width',
      () => origDescW.get.call(canvas),
      (v) => {
        if (v !== PIN_W) self.postMessage({ type: 'log', stream: 'stderr',
          msg: '[worker] canvas-pin: clamping width=' + v + ' -> ' + PIN_W });
        origDescW.set.call(canvas, PIN_W);
      });
    pin('height',
      () => origDescH.get.call(canvas),
      (v) => {
        if (v !== PIN_H) self.postMessage({ type: 'log', stream: 'stderr',
          msg: '[worker] canvas-pin: clamping height=' + v + ' -> ' + PIN_H });
        origDescH.set.call(canvas, PIN_H);
      });
  }
  try { canvas.style = styleStub; } catch (_) { pin('style', () => styleStub); }
  pin('clientWidth',  () => canvas.width);
  pin('clientHeight', () => canvas.height);
  pin('offsetWidth',  () => canvas.width);
  pin('offsetHeight', () => canvas.height);
  pin('scrollWidth',  () => canvas.width);
  pin('scrollHeight', () => canvas.height);
  pin('clientTop',    () => 0);
  pin('clientLeft',   () => 0);
  pin('offsetTop',    () => 0);
  pin('offsetLeft',   () => 0);
  pin('parentNode',   () => documentShim.body);
  pin('ownerDocument',() => documentShim);
  canvas.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: canvas.width, bottom: canvas.height,
             width: canvas.width, height: canvas.height };
  };
  // Focus / pointer-lock are real-DOM-only — these noops just keep emscripten
  // happy. Real pointer-lock happens on the main-side canvas; we just route
  // mouse-delta events from main and rely on the engine's `m_use_mouse=1` path.
  canvas.focus = function () {};
  canvas.blur = function () {};
  canvas.requestPointerLock = function () {};
  canvas.requestFullscreen = function () { return Promise.reject(new Error('blocked')); };
  // tagName for `instanceof`-fallback checks in libraries that read it.
  if (!('tagName' in canvas)) {
    pin('tagName', () => 'CANVAS');
    pin('nodeName', () => 'CANVAS');
  }
}

// ---------------------------------------------------------------------------
// 3. FRAME-STAT TELEMETRY HOOK
//
// Hook the WebGL2 context's `bindFramebuffer` after engine boot to count
// frames the same way the single-threaded harness did: count transitions from
// a non-default FB binding back to the default (canvas) — that's the canonical
// "frame end / present pass" moment. Post stats to main on a 200ms cadence.
// ---------------------------------------------------------------------------

const fg = {
  ts: new Float64Array(600),
  head: 0,
  total: 0,
  lastBoundWasNonDefault: false,
  drawCalls: 0,
};

function installGLHook(canvas) {
  // Wrap getContext so we hook the GL context the engine creates. Note that
  // emscripten registers the context via its own `emscripten_webgl_create_context`
  // path which eventually calls `canvas.getContext('webgl2', ...)`.
  const orig = canvas.getContext.bind(canvas);
  canvas.getContext = function (type, attrs) {
    const ctx = orig(type, attrs);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      const origBindFB = ctx.bindFramebuffer.bind(ctx);
      const FB_TARGET = ctx.FRAMEBUFFER;
      ctx.bindFramebuffer = function (target, fb) {
        const isDefault = (fb === null || fb === 0);
        if (isDefault && fg.lastBoundWasNonDefault && target === FB_TARGET) {
          const now = performance.now();
          fg.ts[fg.head] = now;
          fg.head = (fg.head + 1) % fg.ts.length;
          fg.total++;
        }
        fg.lastBoundWasNonDefault = !isDefault;
        return origBindFB(target, fb);
      };
      const wrapDraw = (name) => {
        const o = ctx[name];
        if (typeof o !== 'function') return;
        ctx[name] = function () { fg.drawCalls++; return o.apply(ctx, arguments); };
      };
      ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements']
        .forEach(wrapDraw);
      const origClear = ctx.clear.bind(ctx);
      ctx.clear = function (mask) { fg.drawCalls++; return origClear(mask); };
    }
    return ctx;
  };
}

// Telemetry pump: every 100ms, ship a window of recent frame intervals plus
// 1-second-window aggregate metrics (instantaneous FPS, pct60/pct70 targets,
// min/max) so the perf HUD can react to changes faster than the slow-EMA.
let telemTimer = null;
let lastSentTotal = 0;
function startTelemetry() {
  if (telemTimer) return;
  telemTimer = setInterval(() => {
    const now = performance.now();
    const frames = fg.total - lastSentTotal;
    lastSentTotal = fg.total;
    // Collect last N timestamps for the frame graph (N up to ring capacity).
    const N = Math.max(0, Math.min(fg.ts.length, fg.total));
    const recent = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (fg.head - 1 - i + fg.ts.length) % fg.ts.length;
      recent[N - 1 - i] = fg.ts[a];
    }

    // 1-second-window aggregate metrics — only the frames whose timestamp is
    // within the last 1000ms. Gives instantaneous reaction to perf changes.
    const oneSecAgo = now - 1000;
    let win1sCount = 0, win1sMin = Infinity, win1sMax = 0, win1sSum = 0;
    let win1sUnder60 = 0, win1sUnder70 = 0;  // counts of frames meeting target
    for (let i = 1; i < N; i++) {
      const t = recent[i], tp = recent[i - 1];
      if (t >= oneSecAgo) {
        const dt = t - tp;
        if (dt > 0 && dt < 500) {
          win1sCount++;
          win1sSum += dt;
          if (dt < win1sMin) win1sMin = dt;
          if (dt > win1sMax) win1sMax = dt;
          if (dt <= 16.7) win1sUnder60++;
          if (dt <= 14.3) win1sUnder70++;
        }
      }
    }
    const win1sMean = win1sCount > 0 ? win1sSum / win1sCount : 0;
    const win1sFps  = win1sMean > 0 ? 1000 / win1sMean : 0;
    if (!isFinite(win1sMin)) win1sMin = 0;

    const attachSummary = {};
    for (const a of _attachLog) {
      const key = a.on + ':' + a.type;
      attachSummary[key] = (attachSummary[key] || 0) + 1;
    }
    self.postMessage({
      type: 'frame-stats',
      now,
      framesSinceLast: frames,
      totalFrames: fg.total,
      drawCalls: fg.drawCalls,
      tsRing: recent,
      // 1-sec rolling window for fast perf feedback.
      win1s: {
        fps: win1sFps, mean: win1sMean, min: win1sMin, max: win1sMax,
        frames: win1sCount,
        pct60: win1sCount ? (100 * win1sUnder60 / win1sCount) : 0,
        pct70: win1sCount ? (100 * win1sUnder70 / win1sCount) : 0,
      },
      workerDiag: { ...workerDiag, attachSummary, attachCount: _attachLog.length },
    }, [recent.buffer]);
  }, 100);
}

// ---------------------------------------------------------------------------
// 4. MESSAGE PROTOCOL
//
// From main:
//   { type: 'boot', canvas, args, files: {path: Uint8Array}, devMode }
//   { type: 'input', target: 'window'|'document'|'canvas', evType, init }
//   { type: 'resize', width, height }
//   { type: 'pointerlock', locked: bool }
//   { type: 'visibility', state: 'visible'|'hidden' }
//
// To main:
//   { type: 'ready' }                      after onRuntimeInitialized
//   { type: 'log', stream, msg }           print/printErr
//   { type: 'abort', reason }              engine aborted
//   { type: 'frame-stats', ... }           periodic telemetry
//   { type: 'error', message, stack }      worker-side caught exception
// ---------------------------------------------------------------------------

let booted = false;

self.onerror = (e) => {
  self.postMessage({ type: 'error', message: String(e && e.message || e), stack: e && e.error && e.error.stack });
};
self.onunhandledrejection = (e) => {
  self.postMessage({ type: 'error', message: 'unhandledrejection: ' + (e && e.reason && (e.reason.message || e.reason)), stack: e && e.reason && e.reason.stack });
};

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'boot':       return handleBoot(m);
    case 'input':      return handleInput(m);
    case 'resize':     return handleResize(m);
    case 'pointerlock': return handlePointerLock(m);
    case 'visibility': return handleVisibility(m);
    case 'snapshot-request': return handleSnapshotRequest(m);
    default:
      self.postMessage({ type: 'log', stream: 'stderr', msg: '[worker] unknown message type: ' + m.type });
  }
};

function handleBoot(m) {
  if (booted) return;
  booted = true;

  // Override default pin if boot message specifies a larger canvas size.
  if (m.pinW && m.pinH) {
    PIN_W = m.pinW | 0;
    PIN_H = m.pinH | 0;
  }
  // Also update the shims that report dimensions to the engine.
  windowShim.innerWidth = PIN_W;
  windowShim.innerHeight = PIN_H;
  documentShim.documentElement.clientWidth = PIN_W;
  documentShim.documentElement.clientHeight = PIN_H;

  const canvas = m.canvas;
  if (!canvas) {
    self.postMessage({ type: 'log', stream: 'stderr', msg: '[worker] boot: no canvas in message' });
    return;
  }
  instrumentCanvasAddListener(canvas);  // must wrap BEFORE engine attaches
  augmentOffscreenCanvas(canvas);
  installGLHook(canvas);
  self.__moduleCanvas = canvas;

  // (Diagnostic spy listener removed — mouse-look verified working. Spy was
  // adding per-mousemove overhead.)

  // emscripten convention for specialHTMLTargets:
  //   index 0 = invalid (placeholder)
  //   index 1 = EMSCRIPTEN_EVENT_TARGET_DOCUMENT  → document
  //   index 2 = EMSCRIPTEN_EVENT_TARGET_WINDOW    → window
  //   index 3 = EMSCRIPTEN_EVENT_TARGET_SCREEN    → screen (rarely used)
  // SDL2's emscripten port may pass these numeric pseudo-pointers for
  // keyboard/window events, looked up via findEventTarget. Wrong values here
  // were why mouse-look broke — keyboard/mouse listeners were attaching to
  // wrong targets (our augmented canvas instead of document/window).
  self.specialHTMLTargets = [0, documentShim, windowShim, self.screen];

  self.Module = {
    canvas,
    arguments: m.args || [],
    noInitialRun: false,
    preRun: [() => {
      for (const [path, bytes] of Object.entries(m.files || {})) {
        self.Module.FS.writeFile(path, bytes);
      }
      self.Module.FS.chdir('/');
      self.postMessage({ type: 'log', stream: 'stdout',
        msg: '[worker] preRun: wrote ' + Object.keys(m.files || {}).length + ' files into MEMFS' });
    }],
    onRuntimeInitialized() {
      self.postMessage({ type: 'ready' });
      startTelemetry();
      // Tell the engine the window has focus right out of the gate. Without
      // this, SDL2 may consider its window inactive and filter input events
      // (including mouse-motion deltas) out of the queue. In a worker there's
      // no native focus to inherit, so we synthesize one.
      setTimeout(() => {
        windowShim.dispatchEvent(makeEvent('focus', {}));
        documentShim.dispatchEvent(makeEvent('focus', {}));
      }, 0);
    },
    print(...a)    { self.postMessage({ type: 'log', stream: 'stdout', msg: a.join(' ') }); },
    printErr(...a) { self.postMessage({ type: 'log', stream: 'stderr', msg: a.join(' ') }); },
    onAbort(reason) { self.postMessage({ type: 'abort', reason: String(reason) }); },
    setStatus() {},
    // Important: locateFile should resolve relative to the worker's own
    // location (not the page). importScripts already handles `gzdoom.js`;
    // emscripten will fetch `gzdoom.wasm` via this path.
    locateFile(f) { return f; },
  };

  try {
    importScripts('gzdoom.js');
  } catch (err) {
    self.postMessage({ type: 'error',
      message: 'importScripts(gzdoom.js) failed: ' + (err && err.message),
      stack: err && err.stack });
  }
}

// --- Input dispatch -------------------------------------------------------
//
// Main forwards events as plain objects. We synthesize real event instances
// (MouseEvent / KeyboardEvent / WheelEvent are available in DedicatedWorker
// scope in modern browsers) and dispatch them on the correct target. If a
// constructor is unavailable, fall back to a plain object with the same shape
// — emscripten's SDL2 reads properties off the event, not its prototype.

function makeEvent(evType, init) {
  // For Mouse/Wheel events we deliberately use a plain `Event` (not
  // MouseEvent/WheelEvent), then attach properties as own-properties. Reason:
  // `MouseEvent`/`WheelEvent` define `clientX/Y`, `movementX/Y`, `deltaX/Y`,
  // `button`, `buttons` as accessor properties on the prototype, sourced from
  // the C++ event's internal slots. The init-dict path that should populate
  // those slots from constructor options is unreliable in Chrome's worker
  // realm — `new MouseEvent('mousemove', {movementX: 5}).movementX` returns 0.
  // Plain own-properties resolve before prototype lookup, so emscripten's
  // `e.movementX` reads our value as intended.
  if (evType === 'keydown' || evType === 'keyup' || evType === 'keypress') {
    try { return new KeyboardEvent(evType, init); } catch (_) {}
  }
  // Plain Event + own-property assignment for everything else.
  const base = (typeof Event !== 'undefined') ? new Event(evType, { bubbles: true, cancelable: true }) : null;
  const evt = base || { type: evType };
  for (const k in init) {
    try {
      Object.defineProperty(evt, k, { value: init[k], writable: true, configurable: true, enumerable: true });
    } catch (_) {
      try { evt[k] = init[k]; } catch (__) {}
    }
  }
  return evt;
}

// Worker-side mouse-look diagnostics. Counts mousemoves we dispatch and the
// `e.movementX/Y` values an OffscreenCanvas-attached spy listener observes.
// Reported back to main with each frame-stats tick.
const workerDiag = { mmDispatched: 0, mmSpySeen: 0, sumSpyMvX: 0, sumSpyMvY: 0,
                     sumOwnMvX: 0, lastSpyMvX: 0, pointerLockSet: 0 };

function handleInput(m) {
  const evt = makeEvent(m.evType, m.init || {});
  if (m.evType === 'mousemove') {
    workerDiag.mmDispatched++;
    workerDiag.sumOwnMvX += Math.abs(evt.movementX || 0);
  }
  // Always provide preventDefault / stopPropagation no-ops in case the real
  // event lacks them (plain-object fallback path).
  if (typeof evt.preventDefault !== 'function') evt.preventDefault = () => { evt.defaultPrevented = true; };
  if (typeof evt.stopPropagation !== 'function') evt.stopPropagation = () => {};
  if (typeof evt.stopImmediatePropagation !== 'function') evt.stopImmediatePropagation = () => {};

  // Route precisely based on where SDL2 actually attaches each event type
  // (confirmed via the attach-log diagnostic). Wrong target = listener never
  // fires; previously we fanned out to all three to avoid guessing, but that
  // tripled per-event dispatch cost.
  //
  //   canvas: mousedown/mousemove/mouseenter/mouseleave/wheel/touch*
  //   document: mouseup/pointerlockchange/visibilitychange
  //   window: keydown/keyup/keypress/focus/blur/resize
  switch (m.evType) {
    case 'mousedown': case 'mousemove': case 'mouseenter': case 'mouseleave':
    case 'wheel': case 'mousewheel': case 'click': case 'contextmenu':
    case 'touchstart': case 'touchmove': case 'touchend': case 'touchcancel':
      return self.__moduleCanvas ? self.__moduleCanvas.dispatchEvent(evt) : null;
    case 'mouseup':
      return documentShim.dispatchEvent(evt);
    case 'keydown': case 'keyup': case 'keypress':
    case 'focus': case 'blur':
      return windowShim.dispatchEvent(evt);
    default:
      // Fall back to the caller's requested target for anything not classified.
      switch (m.target) {
        case 'window':   return windowShim.dispatchEvent(evt);
        case 'document': return documentShim.dispatchEvent(evt);
        case 'canvas':
        default:
          return self.__moduleCanvas ? self.__moduleCanvas.dispatchEvent(evt) : null;
      }
  }
}

function handleResize(m) {
  if (self.__moduleCanvas) {
    self.__moduleCanvas.width = m.width;
    self.__moduleCanvas.height = m.height;
  }
  windowShim.innerWidth = m.width;
  windowShim.innerHeight = m.height;
  // Fire a resize event so SDL2 picks it up.
  windowShim.dispatchEvent(makeEvent('resize', {}));
}

function handlePointerLock(m) {
  documentShim.pointerLockElement = m.locked ? self.__moduleCanvas : null;
  workerDiag.pointerLockSet = m.locked ? 1 : 0;
  documentShim.dispatchEvent(makeEvent('pointerlockchange', {}));
}

// Worker-side canvas pixel readback. Used by main to verify the renderer is
// actually drawing something other than a clear color when we have no other
// way to see the canvas (preview tool can't screenshot OffscreenCanvas-driven
// canvases). Returns a tiny thumbnail-array of RGB samples + min/max/mean
// luminance so we can detect a black or solid-color frame.
function handleSnapshotRequest(m) {
  try {
    const cv = self.__moduleCanvas;
    if (!cv) { self.postMessage({ type: 'snapshot', error: 'no canvas' }); return; }
    // Read 16x10 sample grid from the WebGL context.
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (!gl) { self.postMessage({ type: 'snapshot', error: 'no GL context' }); return; }
    const w = cv.width, h = cv.height;
    const full = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, full);
    // Build 16x10 thumbnail by sampling.
    const TW = 16, TH = 10;
    const thumb = new Uint8Array(TW * TH * 3);
    let lumMin = 255, lumMax = 0, lumSum = 0, lumN = 0;
    let distinctColors = new Set();
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const sx = Math.floor((x + 0.5) * w / TW);
        const sy = Math.floor((y + 0.5) * h / TH);
        // OpenGL readPixels origin is bottom-left; flip for sensible thumbnail.
        const sIdx = ((h - 1 - sy) * w + sx) * 4;
        const r = full[sIdx], g = full[sIdx + 1], b = full[sIdx + 2];
        const tIdx = (y * TW + x) * 3;
        thumb[tIdx] = r; thumb[tIdx + 1] = g; thumb[tIdx + 2] = b;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < lumMin) lumMin = lum;
        if (lum > lumMax) lumMax = lum;
        lumSum += lum;
        lumN++;
        distinctColors.add((r >> 4 << 8) | (g >> 4 << 4) | (b >> 4));  // quantize to 4-bit/ch
      }
    }
    self.postMessage({
      type: 'snapshot',
      w, h,
      thumbW: TW, thumbH: TH,
      thumb,
      lumMin, lumMax, lumMean: lumSum / Math.max(1, lumN),
      distinctColorCount: distinctColors.size,
    }, [thumb.buffer]);
  } catch (e) {
    self.postMessage({ type: 'snapshot', error: String(e && e.message || e) });
  }
}

function handleVisibility(m) {
  documentShim.visibilityState = m.state;
  documentShim.hidden = (m.state === 'hidden');
  documentShim.dispatchEvent(makeEvent('visibilitychange', {}));
}

self.postMessage({ type: 'log', stream: 'stdout', msg: '[worker] booted, awaiting message...' });
