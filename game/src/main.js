// main.js — Opticon 3D entry point. Wires map + rules + AI + render + input + UI
// into a playable game: menu → play (single-player vs AI, or hotseat) → game over.

import { generateMap } from "./map.js";
import {
  createGame,
  moveActivePrisoner,
  endPrisonerTurn,
  rotateWatcher,
  setBluff,
  watcherScan,
  endWatcherTurn,
  isOver,
} from "./rules.js";
import { playWatcherTurn } from "./watcherAI.js";
import { Renderer } from "./render.js";
import { Input } from "./input.js";
import { Audio } from "./audio.js";
import { UI } from "./ui.js";

const BUILD = "beta-0.1.0";

const app = {
  renderer: null,
  input: null,
  audio: null,
  ui: null,
  game: null,
  config: {
    humanRole: "Prisoner", // "Prisoner" | "Watcher"
    mode: "single", // "single" | "hotseat"
    difficulty: "medium",
    seed: 1,
  },
  viewMode: "prisoner",
  running: false,
  lastT: 0,
  aiThinking: false,
};

function boot() {
  const canvas = document.getElementById("gl");
  app.renderer = new Renderer(canvas);
  app.audio = new Audio();
  app.ui = new UI(document.body);
  app.input = new Input(handleIntent);

  // Touch buttons + canvas orbit.
  const touchRoot = document.getElementById("touchControls");
  if (touchRoot) app.input.bindTouchButtons(touchRoot);
  app.input.bindCanvasOrbit(
    canvas,
    (daz, del) => {
      app.renderer.orbit.az -= daz;
      app.renderer.orbit.el = clamp(app.renderer.orbit.el + del, 0.25, 1.4);
    },
    (dz) => {
      app.renderer.orbit.dist = clamp(app.renderer.orbit.dist + dz, 6, 30);
    }
  );

  wireMenu();
  app.ui.showMenu();
  loop(performance.now());
}

function wireMenu() {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => { app.audio.resume(); app.audio.play("ui"); fn(); });
  };
  bind("playPrisoner", () => startGame({ humanRole: "Prisoner", mode: "single" }));
  bind("playWatcher", () => startGame({ humanRole: "Watcher", mode: "single" }));
  bind("playHotseat", () => startGame({ mode: "hotseat", humanRole: "Prisoner" }));
  bind("btnRestart", () => startGame(app.config));
  bind("btnMenu", () => { app.running = false; app.ui.showMenu(); app.audio.stopDrone(); });

  // Difficulty selector.
  document.querySelectorAll("[data-diff]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-diff]").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      app.config.difficulty = b.getAttribute("data-diff");
      app.audio.play("ui");
    });
  });

  const buildEl = document.getElementById("buildLabel");
  if (buildEl) buildEl.textContent = BUILD;
}

function startGame(overrides = {}) {
  Object.assign(app.config, overrides);
  // Fresh seed each game for variety, but reproducible within a game.
  app.config.seed = (Math.floor(Math.random() * 1e9) >>> 0) || 1;
  const map = generateMap(app.config.seed);
  app.game = createGame(map, { watcherFacing: 0 });
  app.game.prisoners.forEach((p) => (p.mpMax = 3));

  app.renderer.buildWorld(app.game);
  app.viewMode = app.config.humanRole === "Watcher" ? "watcher" : "prisoner";
  app.renderer.setViewMode(app.viewMode);
  app.running = true;
  app.aiThinking = false;

  app.audio.resume();
  app.audio.startDrone();
  app.ui.showHud();
  app.ui.updateHud(app.game, app.viewMode, humanLabel());
  app.ui.renderLog(app.game);
  app.ui.hint(hintFor());

  // If human is Watcher, the AI prisoner acts first each round.
  if (app.config.humanRole === "Watcher" && app.config.mode === "single") {
    // Prisoner AI takes its turn immediately, then it's the human Watcher's turn.
    scheduleAiPrisoner();
  }
}

function humanLabel() {
  if (app.config.mode === "hotseat") return "Hotseat (both)";
  return app.config.humanRole;
}

function hintFor() {
  const g = app.game;
  if (!g) return "";
  if (g.turn === "Prisoner") {
    return "Move with WASD / arrows. 1 step = quiet. 2+ steps reveal where you started. Reach the green gate.";
  }
  return "Watcher: Q/E rotate 90°, 1-4 bluff a direction, Space to scan & end turn.";
}

