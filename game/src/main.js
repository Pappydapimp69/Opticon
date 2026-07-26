// main.js — Opticon 3D entry point. Wires map + rules + AI + render + input + UI
// into a playable game: menu → play (single-player vs AI, or hotseat) → game over.

import { generateMap, MAP_DEFAULTS, DIR_VEC, OBJ, ITEM_KINDS, ITEM_INFO } from "./map.js";
import {
  createGame,
  moveActivePrisoner,
  breakWindow,
  endPrisonerTurn,
  rotateWatcher,
  setBluff,
  watcherScan,
  endWatcherTurn,
  isOver,
  objAt,
  isWalkable,
  isDoorOpen,
  isExposed,
  useItem,
  useSkill,
  skillUsable,
  inWatcherGaze,
  SKILLS,
  SKILL_INFO,
} from "./rules.js";
import { playWatcherTurn } from "./watcherAI.js";
import { prisonerAITurn } from "./prisonerAI.js";
import { Renderer } from "./render.js";
import { Input } from "./input.js";
import { Audio } from "./audio.js";
import { UI } from "./ui.js";

const BUILD = "beta-0.27.0";

// AI companions: single-player modes field a small GROUP of prisoners (the
// design doc's "Population Scaling" — more prisoners means more paranoia,
// since the Watcher's limited actions have to spread across all of them),
// not just the human/single AI opponent. Hotseat stays 1-vs-1 — pass-the-
// device secrecy for a whole GROUP of human-controlled prisoners is a much
// bigger UX problem than this pass takes on.
const PRISONER_COUNT = 3;

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
  cutsceneActive: false,
};

// Persisted across sessions: difficulty pick + audio volume. Small and
// non-essential, so a read/write failure (private browsing, storage full)
// degrades to defaults rather than breaking boot.
const SETTINGS_KEY = "opticon.settings.v1";
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}
function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ difficulty: app.config.difficulty, volume: app.audio.volume })
    );
  } catch {
    /* ignore */
  }
}

