// main.js — Opticon 3D entry point. Wires map + rules + AI + render + input + UI
// into a playable game: menu → play (single-player vs AI, or hotseat) → game over.

import { generateMap, DIR_VEC, OBJ } from "./map.js";
import {
  createGame,
  moveActivePrisoner,
  endPrisonerTurn,
  rotateWatcher,
  setBluff,
  watcherScan,
  endWatcherTurn,
  isOver,
  objAt,
  isWalkable,
  isDoorOpen,
} from "./rules.js";
import { playWatcherTurn } from "./watcherAI.js";
import { prisonerAITurn } from "./prisonerAI.js";
import { Renderer } from "./render.js";
import { Input } from "./input.js";
import { Audio } from "./audio.js";
import { UI } from "./ui.js";

const BUILD = "beta-0.4.0";

const app = {
  renderer: null,
  input: null,
  audio: null,
  ui: null,
  game: null,
  // Staged (uncommitted) prisoner path: [{x,y,dir}]. Presentation-only until
  // committed — no sim state changes until the player confirms. Cleared on
  // commit, on a fresh game, and whenever it isn't the Prisoner's turn.
  stagedPath: [],
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
  app.input = new Input(handleIntent, { onScheme: onSchemeChange });
  app.input.setIntroHandler(dismissIntro);
  app.input.setMenuHandlers(menuNavX, menuNavY, menuSelect, menuBack);

  const introEl = document.getElementById("intro");
  if (introEl) introEl.addEventListener("pointerdown", dismissIntro);

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
  showIntro();
  loop(performance.now());
}

// ---- Intro splash + staged menu navigation --------------------------------
//
// The menu is 3 progressive stages — difficulty -> play type -> hold to
// start — each gated to its OWN element grid so directional nav can never
// leak into the next stage's buttons (that leak, combined with A/Start
// instantly confirming, was why any button but one could accidentally launch
// a game straight from the splash). Only an explicit confirm advances a
// stage, and starting the game itself requires a HELD press, not a tap —
// consistent with the game's own "nothing commits until you deliberately
// hold/confirm it" philosophy for movement.

const STAGE_IDS = ["stageDifficulty", "stageMode", "stageStart"];
const menu = { stage: 0, row: 0, col: 1 }; // col:1 = Medium, the current default
let introDone = false;
let holdProgress = 0;
let mouseHoldDown = false;

function showIntro() {
  const intro = document.getElementById("intro");
  if (intro) intro.classList.remove("hidden", "fadeout");
  app.input.mode = "intro";
}

// First user gesture: unlocks the Web Audio gate AND (if it's a controller
// button) the Gamepad gate — the two are independent (Brain dog#E47).
function dismissIntro() {
  if (introDone) return;
  introDone = true;
  app.audio.resume();
  app.audio.startMusic();
  app.audio.play("start");
  const intro = document.getElementById("intro");
  if (intro) {
    intro.classList.add("fadeout");
    setTimeout(() => intro.classList.add("hidden"), 520);
  }
  openMenu();
}

function openMenu() {
  app.running = false;
  app.ui.showMenu();
  app.input.mode = "menu";
  menu.stage = 0;
  menu.row = 0;
  menu.col = ["easy", "medium", "hard"].indexOf(app.config.difficulty);
  if (menu.col < 0) menu.col = 1;
  refreshStageVisibility();
  menuFocusApply();
}

function stageElements(stageIdx) {
  const el = document.getElementById(STAGE_IDS[stageIdx]);
  return el ? Array.from(el.querySelectorAll("[data-row]")) : [];
}

function currentFocusEl() {
  return stageElements(menu.stage).find(
    (el) => Number(el.dataset.row) === menu.row && Number(el.dataset.col) === menu.col
  );
}

function refreshStageVisibility() {
  STAGE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("stage-active", i === menu.stage);
    el.classList.toggle("stage-locked", i > menu.stage);
    el.classList.toggle("stage-done", i < menu.stage);
  });
}

