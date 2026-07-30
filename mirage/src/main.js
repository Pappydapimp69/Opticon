// main.js — wiring. Menu -> run -> debrief, and the frame loop that pumps
// input into the sim, the sim into perception, and perception into the screen.

import {
  createRun, tick, debrief, logMarker, checkIn, useDose,
  PARTY_SIZE, DIFFICULTY, LOG_RADIUS, PYLON_RADIUS,
} from "./state.js";
import { createPercept, updatePercept, distortion } from "./percept.js";
import { createRenderer } from "./render.js";
import { createHud, renderDebrief } from "./hud.js";
import { createInput, ACTIONS } from "./input.js";
import { createAudio } from "./audio.js";
import { hashSeed } from "./rng.js";

const BUILD = "mirage-0.1.0";

const el = (id) => document.getElementById(id);
const canvas = el("gl");

const audio = createAudio();
let run = null; // { sim, percept, renderer, hud, input }
let paused = false;
let selected = 0;
let whisperTimer = 0;
let lastFrame = 0;

const LAYERS = ["title", "hudLayer", "pauseLayer", "debriefLayer"];
function screens(show) {
  for (const id of LAYERS) el(id).classList.toggle("hidden", id !== show);
}

function startRun({ seed, difficulty } = {}) {
  const seedValue = seed ?? Math.floor(Math.random() * 0xffffff) + 1;
  const sim = createRun({ seed: seedValue, difficulty: difficulty || "standard" });
  const percept = createPercept();
  const renderer = createRenderer(canvas, sim);
  const hud = createHud(sim, percept);
  const input = createInput(canvas, { sensitivity: 1 });
  selected = 0;
  paused = false;
  whisperTimer = 0;
  run = { sim, percept, renderer, hud, input };
  hud.setHints(input.state.scheme);
  hud.say("Six of you. One basin. Keep them together.", "warn");
  el("seedLabel").textContent = `seed ${seedValue}`;
  screens("hudLayer");
  audio.start();
  input.requestLock();
  lastFrame = 0;
  // No assignment to window.__mirage here: `sim`, `percept` and `renderer` are
  // getters over the live `run`, so they already follow this new run. Writing to
  // them throws in strict mode (ES modules are always strict), which is exactly
  // what the smoke test caught.
  return run;
}

function nearestPhantom(sim, percept) {
  if (!percept.active) return null;
  let best = null, bestD = Infinity;
  for (const ph of percept.phantomMonoliths) {
    const d = Math.hypot(ph.x - sim.player.x, ph.z - sim.player.z);
    if (d < bestD) { bestD = d; best = ph; }
  }
  return bestD <= LOG_RADIUS ? best : null;
}

function handleAction(action, arg) {
  const { sim, percept, hud } = run;
  if (sim.status !== "playing") return;
  switch (action) {
    case ACTIONS.SURVEY: {
      const res = logMarker(sim, nearestPhantom(sim, percept));
      if (!res.ok) audio.play("deny");
      else audio.play(res.real ? "log" : "logFalse");
      break;
    }
    case ACTIONS.CHECK_IN: {
      const target = sim.companions[typeof arg === "number" ? arg : selected];
      if (!target) return;
      hud.showReport(checkIn(sim, target.id));
      break;
    }
    case ACTIONS.DOSE: {
      const target = sim.companions[typeof arg === "number" ? arg : selected];
      if (!target) return;
      if (useDose(sim, target.id)) audio.play("dose");
      else audio.play("deny");
      break;
    }
    case ACTIONS.NEXT_TARGET:
      selected = (selected + 1) % (PARTY_SIZE - 1);
      break;
    case ACTIONS.PREV_TARGET:
      selected = (selected + PARTY_SIZE - 2) % (PARTY_SIZE - 1);
      break;
    case ACTIONS.PAUSE:
      togglePause();
      break;
    default:
      break;
  }
}

function togglePause() {
  if (!run || run.sim.status !== "playing") return;
  paused = !paused;
  screens(paused ? "pauseLayer" : "hudLayer");
  if (!paused) run.input.requestLock();
}

/** One simulation + presentation step. Separated from rAF so tests can drive it. */
function step(dt, intent) {
  const { sim, percept, renderer, hud } = run;
  const yaw = intent.yaw ?? 0;
  // Screen-space intent rotated into world space by the camera's yaw. Note this
  // uses the REAL yaw: a lead with a scrambled compass still walks where their
  // body is pointed, they just believe it is a different direction.
  // Three's camera looks down -Z, so after a yaw rotation of θ about Y the basis
  // is forward = (-sinθ, -cosθ) and right = (cosθ, -sinθ). Screen-space intent
  // (W is z = -1) is projected onto that basis. Getting these signs wrong is
  // invisible to a "did the player move?" test — it moved, just backwards — and
  // it also silently put the follow formation in front of the lead.
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const move = {
    x: intent.move.x * cos + intent.move.z * sin,
    z: -intent.move.x * sin + intent.move.z * cos,
  };

  for (const { action, arg } of intent.queue) handleAction(action, arg);

  tick(sim, dt, { move, run: intent.run, yaw });
  const events = sim.events.slice();
  updatePercept(percept, sim, dt);

  for (const ev of events) {
    if (ev.kind === "hallucinate") audio.play("hallucinate");
    else if (ev.kind === "recover") audio.play("recover");
    else if (ev.kind === "break") audio.play("break");
  }

  // Whispers only exist for a lead who is gone.
  if (percept.active) {
    whisperTimer -= dt;
    if (whisperTimer <= 0) {
      whisperTimer = 2.5 + Math.random() * 5;
      audio.whisper();
    }
  }

  let prox = 0;
  for (const p of sim.pylons) {
    if (p.charge <= 0) continue;
    const d = Math.hypot(p.x - sim.player.x, p.z - sim.player.z);
    prox = Math.max(prox, Math.max(0, 1 - d / PYLON_RADIUS));
  }
  audio.update(distortion(percept, sim), prox);

  hud.update({ yaw, pitch: intent.pitch ?? 0 }, selected);
  renderer.update(percept, dt, { yaw, pitch: intent.pitch ?? 0 });

  if (sim.status !== "playing") finish();
}