function boot() {
  const canvas = document.getElementById("gl");
  app.renderer = new Renderer(canvas);
  app.audio = new Audio();
  app.ui = new UI(document.body);
  app.input = new Input(handleIntent, { onScheme: onSchemeChange });
  app.input.setPassHandler(dismissPassDevice);
  app.input.setMenuHandlers(menuNavX, menuNavY, menuSelect, menuBack);

  const saved = loadSettings();
  if (saved) {
    if (["easy", "medium", "hard"].includes(saved.difficulty)) app.config.difficulty = saved.difficulty;
    if (typeof saved.volume === "number") app.audio.volume = Math.max(0, Math.min(1, saved.volume));
  }

  // Intro + menu Start both require a HOLD, not a tap/click — touch/mouse
  // don't go through the row/col focus system at all, so they get their own
  // plain pointerdown/up flags, polled alongside keyboard/gamepad each frame
  // in pollIntroHold()/pollStartHold() (see loop()).
  const introEl = document.getElementById("intro");
  if (introEl) {
    introEl.addEventListener("pointerdown", () => { introPointerDown = true; });
    introEl.addEventListener("pointerup", () => { introPointerDown = false; });
    introEl.addEventListener("pointercancel", () => { introPointerDown = false; });
    introEl.addEventListener("pointerleave", () => { introPointerDown = false; });
  }
  const startEl = document.getElementById("btnStart");
  if (startEl) {
    startEl.addEventListener("pointerdown", () => { startPointerDown = true; });
    startEl.addEventListener("pointerup", () => { startPointerDown = false; });
    startEl.addEventListener("pointercancel", () => { startPointerDown = false; });
    startEl.addEventListener("pointerleave", () => { startPointerDown = false; });
  }
  const passEl = document.getElementById("passDevice");
  if (passEl) passEl.addEventListener("pointerdown", dismissPassDevice);

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

// ---- Intro splash + menu navigation ----------------------------------------
//
// NOTE: an earlier revision gated this behind 3 locked stages ending in a
// press-and-hold "start" — that had no resume path, so opening the menu
// mid-game (or from the game-over screen) abandoned the current run and the
// ONLY way back into play was completing the whole flow again, generating a
// brand-new game every time. Removed per explicit feedback, then
// reintroduced here in a form that avoids that flaw: selecting a play mode
// now only records app.config and moves focus to a Start button — it never
// calls startGame() itself, so re-opening the menu mid-game via btnMenu still
// just shows the (harmless, re-selectable) menu state, exactly as before.
// Only actually HOLDING the Start button starts a new game. Row/col-aware
// nav (so up/down/left/right can't wander onto the wrong control) and the
// safe default focus (Medium, not a play button) are unchanged.

const menu = { row: 0, col: 1 }; // col:1 = Medium — the default focus, never a play button
let introDone = false;

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

// ---- Hold-to-confirm: intro splash + menu Start button --------------------
// Both need a device-spanning "held for N ms" check: keyboard via
// input.isHeld(code), gamepad via input.isPadHeld(i), and touch/mouse via a
// plain pointerdown/up flag (touch doesn't go through the row/col focus
// system). This is polled once per animation frame in loop() rather than
// dispatched from input.js, since "held" isn't an edge/event the way a
// keydown or button-press is — it's a continuous state over time.
const HOLD_MS = 650;
let introHeldSince = null;
let introPointerDown = false;
let startHeldSince = null;
let startPointerDown = false;

function pollIntroHold(t) {
  if (introDone) return;
  const fill = document.getElementById("introHoldFill");
  const held = app.input.isHeld("Space") || app.input.isPadHeld(2) || introPointerDown;
  if (held) {
    if (introHeldSince == null) introHeldSince = t;
    const p = Math.min(1, (t - introHeldSince) / HOLD_MS);
    if (fill) fill.style.width = `${p * 100}%`;
    if (p >= 1) dismissIntro();
  } else {
    introHeldSince = null;
    if (fill) fill.style.width = "0%";
  }
}

function pollStartHold(t) {
  const btn = document.getElementById("btnStart");
  const fill = document.getElementById("startHoldFill");
  if (!btn) return;
  if (app.input.mode !== "menu") {
    startHeldSince = null;
    if (fill) fill.style.width = "0%";
    btn.classList.remove("charging");
    return;
  }
  const focusedOnStart = currentFocusEl() === btn;
  const held =
    startPointerDown ||
    (focusedOnStart && (app.input.isHeld("Space") || app.input.isHeld("Enter") || app.input.isPadHeld(0)));
  if (held) {
    if (startHeldSince == null) startHeldSince = t;
    const p = Math.min(1, (t - startHeldSince) / HOLD_MS);
    if (fill) fill.style.width = `${p * 100}%`;
    btn.classList.add("charging");
    if (p >= 1) {
      startHeldSince = null;
      if (fill) fill.style.width = "0%";
      btn.classList.remove("charging");
      app.audio.resume();
      app.audio.play("ui");
      startGame(app.config);
    }
  } else {
    startHeldSince = null;
    if (fill) fill.style.width = "0%";
    btn.classList.remove("charging");
  }
}

// Hotseat pass-the-device gate: a turn switch happens instantly in game
// state, but the physical device handoff does not — without this, the
// OUTGOING player's screen would show the incoming player's privileged view
// (e.g. the Watcher's true gaze) for a moment before they hand the device
// over. Blocks input/rendering-relevant state (app.running, input.mode)
// until the incoming player confirms; only then does the camera/HUD switch.
function showPassDevice() {
  const g = app.game;
  if (!g) return;
  const el = document.getElementById("passDevice");
  const title = document.getElementById("passDeviceTitle");
  if (title) {
    title.textContent = `Pass to the ${g.turn}`;
    title.className = g.turn === "Watcher" ? "watcher" : "prisoner";
  }
  if (el) el.classList.remove("hidden");
  app.running = false;
  app.input.mode = "pass";
}

function dismissPassDevice() {
  const el = document.getElementById("passDevice");
  if (el) el.classList.add("hidden");
  const g = app.game;
  if (!g) return;
  app.audio.resume();
  app.audio.play("ui");
  if (g.turn === "Watcher") {
    setView("watcher");
    app.ui.banner("Watcher's turn", "watcher");
  } else {
    setView("prisoner");
    app.ui.banner("Prisoner's turn", "prisoner");
  }
  app.running = true;
  app.input.mode = "game";
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(hintFor());
  updateCommitButton();
}

function openMenu() {
  app.running = false;
  app.ui.showMenu();
  app.input.mode = "menu";
  menu.row = 0;
  menu.col = ["easy", "medium", "hard"].indexOf(app.config.difficulty);
  if (menu.col < 0) menu.col = 1;
  menuFocusApply();
  applyVolumeUI(); // pick up a mid-game HUD mute toggle if one happened
  document.querySelectorAll(".play-btn").forEach((x) => x.classList.remove("sel"));
  updateStartLabel(); // reflect current app.config even if reopened mid-game
}

// Same row/col grid nav drives both the main menu AND the game-over overlay
// (two different screens, same "is this a gamepad-focusable grid" shape) —
// scope the query to whichever one is actually showing.
function menuElements() {
  const root = app.input && app.input.mode === "overlay" ? "#overlay" : "#menu";
  return Array.from(document.querySelectorAll(`${root} [data-row]`));
}

function currentFocusEl() {
  return menuElements().find(
    (el) => Number(el.dataset.row) === menu.row && Number(el.dataset.col) === menu.col
  );
}

function menuFocusApply() {
  document.querySelectorAll(".gpfocus").forEach((el) => el.classList.remove("gpfocus"));
  const cur = currentFocusEl();
  if (cur) {
    cur.classList.add("gpfocus");
    if (cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
}

// Axis-correct: horizontal nav only ever moves column within the current
// row; vertical nav only ever moves to an adjacent row (landing on that
// row's nearest column) — a single button grid across the whole menu, not a
// flat list, so no direction can ever "skip" onto the wrong control.
function menuNavX(delta) {
  const els = menuElements().filter((el) => Number(el.dataset.row) === menu.row);
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
  const rows = [...new Set(menuElements().map((el) => Number(el.dataset.row)))].sort((a, b) => a - b);
  if (rows.length < 2) return;
  const i = rows.indexOf(menu.row);
  const next = clamp((i < 0 ? 0 : i) + delta, 0, rows.length - 1);
  if (rows[next] === menu.row) return;
  menu.row = rows[next];
  const rowCols = menuElements()
    .filter((el) => Number(el.dataset.row) === menu.row)
    .map((el) => Number(el.dataset.col));
  if (!rowCols.includes(menu.col)) menu.col = rowCols[0] ?? 0;
  menuFocusApply();
  app.audio.play("ui");
}

function menuSelect() {
  const cur = currentFocusEl();
  if (!cur) return;
  // Start requires a HOLD (tracked every frame in pollStartHold), not an
  // edge-triggered click — a single A-press here must not start the game.
  if (cur.id === "btnStart") return;
  cur.click();
}

function menuBack() {} // no stages to back out of anymore; kept as a no-op so input.js's binding stays valid

// Active input scheme changed → refresh device-appropriate hints.
function onSchemeChange(scheme) {
  document.body.setAttribute("data-scheme", scheme);
  if (app.ui) app.ui.hint(hintFor());
  updateCommitButton();
}

function wireMenu() {
  // Difficulty: select only, never starts anything.
  document.querySelectorAll("[data-diff]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-diff]").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      app.config.difficulty = b.getAttribute("data-diff");
      app.audio.play("ui");
      saveSettings();
    });
  });

  // Volume: discrete steps (not a slider) so it works identically across
  // mouse/touch/keyboard/gamepad via the same row/col grid nav as everything
  // else in this menu — no separate drag-input handling to build or test.
  document.querySelectorAll("[data-vol]").forEach((b) => {
    b.addEventListener("click", () => {
      app.audio.setVolume(Number(b.getAttribute("data-vol")));
      applyVolumeUI();
      app.audio.play("ui");
      saveSettings();
    });
  });

  document.getElementById("btnSound")?.addEventListener("click", () => {
    app.audio.resume();
    app.audio.toggleMute();
    applyVolumeUI();
    if (app.audio.volume > 0) app.audio.play("ui");
    saveSettings();
  });

  // Play type: selecting records app.config and moves focus to the Start
  // row — it does NOT start the game itself (see the NOTE above).
  const modeBind = (id, overrides) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", () => {
      app.audio.resume(); app.audio.play("ui");
      document.querySelectorAll(".play-btn").forEach((x) => x.classList.remove("sel"));
      el.classList.add("sel");
      Object.assign(app.config, overrides);
      saveSettings();
      updateStartLabel();
      focusStartRow();
    });
  };
  modeBind("playPrisoner", { humanRole: "Prisoner", mode: "single" });
  modeBind("playWatcher", { humanRole: "Watcher", mode: "single" });
  modeBind("playHotseat", { humanRole: "Prisoner", mode: "hotseat" });

  document.getElementById("btnRestart")?.addEventListener("click", () => {
    app.audio.resume(); app.audio.play("ui"); startGame(app.config);
  });
  document.getElementById("btnMenu")?.addEventListener("click", () => {
    app.audio.resume(); app.audio.play("ui"); openMenu();
  });

  const buildEl = document.getElementById("buildLabel");
  if (buildEl) buildEl.textContent = BUILD;

  applyVolumeUI(); // reflect whatever setting boot() loaded (saved or default)
  updateStartLabel();
}