function menuFocusApply() {
  document.querySelectorAll(".gpfocus").forEach((el) => el.classList.remove("gpfocus"));
  const cur = currentFocusEl();
  if (cur) {
    cur.classList.add("gpfocus");
    if (cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
}

// Axis-correct: horizontal nav only ever moves column, vertical only ever
// moves row, within the CURRENT stage's own grid — it cannot reach the next
// stage's buttons no matter how far you push a direction.
function menuNavX(delta) {
  const els = stageElements(menu.stage).filter((el) => Number(el.dataset.row) === menu.row);
  const cols = els.map((el) => Number(el.dataset.col)).sort((a, b) => a - b);
  if (cols.length < 2) return;
  const i = cols.indexOf(menu.col);
  const next = clamp((i < 0 ? 0 : i) + delta, 0, cols.length - 1);
  if (cols[next] === menu.col) return;
  menu.col = cols[next];
  menuFocusApply();
  app.audio.play("ui");
}

function menuNavY(delta) {
  const els = stageElements(menu.stage);
  const rows = [...new Set(els.map((el) => Number(el.dataset.row)))].sort((a, b) => a - b);
  if (rows.length < 2) return;
  const i = rows.indexOf(menu.row);
  const next = clamp((i < 0 ? 0 : i) + delta, 0, rows.length - 1);
  if (rows[next] === menu.row) return;
  menu.row = rows[next];
  // Land on the nearest existing column in the new row (e.g. Hotseat only has col 0).
  const rowEls = els.filter((el) => Number(el.dataset.row) === menu.row);
  const rowCols = rowEls.map((el) => Number(el.dataset.col));
  if (!rowCols.includes(menu.col)) menu.col = rowCols[0] ?? 0;
  menuFocusApply();
  app.audio.play("ui");
}

// Confirm: stages 0/1 just click the focused element (which selects +
// advances, see wireMenu). Stage 2 (hold-to-start) is intentionally NOT
// confirmable by a single tap — only a held press starts the game, so a
// reflexive button press can never instant-launch a game.
function menuSelect() {
  if (menu.stage === 2) return;
  const cur = currentFocusEl();
  if (cur) cur.click();
}

function menuBack() {
  if (menu.stage === 0) return;
  menu.stage -= 1;
  menu.row = 0;
  const els = stageElements(menu.stage);
  menu.col = els.length ? Number(els[0].dataset.col) : 0;
  refreshStageVisibility();
  menuFocusApply();
  app.audio.play("ui");
}

function advanceStage() {
  if (menu.stage >= STAGE_IDS.length - 1) return;
  menu.stage += 1;
  menu.row = 0;
  const els = stageElements(menu.stage);
  menu.col = els.length ? Number(els[0].dataset.col) : 0;
  refreshStageVisibility();
  menuFocusApply();
}

// Active input scheme changed → refresh device-appropriate hints.
function onSchemeChange(scheme) {
  document.body.setAttribute("data-scheme", scheme);
  if (app.ui) app.ui.hint(hintFor());
  updateCommitButton();
}

function wireMenu() {
  // Difficulty (stage 0): select + advance, never starts anything.
  document.querySelectorAll("[data-diff]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-diff]").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      app.config.difficulty = b.getAttribute("data-diff");
      app.audio.play("ui");
      if (menu.stage === 0) {
        menu.col = Number(b.dataset.col);
        advanceStage();
      }
    });
  });

  // Play type (stage 1): select + advance. Does NOT start the game — only
  // records the choice; the hold-to-start button (stage 2) actually starts.
  const modeBind = (id, overrides) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", () => {
      document.querySelectorAll("#stageMode .play-btn").forEach((x) => x.classList.remove("sel"));
      el.classList.add("sel");
      Object.assign(app.config, overrides);
      app.audio.play("ui");
      if (menu.stage === 1) {
        menu.row = Number(el.dataset.row);
        menu.col = Number(el.dataset.col);
        advanceStage();
      }
    });
  };
  modeBind("playPrisoner", { humanRole: "Prisoner", mode: "single" });
  modeBind("playWatcher", { humanRole: "Watcher", mode: "single" });
  modeBind("playHotseat", { humanRole: "Prisoner", mode: "hotseat" });

  // Hold-to-start (stage 2): press-and-hold via mouse/touch. Keyboard and
  // gamepad holds are polled each frame in loop() (see holdProgress).
  const holdBtn = document.getElementById("holdStartBtn");
  if (holdBtn) {
    const down = (e) => { e.preventDefault(); mouseHoldDown = true; app.audio.resume(); };
    const up = () => { mouseHoldDown = false; };
    holdBtn.addEventListener("mousedown", down);
    holdBtn.addEventListener("touchstart", down, { passive: false });
    ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((ev) =>
      holdBtn.addEventListener(ev, up)
    );
  }

  document.getElementById("btnRestart")?.addEventListener("click", () => {
    app.audio.resume(); app.audio.play("ui"); startGame(app.config);
  });
  document.getElementById("btnMenu")?.addEventListener("click", () => {
    app.audio.resume(); app.audio.play("ui"); openMenu();
  });

  const backBtn = document.querySelectorAll("#menu .stage-back");
  backBtn.forEach((b) => b.addEventListener("click", menuBack));

  const buildEl = document.getElementById("buildLabel");
  if (buildEl) buildEl.textContent = BUILD;
}

