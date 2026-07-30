// audio.js — generative ambience and cues. No samples, no assets: everything is
// synthesised, so the game stays a static site with nothing to download.
//
// The bed does real work here. Lucidity is invisible, so the mix is one of the
// few honest-ish channels the player has: wind thins, a detuned second drone
// slides in as the lead frays, and whispers arrive only once they are gone.
// Degrades to silence if WebAudio is unavailable (headless test runs).

export function createAudio() {
  let ctx = null;
  let master = null;
  const nodes = {};
  let started = false;
  let muted = false;
  let volume = 0.7;

  function ensure() {
    if (ctx || typeof window === "undefined") return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
    return ctx;
  }

  function noiseBuffer(seconds = 2) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      // Brown-ish noise: closer to wind than white noise, and easier on the ear
      // over a long run.
      last = (last + (Math.random() * 2 - 1) * 0.06) * 0.985;
      d[i] = last * 3;
    }
    return buf;
  }

  /** Start the ambient bed. Must be called from a user gesture (browser policy). */
  function start() {
    if (started || !ensure()) return false;
    started = true;
    if (ctx.state === "suspended") ctx.resume();

    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(4);
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 420;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.22;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();
    nodes.windGain = windGain;
    nodes.windFilter = windFilter;

    // ground drone (stable) + a detuned partner that only rises with distortion
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.1;
    droneGain.connect(master);
    for (const f of [55, 82.5]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(droneGain);
      o.start();
    }
    const wrongGain = ctx.createGain();
    wrongGain.gain.value = 0;
    wrongGain.connect(master);
    const wrong = ctx.createOscillator();
    wrong.type = "sawtooth";
    wrong.frequency.value = 53.2; // a hair flat against the 55 — beats, slowly
    const wrongFilter = ctx.createBiquadFilter();
    wrongFilter.type = "lowpass";
    wrongFilter.frequency.value = 300;
    wrong.connect(wrongFilter).connect(wrongGain);
    wrong.start();
    nodes.wrongGain = wrongGain;

    // pylon hum — gain tracks proximity, set from update()
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    humGain.connect(master);
    const hum = ctx.createOscillator();
    hum.type = "triangle";
    hum.frequency.value = 196;
    hum.connect(humGain);
    hum.start();
    nodes.humGain = humGain;
    return true;
  }

  function ramp(param, value, seconds = 0.4) {
    if (!ctx) return;
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, Math.max(0.02, seconds / 3));
  }

  /**
   * @param distortion 0..1 — how far gone the lead is
   * @param pylonProximity 0..1 — 1 at the core of a live pylon
   */
  function update(distortion, pylonProximity) {
    if (!started || !ctx) return;
    ramp(nodes.wrongGain.gain, 0.13 * distortion, 1.2);
    ramp(nodes.windGain.gain, 0.22 * (1 - distortion * 0.6), 1.5);
    ramp(nodes.windFilter.frequency, 420 - distortion * 260, 1.5);
    ramp(nodes.humGain.gain, 0.09 * pylonProximity, 0.5);
  }

  function blip({ freq = 440, dur = 0.16, type = "sine", gain = 0.18, slide = 0 } = {}) {
    if (!started || !ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, ctx.currentTime + dur);
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  const cues = {
    log: () => { blip({ freq: 520, dur: 0.14, type: "triangle" }); setTimeout(() => blip({ freq: 780, dur: 0.2, type: "triangle" }), 90); },
    logFalse: () => blip({ freq: 300, dur: 0.5, type: "sawtooth", gain: 0.12, slide: -120 }),
    dose: () => blip({ freq: 660, dur: 0.3, type: "sine", gain: 0.15, slide: 240 }),
    recover: () => { blip({ freq: 300, dur: 0.3, type: "sine", slide: 200 }); setTimeout(() => blip({ freq: 620, dur: 0.35 }), 140); },
    hallucinate: () => blip({ freq: 180, dur: 0.9, type: "sawtooth", gain: 0.16, slide: -70 }),
    break: () => blip({ freq: 240, dur: 0.25, type: "square", gain: 0.08 }),
    deny: () => blip({ freq: 150, dur: 0.12, type: "square", gain: 0.07 }),
  };

  /** A whisper: filtered noise burst. Only ever played while the lead is gone. */
  function whisper() {
    if (!started || !ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(1);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900 + Math.random() * 1400;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.13, ctx.currentTime + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    src.connect(bp).connect(g).connect(master);
    src.start();
    src.stop(ctx.currentTime + 1);
  }

  function play(kind) {
    (cues[kind] || (() => {}))();
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master && !muted) ramp(master.gain, volume, 0.2);
  }
  function setMuted(m) {
    muted = !!m;
    if (master) ramp(master.gain, muted ? 0 : volume, 0.2);
  }

  return { start, update, play, whisper, setVolume, setMuted, get ready() { return started; } };
}
