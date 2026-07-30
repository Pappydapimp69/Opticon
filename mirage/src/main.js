// main.js — wiring. Menu -> run -> debrief, and the frame loop that pumps
// input into the sim, the sim into perception, and perception into the screen.

import {
  createRun, tick, debrief, logMarker, checkIn, useDose,
  PARTY_SIZE, DIFFICULTY, LOG_RADIUS, PYLON_RADIUS,
} from "./state.js";
import { createPercept, updatePercept, distortion } from "./percept.js";
import { createRenderer } from "./render.js";
import { createHud, renderDebrief, paintHint } from "./hud.js";
import { createInput, ACTIONS } from "./input.js";
import { createAudio } from "./audio.js";
import { hashSeed } from "./rng.js";

const BUILD = "mirage-0.1.0";

const el = (id) => document.getElementById(id);
const canvas = el("gl");

const audio = createAudio();
// ONE persistent input instance for the whole app lifetime — title, pause,
// debrief, and gameplay all read the same pad/keyboard, dispatched by
// input.setMode('menu' | 'game'). A per-run instance (the previous design)
// meant nothing before the first run existed could see a gamepad at all, so a
// controller-only player had no way to even press Start.
const input = createInput(canvas, { sensitivity: 1, onScheme: refreshSchemeUI });
let run = null; // { sim, percept, renderer, hud }
let paused = false;
let selected = 0;
let whisperTimer = 0;
let lastFrame = 0;

const LAYERS = ["title", "hudLayer", "pauseLayer", "debriefLayer"];
function screens(show) {
  for (const id of LAYERS) el(id).classList.toggle("hidden", id !== show);
  input.setMode(show === "hudLayer" ? "game" : "menu");
  if (show !== "hudLayer") setupMenuFocus(show);
}

// ---- gamepad/keyboard menu navigation --------------------------------------
// Same shape as Opticon's menu grid nav: a screen's focusable controls carry
// data-row/data-col, horizontal nav is confined to the current row and
// vertical nav lands on the nearest column of the adjacent row — a single
// button GRID per screen, not a flat list, so no direction can ever wander
// into the wrong control (Brain: a flat single-axis focus list over visually
// distinct groups lets any direction leak into the wrong group).
const ROOT_SELECTOR = { title: "#title", pauseLayer: "#pauseLayer", debriefLayer: "#debriefLayer" };
const menu = { root: null, row: 0, col: 0 };

function menuElements() {
  const sel = ROOT_SELECTOR[menu.root];
  return sel ? Array.from(document.querySelectorAll(`${sel} [data-row]`)) : [];
}
function currentFocusEl() {
  return menuElements().find((e) => Number(e.dataset.row) === menu.row && Number(e.dataset.col) === menu.col);
}
function menuFocusApply() {
  document.querySelectorAll(".gpfocus").forEach((e) => e.classList.remove("gpfocus"));
  const cur = currentFocusEl();
  if (cur) {
    cur.classList.add("gpfocus");
    cur.scrollIntoView?.({ block: "nearest" });
  }
}
function menuNavX(delta) {
  const els = menuElements().filter((e) => Number(e.dataset.row) === menu.row);
  const cols = els.map((e) => Number(e.dataset.col)).sort((a, b) => a - b);
  if (cols.length < 2) return;
  const i = cols.indexOf(menu.col);
  const next = Math.max(0, Math.min(cols.length - 1, (i < 0 ? 0 : i) + delta));
  if (cols[next] === menu.col) return;
  menu.col = cols[next];
  menuFocusApply();
}
function menuNavY(delta) {
  const rows = [...new Set(menuElements().map((e) => Number(e.dataset.row)))].sort((a, b) => a - b);
  if (rows.length < 2) return;
  const i = rows.indexOf(menu.row);
  const next = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta));
  if (rows[next] === menu.row) return;
  menu.row = rows[next];
  const rowCols = menuElements().filter((e) => Number(e.dataset.row) === menu.row).map((e) => Number(e.dataset.col));
  if (!rowCols.includes(menu.col)) menu.col = rowCols[0] ?? 0;
  menuFocusApply();
}
function menuConfirm() {
  // Not a synthetic keyboard/mouse event, just `.click()` — the DOM element's
  // own listener (set difficulty, start the run, resume, …) does the real work
  // identically regardless of what triggered it, the same pattern Opticon uses.
  currentFocusEl()?.click();
}
function menuCancel() {
  if (menu.root === "pauseLayer") togglePause(); // B backs out to resume, same as Escape
}
function setupMenuFocus(root) {
  const prevRoot = menu.root;
  menu.root = root;
  const els = menuElements();
  if (!els.length) {
    input.setMenuHandlers(null, null, null, null);
    return;
  }
  const stillValid = prevRoot === root && els.some((e) => Number(e.dataset.row) === menu.row && Number(e.dataset.col) === menu.col);
  if (!stillValid) {
    menu.row = Number(els[0].dataset.row);
    menu.col = Number(els[0].dataset.col);
  }
  menuFocusApply();
  input.setMenuHandlers(menuNavX, menuNavY, menuConfirm, menuCancel);
}