// data-row of the menu's Start button — kept as one constant since both
// focusStartRow() and pollStartHold() need the same value.
const START_ROW = 4;

function focusStartRow() {
  menu.row = START_ROW;
  menu.col = 0;
  menuFocusApply();
}

// Reflects whichever play mode is currently selected (or was already active,
// if the menu was reopened mid-game via btnMenu) on the Start button, so
// holding it is never a guess about what's about to launch.
function updateStartLabel() {
  const el = document.getElementById("startLabel");
  if (!el) return;
  const label = app.config.mode === "hotseat" ? "2P Hotseat" : app.config.humanRole;
  el.textContent = `Hold to Start — ${label}`;
}

// Keep the menu's Off/Low/Medium/Full buttons and the HUD mute icon in sync
// with app.audio.volume, whatever set it (menu click, HUD toggle, or a
// value restored from localStorage on boot).
function applyVolumeUI() {
  const v = app.audio.volume;
  document.querySelectorAll("[data-vol]").forEach((b) => {
    b.classList.toggle("sel", Math.abs(Number(b.getAttribute("data-vol")) - v) < 0.001);
  });
  const btn = document.getElementById("btnSound");
  if (btn) btn.textContent = v > 0 ? "🔊" : "🔇";
}

function startGame(overrides = {}) {
  Object.assign(app.config, overrides);
  app.stagedPath = [];
  breakArmed = false;
  updateBreakToggleUI();
  // Fresh seed each game for variety, but reproducible within a game.
  app.config.seed = (Math.floor(Math.random() * 1e9) >>> 0) || 1;
  const prisonerCount = app.config.mode === "hotseat" ? 1 : PRISONER_COUNT;
  const map = generateMap(app.config.seed, { ...MAP_DEFAULTS, prisonerCount });
  app.game = createGame(map, { watcherFacing: 0, prisoners: map.spawns });
  app.game.prisoners.forEach((p) => (p.mpMax = 3));
  animatingPrisoner = 0;
  armedItem = null;

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
  app.ui.renderLog(app.game, shouldShowWatcherInfo());
  updateCommitButton();

  playIntroCutscene();

  // If human is Watcher, the AI prisoner acts first each round.
  if (app.config.humanRole === "Watcher" && app.config.mode === "single") {
    // Prisoner AI takes its turn immediately, then it's the human Watcher's turn.
    scheduleAiPrisoner();
  }
}

