// Synthesized Web Audio cues — no sample files. The AudioContext is created
// lazily on the first user gesture; identical cues are capped at 3 voices.
let ctx = null;
let master = null;
let enabled = true;
const voices = new Map(); // cue name -> live voice count
let pad = null; // {osc[], gain, filter}

function ensure() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 18;
  comp.ratio.value = 5;
  master.connect(comp).connect(ctx.destination);
  return ctx;
}

export function unlockAudio() {
  const c = ensure();
  if (c && c.state === "suspended") c.resume();
}

export function setSoundEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) stopPad(0.2);
  if (ctx && master) master.gain.setTargetAtTime(enabled ? 0.5 : 0, ctx.currentTime, 0.05);
}
export const soundEnabled = () => enabled;

function acquire(name) {
  const live = voices.get(name) ?? 0;
  if (live >= 3) return false;
  voices.set(name, live + 1);
  return true;
}
const release = (name) => voices.set(name, Math.max(0, (voices.get(name) ?? 1) - 1));

const rand = (spread = 0.05) => 1 + (Math.random() * 2 - 1) * spread;

function play(name, fn) {
  if (!enabled || !acquire(name)) return;
  const c = ensure();
  if (!c || c.state !== "running") {
    release(name);
    return;
  }
  try {
    fn(c);
  } finally {
    // callers schedule their own release via source.onended
  }
}

// ≈8ms filtered click around 2.2kHz, pitch randomized ±5%.
export function tick() {
  play("tick", (c) => {
    const t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.value = 2200 * rand();
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 6;
    const g = c.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.008);
    osc.connect(bp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.012);
    osc.onended = () => release("tick");
  });
}

// Glass "ting": two detuned sines (1760 / 2637 Hz), ~600ms decay, 3 variants.
export function ting() {
  play("ting", (c) => {
    const t = c.currentTime;
    const v = Math.floor(Math.random() * 3);
    const base = [1760, 2637].map((f) => f * (1 + v * 0.006) * rand(0.012));
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6 + v * 0.08);
    g.connect(master);
    let pending = base.length;
    for (const f of base) {
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.detune.value = (Math.random() - 0.5) * 14;
      const og = c.createGain();
      og.gain.value = f > 2000 ? 0.55 : 1;
      osc.connect(og).connect(g);
      osc.start(t);
      osc.stop(t + 0.75);
      osc.onended = () => --pending === 0 && release("ting");
    }
  });
}

// Low soft thud for deletion: 90Hz sine + short noise burst, 180ms.
export function thud() {
  play("thud", (c) => {
    const t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.16);
    const g = c.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(g).connect(master);
    const len = Math.floor(c.sampleRate * 0.05);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = c.createBufferSource();
    noise.buffer = buf;
    const ng = c.createGain();
    ng.gain.value = 0.12;
    noise.connect(ng).connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
    noise.start(t);
    osc.onended = () => release("thud");
  });
}

// Soft filtered-noise whoosh for rim pulses, ~300ms.
export function pulse() {
  play("pulse", (c) => {
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.3);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 0.28);
    bp.Q.value = 2.5;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.onended = () => release("pulse");
  });
}

// Teletype key click for the boot terminal: shorter and drier than tick.
export function click() {
  play("click", (c) => {
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.006);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2800;
    const g = c.createGain();
    g.gain.value = 0.18;
    src.connect(hp).connect(g).connect(master);
    src.start(t);
    src.onended = () => release("click");
  });
}

// Horizontal scan sweep: airy filtered noise rising then falling, ~0.5s.
export function scan() {
  play("scan", (c) => {
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.5);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 0.22);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.5);
    bp.Q.value = 3.5;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.onended = () => release("scan");
  });
}