// ---- Intent handling -----------------------------------------------------

function handleIntent(intent, arg) {
  if (intent === "restart") return startGame(app.config);
  if (intent === "cycleView") return cycleView();
  if (!app.running || !app.game || isOver(app.game)) return;

  const g = app.game;
  app.audio.resume();

  if (g.turn === "Prisoner") {
    handlePrisonerIntent(intent, arg);
  } else {
    handleWatcherIntent(intent, arg);
  }
  app.ui.updateHud(g, app.viewMode, humanLabel());
  app.ui.renderLog(g);
}

function humanControlsPrisoner() {
  return app.config.mode === "hotseat" || app.config.humanRole === "Prisoner";
}
function humanControlsWatcher() {
  return app.config.mode === "hotseat" || app.config.humanRole === "Watcher";
}

function handlePrisonerIntent(intent, arg) {
  if (!humanControlsPrisoner()) return; // AI prisoner; ignore input
  const g = app.game;
  if (intent === "move") {
    const r = moveActivePrisoner(g, arg);
    if (r.ok) {
      if (r.event === "glass") app.audio.play("glass");
      else if (r.event === "door-open") app.audio.play("door");
      else if (r.event === "switch") app.audio.play("switch");
      else if (r.event === "exit") { app.audio.play("escape"); app.ui.banner("ESCAPED!", "good"); }
      else app.audio.play("move");
      if (r.event === "glass") app.renderer.triggerPing(r.x, r.y);
      checkOver();
    } else if (r.reason === "blocked") {
      app.audio.play("blocked");
    }
  } else if (intent === "endTurn") {
    doEndPrisonerTurn();
  }
}

function doEndPrisonerTurn() {
  const g = app.game;
  const p = g.prisoners[g.activePrisoner];
  const startPos = { ...p.startTurnPos };
  const dist = Math.abs(p.x - startPos.x) + Math.abs(p.y - startPos.y);
  endPrisonerTurn(g);
  if (dist >= 2) {
    app.audio.play("noise");
    app.renderer.triggerPing(startPos.x, startPos.y);
  }
  app.audio.play("turn");
  // Now the Watcher acts.
  if (app.config.mode === "hotseat" || app.config.humanRole === "Watcher") {
    // Human watcher plays; switch view for hotseat.
    if (app.config.mode === "hotseat") setView("watcher");
    app.ui.banner("Watcher's turn", "watcher");
    app.ui.hint(hintFor());
  } else {
    // AI watcher.
    scheduleAiWatcher();
  }
}

function handleWatcherIntent(intent, arg) {
  if (!humanControlsWatcher()) return;
  const g = app.game;
  if (intent === "rotate") {
    if (rotateWatcher(g, arg).ok) app.audio.play("rotate");
  } else if (intent === "bluff") {
    if (setBluff(g, arg).ok) app.audio.play("bluff");
  } else if (intent === "endTurn") {
    // Scan (commit), then end turn.
    const scan = watcherScan(g);
    app.audio.play("scan");
    if (scan.caught) { app.audio.play("caught"); app.ui.banner("CAPTURED!", "bad"); }
    checkOver();
    if (isOver(g)) return;
    endWatcherTurn(g);
    app.audio.play("turn");
    if (app.config.mode === "hotseat") {
      setView("prisoner");
      app.ui.banner("Prisoner's turn", "prisoner");
    } else if (app.config.humanRole === "Watcher") {
      // AI prisoner takes its turn now.
      scheduleAiPrisoner();
    }
    app.ui.hint(hintFor());
  }
}

// ---- AI turn sequencing (async, with small delays for readability) --------

function scheduleAiWatcher() {
  if (app.aiThinking) return;
  app.aiThinking = true;
  app.ui.banner("Watcher is watching...", "watcher");
  setTimeout(() => {
    const g = app.game;
    if (!g || isOver(g)) { app.aiThinking = false; return; }
    const actions = playWatcherTurn(g, app.config.difficulty, app.config.seed);
    for (const a of actions) {
      if (a.type === "rotate") app.audio.play("rotate");
      if (a.type === "bluff") app.audio.play("bluff");
      if (a.type === "scan") {
        app.audio.play("scan");
        if (a.caught != null) { app.audio.play("caught"); app.ui.banner("CAPTURED!", "bad"); }
      }
    }
    app.aiThinking = false;
    checkOver();
    app.ui.updateHud(g, app.viewMode, humanLabel());
    app.ui.renderLog(g);
    if (!isOver(g)) app.ui.banner("Your move", "prisoner");
    app.ui.hint(hintFor());
  }, 750);
}

