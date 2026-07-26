// audio.js — WebAudio SFX + a generative ambient music engine. No assets.
// Music evolves (chord progression + sparse bells + heartbeat sub) rather than
// looping a single drone. Music layers cross-fade equal-power (see Brain
// dog#E57). Everything is gesture-initialised (Brain test#E9): call resume()
// and startMusic() from a real user gesture or Chrome keeps it silent.

const A4 = 440;
const mtof = (m) => A4 * Math.pow(2, (m - 69) / 12);

export class Audio {
  constructor() {
    this.enabled = true;
    // Master volume multiplier (0..1), independent of `enabled` — a settings
    // control the player can revisit mid-game, unlike the gesture-gated
    // enable/disable above. Persisted by main.js across sessions.
    this.volume = 1;
    this._prevVolume = 0.9;
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.music = null;
    this._pulseTimer = null; // exposure/danger heartbeat interval
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 * this.volume : 0;
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.7;
    this.sfxGain.connect(this.master);
    this.music = new MusicEngine(this.ctx, this.master);
  }

  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 0.9 * this.volume : 0, this.ctx.currentTime, 0.05);
    }
    if (!on) this.stopMusic();
  }

  // Discrete volume levels (Off/Low/Medium/Full) selected from the menu, or
  // toggled to/from 0 via the in-HUD mute button (toggleMute below).
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.enabled ? 0.9 * this.volume : 0, this.ctx.currentTime, 0.05);
    }
  }

  // Returns true if audio is now audible (volume > 0) after the toggle.
  toggleMute() {
    if (this.volume > 0) {
      this._prevVolume = this.volume;
      this.setVolume(0);
    } else {
      this.setVolume(this._prevVolume || 0.9);
    }
    return this.volume > 0;
  }

  startMusic() {
    this.ensure();
    if (this.enabled && this.music) this.music.start();
  }
  stopMusic() {
    if (this.music) this.music.stop();
  }

  // ---- SFX -------------------------------------------------------------
  tone(freq, dur, type = "sine", gain = 0.08, when = 0) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  play(name) {
    switch (name) {
      case "move": this.tone(520, 0.05, "triangle", 0.05); break;
      case "blocked": this.tone(130, 0.09, "square", 0.06); break;
      case "glass":
        this.tone(1200, 0.05, "triangle", 0.05);
        this.tone(1650, 0.06, "sine", 0.04, 0.02);
        break;
      case "door":
        this.tone(170, 0.07, "square", 0.06);
        this.tone(900, 0.04, "sine", 0.03, 0.03);
        break;
      case "switch": this.tone(700, 0.05, "square", 0.05); break;
      case "rotate": this.tone(360, 0.08, "sawtooth", 0.045); break;
      case "bluff": this.tone(300, 0.09, "sine", 0.05); break;
      case "noise": this.tone(220, 0.2, "sawtooth", 0.07); break;
      case "scan":
        this.tone(140, 0.25, "sawtooth", 0.08);
        this.tone(280, 0.18, "square", 0.05, 0.04);
        break;
      case "caught":
        this.tone(90, 0.5, "sawtooth", 0.12);
        this.tone(70, 0.7, "square", 0.08, 0.05);
        break;
      case "escape":
        this.tone(523, 0.12, "triangle", 0.08);
        this.tone(659, 0.12, "triangle", 0.08, 0.1);
        this.tone(784, 0.2, "triangle", 0.09, 0.2);
        break;
      case "turn": this.tone(440, 0.06, "sine", 0.045); break;
      case "ui": this.tone(660, 0.04, "sine", 0.035); break;
      case "start":
        this.tone(196, 0.5, "sine", 0.09);
        this.tone(294, 0.4, "triangle", 0.06, 0.06);
        this.tone(392, 0.6, "sine", 0.05, 0.12);
        break;
    }
  }

  // Exposure/danger cue: a low two-thump heartbeat, re-triggered on an
  // interval while the Prisoner is exposed (see main.js updateDangerVignette
  // — same isExposed() check the Watcher's scan actually uses, so this is
  // never a fake alarm). Idempotent start/stop, mirroring startMusic/
  // stopMusic's own pattern.
  startHeartbeat() {
    if (this._pulseTimer) return;
    this.ensure();
    const beat = () => {
      if (!this.ctx) return;
      this.tone(72, 0.14, "sine", 0.1);
      const t = this.ctx.currentTime + 0.16;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(58, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(g).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.2);
    };
    beat();
    this._pulseTimer = setInterval(beat, 1100);
  }
  stopHeartbeat() {
    if (this._pulseTimer) { clearInterval(this._pulseTimer); this._pulseTimer = null; }
  }

  // Back-compat aliases (main.js used drone naming).
  startDrone() { this.startMusic(); }
  stopDrone() { /* music is continuous once started; no-op */ }
}