// "Lay of the land": a scripted camera flythrough played once per game start
// (map is procedurally regenerated every game, so the sweep is never stale).
// Per-prisoner close-ups are shown ONLY when the viewer is legitimately
// allowed to know spawn locations up front — never a Watcher-role human, and
// never in hotseat (pass-the-device secrecy predates this feature; a shared
// physical screen seeing every prisoner's start before the first pass-gate
// would undercut it). Any intent — move, rotate, restart, anything — skips
// straight to the real starting gameplay camera; see handleIntent().
function playIntroCutscene() {
  app.cutsceneActive = true;
  const showPrisoners = app.config.mode === "single" && app.config.humanRole === "Prisoner";
  app.cutsceneShowPrisoners = showPrisoners;
  app.ui.hint("Press any control to skip");
  app.renderer
    .playIntro(app.game, { viewedPrisoner: humanPrisonerIndex(), showPrisoners })
    .then(() => {
      app.cutsceneActive = false;
      app.ui.hint(hintFor());
    });
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
  // Only advertise item controls when something is actually carried —
  // otherwise the hint teaches a verb the player has no way to perform yet.
  const carrying = prisoner && humanControlsPrisoner() &&
    !!(g.prisoners[g.activePrisoner] || {}).items?.length;
  if (scheme === "gamepad") {
    if (prisoner) {
      return staged
        ? "Stick / D-pad: extend or undo the path  ·  A: commit the move  ·  Start: change view"
        : "Left stick / D-pad: plan a path  ·  A: end turn  ·  Hold RB + direction: break a window" + (carrying ? "  ·  LT: pick item, RT: use" : "") + "  ·  Start: change view";
    }
    return "LB / RB: rotate gaze  ·  Y / B / X: bluff  ·  LT: pick skill, RT: use  ·  A: scan & end turn  ·  Start: change view";
  }
  if (scheme === "touch") {
    if (prisoner) {
      return staged
        ? "Tap arrows to extend/undo the path  ·  Commit: move for real  ·  View: change camera"
        : "Tap arrows to plan a path  ·  💥: arm a window break, then tap a direction" + (carrying ? "  ·  tap an item, then a direction" : "") + "  ·  End: end turn  ·  View: change camera";
    }
    return "Rotate / bluff with the buttons  ·  tap a skill to use it  ·  Scan: end turn  ·  View: change camera";
  }
  if (prisoner) {
    return staged
      ? "WASD / arrows: extend or undo the path  ·  Space: commit the move  ·  V: view"
      : "WASD / arrows: plan a path  ·  Shift + direction: break a window" + (carrying ? "  ·  1-2: use an item" : "") + "  ·  Space: end turn  ·  V: view  ·  reach the green gate";
  }
  return "Q / E: rotate 90°  ·  1-4: bluff  ·  5-8: skills  ·  Space: scan & end turn  ·  V: view";
}