function finish() {
  const report = debrief(run.sim);
  renderDebrief(el("debriefLayer"), report);
  screens("debriefLayer");
  if (document.exitPointerLock) document.exitPointerLock();
  el("againBtn")?.addEventListener("click", () => screens("title"));
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!run || paused || run.sim.status !== "playing") return;
  if (!lastFrame) lastFrame = now;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt <= 0) return;
  const intent = run.input.sample(dt);
  if (intent.scheme !== run.hud.lastScheme) {
    run.hud.setHints(intent.scheme);
    run.hud.lastScheme = intent.scheme;
  }
  step(dt, intent);
}

// ---- menu wiring -----------------------------------------------------------
function boot() {
  el("buildLabel").textContent = BUILD;
  let difficulty = "standard";
  for (const btn of document.querySelectorAll("[data-diff]")) {
    btn.addEventListener("click", () => {
      difficulty = btn.dataset.diff;
      for (const b of document.querySelectorAll("[data-diff]")) b.classList.toggle("sel", b === btn);
    });
  }
  el("startBtn").addEventListener("click", () => {
    const raw = el("seedInput").value.trim();
    const seed = raw ? (/^\d+$/.test(raw) ? Number(raw) : hashSeed(raw)) : undefined;
    startRun({ seed, difficulty });
  });
  el("howBtn").addEventListener("click", () => el("howto").classList.toggle("hidden"));
  el("resumeBtn").addEventListener("click", togglePause);
  el("quitBtn").addEventListener("click", () => {
    run = null;
    paused = false;
    screens("title");
  });
  el("volume").addEventListener("input", (e) => audio.setVolume(Number(e.target.value)));
  // Touch action buttons mirror the keyboard verbs.
  el("btnSurvey").addEventListener("click", () => run && handleAction(ACTIONS.SURVEY));
  el("btnCheck").addEventListener("click", () => run && handleAction(ACTIONS.CHECK_IN, selected));
  el("btnDose").addEventListener("click", () => run && handleAction(ACTIONS.DOSE, selected));
  el("btnNext").addEventListener("click", () => run && handleAction(ACTIONS.NEXT_TARGET));
  screens("title");
  requestAnimationFrame(frame);
}

// Debug/test hook. The smoke test drives `advance()` rather than waiting on wall
// time: headless rAF runs at a fraction of real speed, so asserting on real
// elapsed seconds is a known source of false failures. Everything the tests
// need to observe is reachable from here.
if (typeof window !== "undefined") {
  window.__mirage = {
    build: BUILD,
    startRun,
    get sim() { return run?.sim ?? null; },
    get percept() { return run?.percept ?? null; },
    // Exposed so the smoke test can assert the scene was actually DRAWN.
    // "the module loaded and nothing threw" is a false green for 3D: under
    // software GL a broken scene graph still loads clean, so the test reads
    // Three's own draw-call counter instead.
    get renderer() { return run?.renderer ?? null; },
    get paused() { return paused; },
    get selected() { return selected; },
    act: (action, arg) => run && handleAction(action, arg),
    /** Advance the sim by `seconds` in fixed slices, optionally holding movement. */
    advance(seconds, intent = {}) {
      if (!run) return null;
      const slice = 1 / 30;
      let done = 0;
      while (done < seconds && run.sim.status === "playing") {
        step(slice, {
          move: intent.move || { x: 0, z: 0 },
          run: !!intent.run,
          yaw: intent.yaw ?? run.sim.player.yaw,
          pitch: 0,
          queue: [],
        });
        done += slice;
      }
      return run.sim.time;
    },
    /** Drop a character's lucidity directly — for testing the hallucination path. */
    drain(id, to = 0) {
      if (!run) return null;
      const ch = run.sim.party.find((c) => c.id === id);
      if (!ch) return null;
      ch.lucidity = to;
      return ch.lucidity;
    },
    teleport(x, z) {
      if (!run) return null;
      run.sim.player.x = x;
      run.sim.player.z = z;
      return { x, z };
    },
    debrief: () => (run ? debrief(run.sim) : null),
    DIFFICULTY,
    ACTIONS,
  };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