const HOLD_DURATION = 0.6; // seconds

// Polled every frame from loop(): advances the hold-to-start progress bar
// from whichever input is currently pressing it (keyboard/gamepad/mouse),
// and starts the game only once the hold completes.
function updateHoldToStart(dt) {
  const fill = document.getElementById("holdFill");
  const btn = document.getElementById("holdStartBtn");
  if (app.input.mode !== "menu" || menu.stage !== 2) {
    if (holdProgress !== 0 && fill) fill.style.width = "0%";
    holdProgress = 0;
    if (btn) btn.classList.remove("holding");
    return;
  }
  const kbHeld = app.input.isHeld("Enter") || app.input.isHeld("Space");
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const padHeld = !!(pads && pads[0] && pads[0].buttons[0] && pads[0].buttons[0].pressed);
  const held = kbHeld || padHeld || mouseHoldDown;

  if (held) {
    holdProgress = Math.min(1, holdProgress + dt / HOLD_DURATION);
    if (btn) btn.classList.add("holding");
  } else {
    holdProgress = Math.max(0, holdProgress - dt * 3); // quick release-decay
    if (btn) btn.classList.remove("holding");
  }
  if (fill) fill.style.width = `${Math.round(holdProgress * 100)}%`;
  if (holdProgress >= 1) {
    holdProgress = 0;
    if (fill) fill.style.width = "0%";
    if (btn) btn.classList.remove("holding");
    startGame(app.config);
  }
}

