// audio.js — Tiny WebAudio SFX + ambient drone. No external assets.

export class Audio {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
    this.droneNodes = null;
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
  }

  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.6 : 0;
    if (!on) this.stopDrone();
  }

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
    osc.connect(g).connect(this.master);
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
    }
  }

  startDrone() {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx || this.droneNodes) return;
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 46;
    osc2.type = "sine";
    osc2.frequency.value = 69;
    g.gain.value = 0.03;
    osc.connect(g);
    osc2.connect(g);
    g.connect(this.master);
    osc.start();
    osc2.start();
    this.droneNodes = { osc, osc2, g };
  }

  stopDrone() {
    if (!this.droneNodes) return;
    try {
      this.droneNodes.osc.stop();
      this.droneNodes.osc2.stop();
    } catch (e) {}
    this.droneNodes = null;
  }
}