// ---- Intent handling -----------------------------------------------------

function handleIntent(intent, arg) {
  // Any control skips the cutscene straight to the real starting camera
  // (same computeCameraTarget the full playback converges on — see
  // render.js's playIntro/skipIntro) rather than acting on the intent.
  if (app.cutsceneActive) {
    app.renderer.skipIntro();
    if (intent === "restart") startGame(app.config);
    return;
  }
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
  app.ui.renderLog(g, shouldShowWatcherInfo());
}

// With multiple prisoners, "is the CURRENTLY active prisoner human?" is not
// the same question as "did the human pick the Prisoner role" — a human
// Prisoner player always controls prisoner 0 specifically; any companion
// (prisoner index > 0) is AI-controlled even in that same mode.
function humanControlsPrisoner() {
  if (app.config.mode === "hotseat") return true; // hotseat is always exactly 1 prisoner
  if (app.config.humanRole !== "Prisoner") return false; // human plays Watcher; every prisoner is AI
  const g = app.game;
  return !g || g.activePrisoner === 0;
}
function humanControlsWatcher() {
  return app.config.mode === "hotseat" || app.config.humanRole === "Watcher";
}

// The prisoner index whose eyes the human is watching through — always 0
// (hotseat is exactly 1 prisoner; companions are always spawned at index
// 1+). Distinct from `game.activePrisoner` (whoever's turn it is RIGHT NOW,
// which cycles through companions automatically). Camera, FoV, the exposure
// vignette, and self-noise cues must all track this, not the acting index —
// otherwise a companion's automated turn yanks the human's camera/vignette
// onto a teammate instead of reflecting the human's own risk.
function humanPrisonerIndex() {
  return 0;
}

// Touch has no Shift/RB modifier to hold, so a toggle arms the NEXT dpad tap
// as a break instead of a move — cleared the moment it's used (or the turn
// changes), so it can never linger and silently reinterpret a later tap.
let breakArmed = false;

// Same "arm, then press a direction" gesture as breakArmed, for the two
// items that act on an adjacent tile plus the thrown decoy. Holds the item
// KIND (not a slot index) so a pickup landing mid-arm can't shift what the
// next direction press spends. Cleared on use, on turn change, and whenever
// breakArmed is armed — the two are mutually exclusive modes.
let armedItem = null;

// Which slot the gamepad's LT/RT pair currently points at. Shared by the
// item belt and the skill row — whose list it indexes is decided by turn,
// so one cursor serves both without a second binding.
let padSlot = 0;

// Which prisoner's avatar is (or was last) mid walk-animation — each
// prisoner now has its own independent walk queue in the renderer, so
// checking "is the walk finished" needs to know WHICH one, not just
// whether some single shared queue is empty.
let animatingPrisoner = 0;
function updateBreakToggleUI() {
  const btn = document.getElementById("breakToggle");
  if (btn) btn.classList.toggle("armed", breakArmed);
}

function handlePrisonerIntent(intent, arg) {
  if (!humanControlsPrisoner()) return; // AI prisoner; ignore input
  if (intent === "toggleBreak") {
    breakArmed = !breakArmed;
    if (breakArmed) armedItem = null; // mutually exclusive modes
    app.audio.play("ui");
    updateBreakToggleUI();
    return;
  }
  if (intent === "item") {
    armItemSlot(arg);
    return;
  }
  // Gamepad slot cursor: on the Prisoner's turn it indexes the item belt.
  if (intent === "slotCursor") {
    padSlot = arg;
    _itemBarSig = ""; // force a repaint so the highlight moves
    return;
  }
  if (intent === "useSlot") {
    armItemSlot(padSlot);
    return;
  }
  if (intent === "break") {
    doBreakWindow(arg);
    return;
  }
  if (intent === "move") {
    if (armedItem) {
      const kind = armedItem;
      armedItem = null;
      updateItemBar();
      doUseItem(kind, arg);
      return;
    }
    if (breakArmed) {
      breakArmed = false;
      updateBreakToggleUI();
      doBreakWindow(arg);
      return;
    }
    stagePathExtend(arg);
  } else if (intent === "endTurn") {
    // The confirm button is overloaded: commit a staged path if one exists,
    // otherwise it means "I have nothing left to plan — end my turn."
    if (app.stagedPath.length) commitStagedPath();
    else doEndPrisonerTurn();
  }
}

// Breaking a window always acts on the prisoner's REAL current position
// (rules.js's breakWindow, like door/switch, never relocates the mover) —
// so it's refused outright while a move is still staged (unresolved),
// rather than silently breaking relative to a position the player hasn't
// actually committed to yet.
function doBreakWindow(dir) {
  const g = app.game;
  if (!g || g.turn !== "Prisoner") return;
  if (app.stagedPath.length) {
    app.audio.play("blocked");
    return;
  }
  const r = breakWindow(g, dir);
  if (r.ok) {
    app.audio.play("glass");
    app.renderer.triggerPing(r.x, r.y);
  } else {
    app.audio.play("blocked");
  }
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(hintFor());
  updateCommitButton();
}