function startGame(overrides = {}) {
  Object.assign(app.config, overrides);
  app.stagedPath = [];
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
  app.input.mode = "game";

  app.audio.resume();
  app.audio.startMusic(); // continuous; idempotent if already playing
  app.ui.showHud();
  app.ui.updateHud(app.game, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(app.game);
  app.ui.hint(hintFor());
  updateCommitButton();

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

// Device-adaptive control hints (Brain: device-adaptive-ui / show-the-active
// scheme). Labels use words, not glyphs, so nobody presses blind (test#E3).
function updateCommitButton() {
  const btn = document.getElementById("commitBtn");
  if (!btn) return;
  const g = app.game;
  if (!g) return;
  if (g.turn === "Prisoner") {
    btn.textContent = app.stagedPath.length ? "Commit Move" : "End Turn";
  } else {
    btn.textContent = "Scan & End Turn";
  }
}

function hintFor() {
  const g = app.game;
  if (!g) return "";
  const scheme = app.input ? app.input.activeScheme : "keyboard";
  const prisoner = g.turn === "Prisoner";
  const staged = app.stagedPath.length > 0;
  if (scheme === "gamepad") {
    if (prisoner) {
      return staged
        ? "Stick / D-pad: extend or undo the path  ·  A: commit the move  ·  Start: change view"
        : "Left stick / D-pad: plan a path (traced, not moved yet)  ·  A: end turn  ·  Start: change view";
    }
    return "LB / RB: rotate gaze  ·  Y / B / X: bluff  ·  A: scan & end turn  ·  Start: change view";
  }
  if (scheme === "touch") {
    if (prisoner) {
      return staged
        ? "Tap arrows to extend/undo the path  ·  Commit: move for real  ·  View: change camera"
        : "Tap arrows to plan a path (traced, not moved yet)  ·  End: end turn  ·  View: change camera";
    }
    return "Rotate / bluff with the buttons  ·  Scan: end turn  ·  View: change camera";
  }
  if (prisoner) {
    return staged
      ? "WASD / arrows: extend or undo the path  ·  Space: commit the move  ·  V: view"
      : "WASD / arrows: plan a path (traced on the floor, not moved yet)  ·  Space: end turn  ·  V: view  ·  reach the green gate";
  }
  return "Q / E: rotate 90°  ·  1-4: bluff a direction  ·  Space: scan & end turn  ·  V: view";
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
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
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
  if (intent === "move") {
    stagePathExtend(arg);
  } else if (intent === "endTurn") {
    // The confirm button is overloaded: commit a staged path if one exists,
    // otherwise it means "I have nothing left to plan — end my turn."
    if (app.stagedPath.length) commitStagedPath();
    else doEndPrisonerTurn();
  }
}

// ---- Staged movement: nothing moves for real until the player commits ----
// (Brain telegraph#E6: a cosmetic/preview stays presentation-only; only what
// has real consequence touches authoritative state — here, the preview never
// calls moveActivePrisoner until commit.)

function resetStagedPath() {
  if (app.stagedPath.length) app.stagedPath = [];
}

// Extend or retract the staged path by one tile in `dir`. Doors and switches
// don't relocate the character, so they resolve immediately — but only when
// adjacent to the prisoner's REAL position (path empty); previewing "through"
// an unopened door/switch mid-path isn't meaningful, since global door state
// can't be safely speculated on.
function stagePathExtend(dir) {
  const g = app.game;
  if (!g || g.turn !== "Prisoner") return;
  const p = g.prisoners[g.activePrisoner];
  const path = app.stagedPath;

  // Opposite of the last staged step: undo it (planning backtrack).
  if (path.length && path[path.length - 1].dir === (dir + 2) % 4) {
    path.pop();
    app.audio.play("move");
    app.ui.hint(hintFor());
  updateCommitButton();
    return;
  }

  const from = path.length ? path[path.length - 1] : { x: p.x, y: p.y };
  const { dx, dy } = DIR_VEC[dir];
  const nx = from.x + dx;
  const ny = from.y + dy;
  const obj = objAt(g, nx, ny);

  if (obj === OBJ.SWITCH || (obj === OBJ.DOOR && !isDoorOpen(g, nx, ny))) {
    if (path.length === 0) {
      const r = moveActivePrisoner(g, dir);
      if (r.ok) {
        if (r.event === "door-open") app.audio.play("door");
        else if (r.event === "switch") app.audio.play("switch");
        app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
        app.ui.renderLog(g);
      }
    } else {
      app.audio.play("blocked"); // can't preview past an unresolved door/switch
    }
    return;
  }

  if (path.length >= p.mp) { app.audio.play("blocked"); return; }
  if (!isWalkable(g, nx, ny)) { app.audio.play("blocked"); return; }

  path.push({ x: nx, y: ny, dir });
  app.audio.play("move");
  app.ui.hint(hintFor());
  updateCommitButton();
}

// Replay the staged steps as real moves, in order — the same events/audio the
// old per-keypress code produced, just batched behind one confirm press.
// Apply the whole staged path to the authoritative sim immediately (Brain
// telegraph#E6: the commit IS the real consequence, resolves now), but hand
// the resulting tile sequence to the renderer as a walk queue so the avatar
// visibly steps through it — audio/banner/game-over are deferred to match
// each tile's actual visual arrival (see loop()).
function commitStagedPath() {
  const g = app.game;
  const path = app.stagedPath;
  if (!g || !path.length) return;
  const p = g.prisoners[g.activePrisoner];
  const fromTile = { x: p.x, y: p.y };
  const walkSteps = [];
  for (const step of path) {
    if (isOver(g)) break;
    const r = moveActivePrisoner(g, step.dir);
    if (!r.ok) break; // defensive; steps were pre-validated as walkable
    walkSteps.push({ x: p.x, y: p.y, event: r.event });
  }
  app.stagedPath = [];
  app.renderer.walkTo(fromTile, walkSteps);
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(g);
  app.ui.hint(hintFor());
  updateCommitButton();
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
  updateCommitButton();
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
  updateCommitButton();
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
    app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
    app.ui.renderLog(g);
    if (!isOver(g)) app.ui.banner("Your move", "prisoner");
    app.ui.hint(hintFor());
  updateCommitButton();
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
    app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
    app.ui.renderLog(g);
    if (!isOver(g)) app.ui.banner("Watcher's turn — your move", "watcher");
    app.ui.hint(hintFor());
  updateCommitButton();
  }, 650);
}