function scheduleAiPrisoner() {
  if (app.aiThinking) return;
  app.aiThinking = true;
  app.ui.banner("Prisoner is moving...", "prisoner");
  setTimeout(() => {
    const g = app.game;
    if (!g || isOver(g)) { app.aiThinking = false; return; }
    aiPrisonerTurn(g);
    endPrisonerTurn(g);
    app.aiThinking = false;
    checkOver();
    app.ui.updateHud(g, app.viewMode, humanLabel());
    app.ui.renderLog(g);
    if (!isOver(g)) app.ui.banner("Watcher's turn — your move", "watcher");
    app.ui.hint(hintFor());
  }, 650);
}

// A simple greedy prisoner AI: step toward the exit, preferring quiet single
// steps, avoiding glass when possible.
function aiPrisonerTurn(g) {
  const p = g.prisoners[g.activePrisoner];
  const exit = g.map.exit;
  let steps = 0;
  while (p.mp > 0 && steps < 3 && !isOver(g)) {
    const dirs = [0, 1, 2, 3].sort((a, b) => scoreDir(g, p, b, exit) - scoreDir(g, p, a, exit));
    let moved = false;
    for (const d of dirs) {
      const before = { x: p.x, y: p.y, mp: p.mp };
      const r = moveActivePrisoner(g, d);
      if (r.ok && (r.event === "move" || r.event === "glass" || r.event === "exit")) {
        if (r.event === "glass") app.renderer.triggerPing(r.x, r.y);
        moved = true;
        steps++;
        break;
      }
    }
    if (!moved) break;
    // Keep it quiet: stop after 1 step often to avoid noise (unless close to exit).
    const distExit = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y);
    if (steps >= 1 && distExit > 3 && Math.random() < 0.5) break;
  }
}

function scoreDir(g, p, d, exit) {
  const vec = [[0, -1], [1, 0], [0, 1], [-1, 0]][d];
  const nx = p.x + vec[0];
  const ny = p.y + vec[1];
  const before = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y);
  const after = Math.abs(nx - exit.x) + Math.abs(ny - exit.y);
  return before - after + Math.random() * 0.3;
}

// ---- Views ---------------------------------------------------------------

// The prisoner avatar is visible only to the side that "is" the prisoner:
//  - Prisoner role: always (it's you).
//  - Hotseat: only during the Prisoner's turn (pass-the-device secrecy).
//  - Pure Watcher: never — the panopticon's whole premise.
function shouldShowPrisoner() {
  if (!app.game) return false;
  if (app.config.humanRole === "Prisoner" && app.config.mode === "single") return true;
  if (app.config.mode === "hotseat") return app.game.turn === "Prisoner";
  return false; // single-player Watcher
}

function cycleView() {
  // A pure Watcher can't peek through the prisoner's eyes.
  const order =
    app.config.mode === "single" && app.config.humanRole === "Watcher"
      ? ["watcher", "overview"]
      : ["prisoner", "watcher", "overview"];
  const i = order.indexOf(app.viewMode);
  setView(order[(i + 1) % order.length] || order[0]);
  app.audio.play("ui");
}
function setView(mode) {
  app.viewMode = mode;
  app.renderer.setViewMode(mode);
  if (app.ui && app.game) app.ui.updateHud(app.game, app.viewMode, humanLabel());
}

// ---- End condition -------------------------------------------------------

function checkOver() {
  const g = app.game;
  if (g && isOver(g)) {
    app.running = false;
    app.audio.stopDrone();
    if (g.winner === "Prisoner") app.audio.play("escape");
    else app.audio.play("caught");
    setTimeout(() => app.ui.gameOver(g), 700);
  }
}

// ---- Main loop -----------------------------------------------------------

function loop(t) {
  const dt = Math.min(0.05, (t - app.lastT) / 1000 || 0);
  app.lastT = t;
  if (app.input) app.input.pollGamepad();
  if (app.renderer && app.game) {
    app.renderer.update(app.game, dt, { showPrisoner: shouldShowPrisoner() });
  } else if (app.renderer) {
    app.renderer.renderOnce();
  }
  requestAnimationFrame(loop);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// Expose a tiny hook for headless smoke tests.
window.__opticon = app;

boot();