// ---- Items ---------------------------------------------------------------

// Arm the item in inventory slot `slot`. MUFFLE takes no direction, so it
// resolves immediately rather than arming and waiting for a press that would
// mean nothing.
function armItemSlot(slot) {
  const g = app.game;
  if (!g || g.turn !== "Prisoner") return;
  const p = g.prisoners[g.activePrisoner];
  const kind = p && p.items[slot];
  if (!kind) {
    app.audio.play("blocked");
    return;
  }
  if (kind === ITEM_KINDS.MUFFLE) {
    doUseItem(kind, null);
    return;
  }
  breakArmed = false;
  updateBreakToggleUI();
  armedItem = armedItem === kind ? null : kind;
  app.audio.play("ui");
  updateItemBar();
  app.ui.hint(hintFor());
}

function doUseItem(kind, dirOrNull) {
  const g = app.game;
  if (!g || g.turn !== "Prisoner") return;
  if (app.stagedPath.length) {
    // Same rule as break-window: resolve or clear the staged path first, so
    // an item never fires from a position the player only previewed.
    app.audio.play("blocked");
    return;
  }
  const r = useItem(g, kind, dirOrNull);
  if (r.ok) {
    if (r.event === "distract") {
      app.audio.play("noise");
      app.renderer.triggerPing(r.x, r.y);
    } else if (r.event === "cutters") {
      app.audio.play("switch");
    } else {
      app.audio.play("ui");
    }
  } else {
    app.audio.play("blocked");
  }
  updateItemBar();
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(hintFor());
  updateCommitButton();
}

// Rebuild the on-screen inventory chips. Only ever shows the HUMAN's own
// prisoner — a companion's belt is not the player's to see or spend.
// Driven from loop() rather than from each of the many places inventory can
// change (pickup on commit, use, turn handoff, new game) — the multi-handoff
// audit problem that bit the 1→N prisoner scale-out (memory E10). The
// signature guard makes a per-frame call free when nothing changed, so
// there's no call site left to forget.
let _itemBarSig = "";
function updateItemBar() {
  const bar = document.getElementById("itemBar");
  if (!bar) return;
  const g = app.game;
  const show = g && g.turn === "Prisoner" && humanControlsPrisoner();
  const p = show ? g.prisoners[g.activePrisoner] : null;
  const sig = p ? `${p.items.join(",")}|${armedItem || ""}|${padSlot}` : "";
  if (sig === _itemBarSig) return;
  _itemBarSig = sig;
  if (!p || !p.items.length) {
    bar.innerHTML = "";
    bar.classList.add("empty");
    return;
  }
  bar.classList.remove("empty");
  bar.innerHTML = p.items
    .map((kind, i) => {
      const info = ITEM_INFO[kind];
      const armed = (armedItem === kind ? " armed" : "") + (padSlot === i ? " padsel" : "");
      return `<button class="item-chip${armed}" data-intent="item" data-arg="${i}" title="${info.label}">` +
        `<span class="ic">${info.icon}</span><span class="ik">${i + 1}</span></button>`;
    })
    .join("");
  // The chips are rebuilt each time, so re-bind their taps to the same
  // intent pipeline every other on-screen control uses.
  bar.querySelectorAll("[data-intent]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      handleIntent("item", Number(btn.getAttribute("data-arg")));
    });
  });
}

// ---- Watcher skills ------------------------------------------------------

// WIDE_SCAN/ECHO need no target. LOCK needs an open door — rather than
// building a door-picker, it targets the open door nearest the Watcher's
// current facing wedge, which is the one a player aiming that way means.
function doUseSkill(skill) {
  const g = app.game;
  if (!g || g.turn !== "Watcher") return;
  let arg = null;
  if (skill === SKILLS.LOCK) {
    arg = nearestOpenDoorInGaze(g);
    if (!arg) {
      app.audio.play("blocked");
      return;
    }
  }
  const r = useSkill(g, skill, arg);
  if (r.ok) {
    if (r.event === "lock") {
      app.audio.play("blocked");
      app.renderer.triggerPing(r.x, r.y);
    } else if (r.event === "wide-scan") {
      app.audio.play("scan");
    } else {
      app.audio.play("ui");
    }
  } else {
    app.audio.play("blocked");
  }
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(hintFor());
  updateCommitButton();
}