// ---- device-adaptive UI (Brain: device-adaptive-ui / show-the-active-scheme)
// Reshape the on-screen UI to match whichever device is actually in the
// player's hands, live, as devices change — never make the player translate.
function menuHintFor(scheme) {
  return {
    keyboard: "Arrows / WASD move · Enter / Space select",
    gamepad: "D-pad / stick move · [A] select · [B] back",
    touch: "Tap to select",
  }[scheme] || "";
}
function refreshSchemeUI(scheme) {
  document.body.dataset.scheme = scheme;
  document.querySelectorAll(".menu-hints").forEach((e) => paintHint(e, menuHintFor(scheme)));
  if (run) run.hud.setHints(scheme);
}

function startRun({ seed, difficulty } = {}) {
  const seedValue = seed ?? Math.floor(Math.random() * 0xffffff) + 1;
  const sim = createRun({ seed: seedValue, difficulty: difficulty || "standard" });
  const percept = createPercept();
  const renderer = createRenderer(canvas, sim);
  const hud = createHud(sim, percept);
  selected = 0;
  paused = false;
  whisperTimer = 0;
  run = { sim, percept, renderer, hud };
  hud.setHints(input.activeScheme);
  hud.say("Six of you. One basin. Keep them together.", "warn");
  el("seedLabel").textContent = `seed ${seedValue}`;
  screens("hudLayer");
  audio.start();
  // A controller player has no use for mouse pointer lock — their look comes
  // from the right stick regardless of lock state — and requesting it here
  // would either no-op or flash a browser permission prompt for nothing.
  if (input.activeScheme !== "gamepad") input.requestLock();
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
      // An explicit arg (a keyboard digit) both targets AND becomes the shared
      // selection, so the roster highlight and Q/R/LB/RB cycling anchor move
      // with it. Without updating `selected` here, a gamepad's X/Y buttons —
      // which carry no arg and rely on this shared value — would act on
      // whatever LB/RB last cycled to, never on a digit-picked companion.
      if (typeof arg === "number") selected = arg;
      const target = sim.companions[selected];
      if (!target) return;
      hud.showReport(checkIn(sim, target.id));
      break;
    }
    case ACTIONS.DOSE: {
      if (typeof arg === "number") selected = arg;
      const target = sim.companions[selected];
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
  if (!paused && input.activeScheme !== "gamepad") input.requestLock();
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
  if (!lastFrame) lastFrame = now;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt <= 0) return;
  // input.poll() runs every frame regardless of screen — that is what lets a
  // gamepad drive the title/pause/debrief menus before any run exists at all.
  // In 'menu' mode it only has side effects (scheme tracking, dispatching to
  // the registered menu handlers) and returns null; in 'game' mode it also
  // returns the movement intent the sim step needs. Scheme-change UI updates
  // are pushed via the onScheme callback (refreshSchemeUI), not polled here.
  const intent = input.poll(dt);
  if (!run || paused || run.sim.status !== "playing" || !intent) return;
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
  // Discrete steps rather than a range slider — see the HTML comment: a
  // slider has no natural gamepad binding, but these buttons slot straight
  // into the same row/col grid nav as everything else in the pause menu.
  for (const btn of document.querySelectorAll("[data-vol]")) {
    btn.addEventListener("click", () => {
      audio.setVolume(Number(btn.dataset.vol));
      for (const b of document.querySelectorAll("[data-vol]")) b.classList.toggle("sel", b === btn);
    });
  }
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