// Liquid pour: low noise swell with a gurgle LFO, ~1.1s.
export function pour() {
  play("pour", (c) => {
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 1.1);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    const lfo = c.createOscillator();
    lfo.frequency.value = 9;
    const lfoG = c.createGain();
    lfoG.gain.value = 240;
    lfo.connect(lfoG).connect(lp.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    src.connect(lp).connect(g).connect(master);
    src.start(t);
    lfo.start(t);
    lfo.stop(t + 1.15);
    src.onended = () => release("pour");
  });
}

// Surge warning: two low detuned tones alternating, ~1.4s, calm but clear.
export function warn() {
  play("warn", (c) => {
    const t = c.currentTime;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.06);
    g.gain.setValueAtTime(0.2, t + 1.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    g.connect(master);
    [164.81, 196.0].forEach((f, i) => {
      const osc = c.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const og = c.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.setValueAtTime(0.9, t + i * 0.34);
      og.gain.setValueAtTime(0.9, t + i * 0.34 + 0.28);
      og.gain.setValueAtTime(0, t + i * 0.34 + 0.33);
      osc.connect(og).connect(g);
      osc.start(t);
      osc.stop(t + 1.5);
      osc.onended = () => release("warn");
    });
  });
}

// Recover: soft falling fifth when the tide goes back out.
export function recover() {
  play("recover", (c) => {
    const t = c.currentTime;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    g.connect(master);
    [[261.63, 0], [196.0, 0.18], [329.63, 0.36]].forEach(([f, dt]) => {
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(g);
      osc.start(t + dt);
      osc.stop(t + dt + 0.7);
      osc.onended = () => release("recover");
    });
  });
}

// Boot sting: soft rising major-7 chord, ~1.2s.
export function boot() {
  play("boot", (c) => {
    const t = c.currentTime;
    const freqs = [261.63, 329.63, 392.0, 493.88]; // Cmaj7
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    g.connect(master);
    let pending = freqs.length;
    freqs.forEach((f, i) => {
      const osc = c.createOscillator();
      osc.type = i === 3 ? "sine" : "triangle";
      osc.frequency.value = f;
      const og = c.createGain();
      og.gain.value = 0.7 - i * 0.1;
      osc.connect(og).connect(g);
      osc.start(t + i * 0.09);
      osc.stop(t + 1.4);
      osc.onended = () => --pending === 0 && release("boot");
    });
  });
}

// Very quiet focus pad: two detuned voices through a lowpass whose cutoff
// follows the load scalar. Returns without ctx if audio isn't running.
export function startPad(load = 0.4) {
  const c = ensure();
  if (!c || c.state !== "running" || !enabled || pad) return;
  const g = c.createGain();
  g.gain.value = 0;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400 + load * 900;
  const o1 = c.createOscillator();
  o1.type = "sine";
  o1.frequency.value = 174.61; // F3
  const o2 = c.createOscillator();
  o2.type = "triangle";
  o2.frequency.value = 261.63; // C4
  o2.detune.value = 6;
  const o3 = c.createOscillator();
  o3.type = "sine";
  o3.frequency.value = 349.23; // F4
  o3.detune.value = -5;
  const og = c.createGain();
  og.gain.value = 0.33;
  o1.connect(og);
  o2.connect(og);
  o3.connect(og);
  og.connect(lp).connect(g).connect(master);
  g.gain.setTargetAtTime(0.05, c.currentTime, 1.2);
  for (const o of [o1, o2, o3]) o.start();
  pad = { oscs: [o1, o2, o3], gain: g, filter: lp };
}

export function setPadLoad(load) {
  if (pad && ctx) pad.filter.frequency.setTargetAtTime(400 + load * 900, ctx.currentTime, 0.6);
}

export function stopPad(releaseTime = 0.8) {
  if (!pad || !ctx) return;
  const { oscs, gain } = pad;
  pad = null;
  gain.gain.setTargetAtTime(0, ctx.currentTime, releaseTime / 3);
  setTimeout(() => oscs.forEach((o) => o.stop()), releaseTime * 1500);
}