// Prefer an open door inside the true gaze wedge; fall back to the closest
// open door anywhere, so the skill is never a dead button when one exists.
function nearestOpenDoorInGaze(g) {
  const { center } = g.map;
  let best = null;
  let bestScore = Infinity;
  for (const key of g.openedDoors) {
    const x = key % g.map.size;
    const y = Math.floor(key / g.map.size);
    if (objAt(g, x, y) !== OBJ.DOOR) continue;
    if (g.prisoners.some((p) => p.alive && !p.escaped && p.x === x && p.y === y)) continue;
    const d = Math.hypot(x - center.x, y - center.y);
    const inWedge = inWatcherGaze(g, g.watcher.facing, x, y);
    const score = d + (inWedge ? 0 : 1000); // wedge doors always win
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

// The Watcher's cooldown chips. Same signature-guarded, loop()-driven
// refresh as the prisoner item bar, and the same visibility rule: only
// rendered for whoever is legitimately BEING the Watcher right now, so a
// hotseat prisoner can never read the tower's readiness off the screen.
let _skillBarSig = "";
function updateSkillBar() {
  const bar = document.getElementById("skillBar");
  if (!bar) return;
  const g = app.game;
  const show = g && g.turn === "Watcher" && humanControlsWatcher() && shouldShowWatcherInfo();
  if (!show) {
    if (_skillBarSig !== "") {
      _skillBarSig = "";
      bar.innerHTML = "";
      bar.classList.add("empty");
    }
    return;
  }
  const entries = Object.values(SKILLS).map((s) => ({
    skill: s,
    cd: g.watcher.skills[s] || 0,
    usable: skillUsable(g, s),
  }));
  const sig = entries.map((e) => `${e.skill}:${e.cd}:${e.usable ? 1 : 0}`).join("|") + `|${padSlot}`;
  if (sig === _skillBarSig) return;
  _skillBarSig = sig;
  bar.classList.remove("empty");
  bar.innerHTML = entries
    .map((e, i) => {
      const info = SKILL_INFO[e.skill];
      const cls = (e.cd > 0 ? " cooling" : e.usable ? "" : " unusable") + (padSlot === i ? " padsel" : "");
      const badge = e.cd > 0 ? `<span class="cd">${e.cd}</span>` : `<span class="ik">${i + 5}</span>`;
      return `<button class="item-chip skill-chip${cls}" data-skill="${e.skill}" title="${info.label}">` +
        `<span class="ic">${info.icon}</span>${badge}</button>`;
    })
    .join("");
  bar.querySelectorAll("[data-skill]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      handleIntent("skill", btn.getAttribute("data-skill"));
    });
  });
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
        app.ui.renderLog(g, shouldShowWatcherInfo());
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
  animatingPrisoner = g.activePrisoner;
  app.renderer.walkTo(animatingPrisoner, fromTile, walkSteps);
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
  app.ui.renderLog(g, shouldShowWatcherInfo());
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
  if (app.config.mode === "hotseat") {
    showPassDevice(); // block the view until the Watcher's player confirms
  } else if (app.config.humanRole === "Watcher") {
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
    // A second bluff this turn goes through the DOUBLE_BLUFF skill instead
    // of overwriting the first — that's exactly what the skill buys.
    if (g.watcher.bluff != null && arg !== g.watcher.bluff && skillUsable(g, SKILLS.DOUBLE_BLUFF)) {
      if (useSkill(g, SKILLS.DOUBLE_BLUFF, arg).ok) app.audio.play("bluff");
    } else if (setBluff(g, arg).ok) {
      app.audio.play("bluff");
    }
  } else if (intent === "slotCursor") {
    // Same cursor, but on the Watcher's turn it indexes the skill row.
    padSlot = arg;
    _skillBarSig = "";
  } else if (intent === "useSlot") {
    doUseSkill(Object.values(SKILLS)[arg] || SKILLS.WIDE_SCAN);
  } else if (intent === "skill") {
    doUseSkill(arg);
  } else if (intent === "endTurn") {
    // Scan (commit), then end turn.
    const scan = watcherScan(g, app.config.difficulty);
    app.audio.play("scan");
    if (scan.caught) {
      app.audio.play("caught");
      app.ui.banner("CAPTURED!", "bad");
      app.renderer.triggerCaptureFlash(scan.caught.x, scan.caught.y);
    }
    checkOver();
    if (isOver(g)) return;
    endWatcherTurn(g);
    app.audio.play("turn");
    if (app.config.mode === "hotseat") {
      showPassDevice(); // block the view until the Prisoner's player confirms
    } else {
      // Whichever prisoner is active now (human plays only prisoner 0 — any
      // companion, or every prisoner in single-player Watcher mode, is AI).
      if (!isOver(g) && !humanControlsPrisoner()) {
        scheduleAiPrisoner();
      }
      app.ui.hint(hintFor());
      updateCommitButton();
    }
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
        if (a.caught != null) {
          app.audio.play("caught");
          app.ui.banner("CAPTURED!", "bad");
          const caughtP = g.prisoners[a.caught];
          if (caughtP) app.renderer.triggerCaptureFlash(caughtP.x, caughtP.y);
        }
      }
    }
    app.aiThinking = false;
    checkOver();
    app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo());
    app.ui.renderLog(g, shouldShowWatcherInfo());
    // playWatcherTurn already advanced to the next prisoner internally — if
    // that's a companion (not prisoner 0), its AI turn plays automatically
    // too, rather than silently waiting on input that will never come.
    if (!isOver(g)) {
      if (humanControlsPrisoner()) {
        app.ui.banner("Your move", "prisoner");
      } else {
        scheduleAiPrisoner();
      }
    }
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
    app.ui.renderLog(g, shouldShowWatcherInfo());
    // endPrisonerTurn always hands off to the Watcher — but with AI
    // companions, this can fire in single-player Prisoner mode too, where
    // the Watcher is ALSO AI, not the human waiting on this banner.
    if (!isOver(g)) {
      if (humanControlsWatcher()) {
        app.ui.banner("Watcher's turn — your move", "watcher");
      } else {
        scheduleAiWatcher();
      }
    }
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
    setTimeout(() => {
      app.ui.gameOver(g, { difficulty: app.config.difficulty });
      // The overlay's buttons weren't reachable by gamepad/keyboard at all —
      // input.mode stayed "game" (no screen change ever set it), so a
      // gamepad press just fired stale game intents into a game that had
      // already ended. Give the overlay the same row/col grid nav as menu.
      app.input.mode = "overlay";
      menu.row = 0;
      menu.col = 0;
      menuFocusApply();
    }, 700);
  }
}