// The in-game AI prisoner uses the shared BFS pathing policy. After it acts we
// surface any noise it created as pings so the human Watcher gets feedback.
function aiPrisonerTurn(g) {
  prisonerAITurn(g);
  for (const n of g.noise) app.renderer.triggerPing(n.x, n.y);
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

// The reciprocal: is the CURRENT viewer legitimately "being" the Watcher right
// now? Only then may the gaze wedge, bluff wedge, Watcher's noise-intel, or
// the HUD's facing text be shown — never to a Prisoner-role human, and never
// during an AI Watcher's turn (a single-player Prisoner must never read the
// AI's facing off the HUD, or it trivially dodges every scan).
function shouldShowWatcherInfo() {
  if (!app.game) return false;
  if (app.config.humanRole === "Watcher" && app.config.mode === "single") return true;
  if (app.config.mode === "hotseat") return app.game.turn === "Watcher";
  return false; // single-player Prisoner (vs AI Watcher)
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
  if (app.ui && app.game) app.ui.updateHud(app.game, app.viewMode, humanLabel(), shouldShowWatcherInfo());
}

// ---- End condition -------------------------------------------------------

function checkOver() {
  const g = app.game;
  if (g && isOver(g)) {
    app.running = false;
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
  updateHoldToStart(dt);
  // Safety net: a staged path only makes sense during the Prisoner's own turn.
  if (app.game && app.game.turn !== "Prisoner") resetStagedPath();
  if (app.renderer && app.game) {
    const activePrisoner = app.game.prisoners[app.game.activePrisoner];
    const result = app.renderer.update(app.game, dt, {
      showPrisoner: shouldShowPrisoner(),
      showWatcherInfo: shouldShowWatcherInfo(),
      stagedPath: app.stagedPath,
      selfNoise: (activePrisoner && activePrisoner.selfNoise) || [],
    });
    // The avatar just visually arrived at one or more committed tiles — fire
    // that tile's audio/ping now (matching the footstep, not the sim resolve).
    if (result && result.arrived && result.arrived.length) {
      for (const step of result.arrived) {
        if (step.event === "glass") { app.audio.play("glass"); app.renderer.triggerPing(step.x, step.y); }
        else if (step.event === "exit") { app.audio.play("escape"); app.ui.banner("ESCAPED!", "good"); }
        else app.audio.play("move");
      }
      // Only check game-over once the whole committed path has finished
      // walking — an escape shouldn't end the game before you've visibly
      // reached the gate.
      if (app.renderer.walk.queue.length === 0) checkOver();
    }
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