// Generative ambient bed. A dark modal progression of filtered detuned-saw pads,
// a pulsing sub "heartbeat", and sparse delayed bells from the scale.
class MusicEngine {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;
    this.out.connect(dest);

    // Shared feedback delay gives the bells space.
    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = 0.38;
    this.fb = ctx.createGain();
    this.fb.gain.value = 0.34;
    this.delay.connect(this.fb);
    this.fb.connect(this.delay);
    this.delayMix = ctx.createGain();
    this.delayMix.gain.value = 0.35;
    this.delay.connect(this.delayMix);
    this.delayMix.connect(this.out);

    // Dark D-minor-ish progression (MIDI), voiced low. i – VI – III – v.
    this.chords = [
      [38, 45, 50, 53], // Dm
      [34, 41, 46, 50], // Bb
      [33, 45, 48, 52], // A(add) tension
      [31, 43, 46, 50], // G / Bb color
    ];
    // Scale for bells (D natural minor, spread high).
    this.scale = [62, 65, 67, 69, 72, 74, 77, 81];
    this.chordDur = 7.5;
    this.nextTime = 0;
    this.chordIdx = 0;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.running || !this.ctx) return;
    this.running = true;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), now);
    this.out.gain.exponentialRampToValueAtTime(0.5, now + 4);
    this.nextTime = now + 0.15;
    this.chordIdx = 0;
    this._tick();
    this.timer = setInterval(() => this._tick(), 250);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.ctx) this.out.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.5);
  }

  _tick() {
    if (!this.running) return;
    const ahead = this.ctx.currentTime + 2.0;
    while (this.nextTime < ahead) {
      const chord = this.chords[this.chordIdx % this.chords.length];
      this._pad(chord, this.nextTime, this.chordDur);
      this._sub(chord[0] - 12, this.nextTime, this.chordDur);
      this._bells(this.nextTime, this.chordDur);
      this.chordIdx++;
      this.nextTime += this.chordDur;
    }
  }

  _pad(notes, t0, dur) {
    const ctx = this.ctx;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 480;
    filt.Q.value = 5;
    // slow filter movement so the timbre never sits still
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 0.05 + Math.random() * 0.04;
    lfoG.gain.value = 240;
    lfo.connect(lfoG);
    lfoG.connect(filt.frequency);

    const g = ctx.createGain();
    g.gain.value = 0.0001;
    filt.connect(g);
    g.connect(this.out);

    // equal-power-style overlap: fade in/out so adjacent chords sum smoothly
    const ov = 2.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.15, t0 + ov);
    g.gain.setValueAtTime(0.15, t0 + dur - ov * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + ov * 0.5);

    const stopAt = t0 + dur + ov;
    for (const n of notes) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = mtof(n);
        o.detune.value = det;
        o.connect(filt);
        o.start(t0);
        o.stop(stopAt);
      }
    }
    lfo.start(t0);
    lfo.stop(stopAt);
  }

  _sub(note, t0, dur) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = mtof(note);
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    osc.connect(g);
    g.connect(this.out);
    // slow heartbeat pulses across the chord
    for (let bt = 0; bt < dur - 0.1; bt += 2.4) {
      const tb = t0 + bt;
      g.gain.setValueAtTime(0.0001, tb);
      g.gain.exponentialRampToValueAtTime(0.08, tb + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, tb + 1.6);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  _bells(t0, dur) {
    const ctx = this.ctx;
    for (let bt = 0.8; bt < dur; bt += 1.6) {
      if (Math.random() > 0.4) continue; // sparse
      const t = t0 + bt + (Math.random() - 0.5) * 0.3;
      const note = this.scale[(Math.random() * this.scale.length) | 0];
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = mtof(note);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g);
      g.connect(this.delay); // into the echo
      g.connect(this.out); // dry too
      o.start(t);
      o.stop(t + 1.5);
    }
  }
}