// ---- Main loop -----------------------------------------------------------

// Exposure vignette: a diegetic "you can be seen" cue, computed from the
// SAME rule watcherScan actually captures with (isExposed), so it's never a
// fake indicator — if it's showing, a scan this instant really would catch
// you. Gated by shouldShowPrisoner() so it can never leak to the Watcher's
// own screen in hotseat (that would just be handing them a free "yes,
// they're exposed right now" the noise/light cues are supposed to make them
// infer themselves).
let dangerActive = false;
function updateDangerVignette() {
  const g = app.game;
  const vignette = document.getElementById("dangerVignette");
  if (!vignette) return;
  let danger = false;
  if (app.running && !app.cutsceneActive && g && !isOver(g) && shouldShowPrisoner()) {
    const p = g.prisoners[humanPrisonerIndex()];
    if (p && p.alive && !p.escaped) {
      danger = isExposed(g, p.x, p.y, app.config.difficulty);
    }
  }
  vignette.classList.toggle("danger", danger);
  if (danger && !dangerActive) app.audio.startHeartbeat();
  else if (!danger && dangerActive) app.audio.stopHeartbeat();
  dangerActive = danger;
}

function loop(t) {
  const dt = Math.min(0.05, (t - app.lastT) / 1000 || 0);
  app.lastT = t;
  if (app.input) app.input.pollGamepad();
  pollIntroHold(t);
  pollStartHold(t);
  updateDangerVignette();
  updateItemBar();
  updateSkillBar();
  // Safety net: a staged path (and an armed break) only make sense during
  // the Prisoner's own turn.
  if (app.game && app.game.turn !== "Prisoner") {
    resetStagedPath();
    if (breakArmed) { breakArmed = false; updateBreakToggleUI(); }
    if (armedItem) { armedItem = null; updateItemBar(); }
  }
  if (app.renderer && app.game) {
    const viewedPrisoner = app.game.prisoners[humanPrisonerIndex()];
    // During the cutscene, avatar visibility follows the SAME gate the
    // close-up waypoints used (never shouldShowPrisoner()'s turn-based
    // hotseat check, which is true by default at game start) — otherwise a
    // wide establishing shot could still incidentally reveal a spawned
    // prisoner to a hotseat viewer who hasn't been gated behind the
    // pass-device screen yet.
    const showPrisoner = app.cutsceneActive ? app.cutsceneShowPrisoners : shouldShowPrisoner();
    const result = app.renderer.update(app.game, dt, {
      showPrisoner,
      showWatcherInfo: shouldShowWatcherInfo(),
      stagedPath: app.stagedPath,
      viewedPrisoner: humanPrisonerIndex(),
      selfNoise: (viewedPrisoner && viewedPrisoner.selfNoise) || [],
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
      const animAvatar = app.renderer.avatars[animatingPrisoner];
      if (!animAvatar || animAvatar.walk.queue.length === 0) checkOver();
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
