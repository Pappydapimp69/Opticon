// main.js — Opticon 3D entry point. Wires map + rules + AI + render + input + UI
// into a playable game: menu → play (single-player vs AI, or hotseat) → game over.

import { generateMap, MAP_DEFAULTS, DIRS, DIR_VEC, OBJ, ITEM_KINDS, ITEM_INFO } from "./map.js";
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
  quadrantOf,
  struggle,
  guardOver,
  CUSTODY_TURNS,
  SKILLS,
  SKILL_INFO,
} from "./rules.js";
import { playWatcherTurn, scoreDirections, DIFFICULTY } from "./watcherAI.js";
import { prisonerAITurn } from "./prisonerAI.js";
import { Renderer } from "./render.js";
import { Input } from "./input.js";
import { Audio } from "./audio.js";
import { UI } from "./ui.js";

const BUILD = "beta-0.53.0";

// AI companions: single-player modes field a small GROUP of prisoners (the
// design doc's "Population Scaling" — more prisoners means more paranoia,
// since the Watcher's limited actions have to spread across all of them),
// not just the human/single AI opponent. Hotseat stays 1-vs-1 — pass-the-
// device secrecy for a whole GROUP of human-controlled prisoners is a much
// bigger UX problem than this pass takes on.
const PRISONER_COUNT = 3;

// AI pacing. The old values (650ms think, no wait for the walk animation)
// made companion turns flash past before you could read them. These give
// each AI turn a beat to register, and the turn only advances once the
// avatar has actually finished walking its route.
const AI_THINK_MS = 900;   // pause before an AI prisoner commits its move
const AI_SETTLE_MS = 450;  // beat after the walk lands, before the handoff
const AI_STEP_DUR = 0.34;  // seconds per tile for an AI walk (human: 0.22)
const AI_WATCHER_MS = 1200; // the Watcher's deliberation before it scans

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
  // Targeted Watcher skills use one explicit two-step interaction:
  // activate the skill, then choose a direction. Keeping the pending skill
  // in one slot prevents Dispatch and Double Bluff from competing for the
  // same next direction press.
  armedSkill: null,
  // The Watcher's previewed gaze, mirroring stagedPath on the Prisoner side.
  // rotateWatcher() sets rotatedThisTurn and cannot be undone, so firing it
  // straight off the button meant one stray LB/RB locked your gaze for the
  // whole turn with no way to cancel or pick the other way. Nothing reaches
  // the rules until the same confirm control the Prisoner uses.
  stagedFacing: null,
  // checkOver() has four call sites (turn handoffs, the AI loops, and the
  // walk-animation drain), and the first thing it does — app.running = false
  // — does not stop the later ones from re-entering while isOver() is still
  // true. Anything with a real side effect there needs its own latch, not
  // the running flag: recording a W/L on every re-entry would inflate the
  // record by however many paths happened to fire that frame.
  resultRecorded: false,
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

// Per-role, per-difficulty win/loss record. Both single-player roles are real
// modes with their own difficulty curve (Watcher capture 82/74/65%, Prisoner
// 48/74/92% — the two are tuned in opposite directions on purpose), so one
// combined "games won" number would average those into nonsense. Hotseat is
// deliberately not tracked: both sides are human, so a personal record has
// nobody to belong to.
const RECORD_KEY = "opticon.record.v1";
const RECORD_ROLES = ["Prisoner", "Watcher"];
const RECORD_DIFFS = ["easy", "medium", "hard"];

function blankRecord() {
  const r = {};
  for (const role of RECORD_ROLES) {
    r[role] = {};
    for (const d of RECORD_DIFFS) r[role][d] = { won: 0, lost: 0 };
  }
  return r;
}

// Merged against a blank rather than trusted as-is: this is user-writable
// storage that also has to survive its own future shape changes (a new
// difficulty, a renamed role), and a missing bucket would otherwise throw on
// first read rather than degrade to zeroes.
function loadRecord() {
  const rec = blankRecord();
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return rec;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return rec;
    for (const role of RECORD_ROLES) {
      for (const d of RECORD_DIFFS) {
        const cell = saved?.[role]?.[d];
        if (!cell) continue;
        rec[role][d] = {
          won: Number.isFinite(cell.won) ? Math.max(0, Math.floor(cell.won)) : 0,
          lost: Number.isFinite(cell.lost) ? Math.max(0, Math.floor(cell.lost)) : 0,
        };
      }
    }
  } catch {
    /* corrupt or unavailable — a fresh record is the right fallback */
  }
  return rec;
}

function saveRecord(rec) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(rec));
  } catch {
    /* ignore */
  }
}

// Did the human's OWN side win? The Prisoner side wins if any prisoner
// reaches the gate; the Watcher side wins on capture or on the round limit.
// g.winner already encodes that, so this is just "is that my role".
function humanWonGame(g) {
  return g.winner === app.config.humanRole;
}

function recordGameResult(g) {
  if (app.config.mode === "hotseat") return null;
  const role = app.config.humanRole;
  const diff = app.config.difficulty;
  if (!RECORD_ROLES.includes(role) || !RECORD_DIFFS.includes(diff)) return null;
  const rec = loadRecord();
  const cell = rec[role][diff];
  if (humanWonGame(g)) cell.won++;
  else cell.lost++;
  saveRecord(rec);
  return { role, diff, cell };
}

function recordLine(role, diff) {
  const cell = loadRecord()[role]?.[diff];
  if (!cell) return "";
  const total = cell.won + cell.lost;
  if (!total) return "no runs yet";
  return `${cell.won}W · ${cell.lost}L`;
}

// Shown under each role on the menu, for the difficulty currently selected —
// the record is per-difficulty, so displaying it without naming the tier it
// belongs to would read as a lifetime total and quietly misreport.
function updateRecordUI() {
  const diff = app.config.difficulty;
  for (const role of RECORD_ROLES) {
    const el = document.getElementById(`record${role}`);
    if (el) el.textContent = recordLine(role, diff);
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
  const held = app.input.isHeld("Space") ||
    app.input.isPadHeld(0) || app.input.isPadHeld(2) || app.input.isPadHeld(9) ||
    introPointerDown;
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
    (focusedOnStart && (app.input.isHeld("Space") || app.input.isHeld("Enter") ||
      app.input.isPadHeld(0) || app.input.isPadHeld(9)));
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
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
  updateRecordUI(); // a game just finished — show its result on the way back
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
      updateRecordUI(); // the record is per-difficulty — follow the new tier
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
  updateRecordUI();
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
  app.armedSkill = null;
  app.stagedFacing = null;
  app.resultRecorded = false;
  breakArmed = false;
  updateBreakToggleUI();
  // Fresh seed each game for variety, but reproducible within a game.
  app.config.seed = (Math.floor(Math.random() * 1e9) >>> 0) || 1;
  const prisonerCount = app.config.mode === "hotseat" ? 1 : PRISONER_COUNT;
  const map = generateMap(app.config.seed, { ...MAP_DEFAULTS, prisonerCount });
  app.game = createGame(map, {
    watcherFacing: 0,
    prisoners: map.spawns,
    dispatchTier: dispatchTierFor(),
    // Prisoner 0 is the human's own body whenever a human holds the Prisoner
    // seat (see humanControlsPrisoner); in Watcher mode nobody down there is
    // the player, so there is no personal fate to grade and the rules fall
    // back to the institutional win condition.
    humanPrisoner: app.config.humanRole === "Watcher" && app.config.mode !== "hotseat" ? null : 0,
  });
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
  app.ui.updateHud(app.game, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
    btn.textContent = hasStagedRotation() ? "Commit Turn" : "Scan & End Turn";
  }
}

function hintFor() {
  const g = app.game;
  if (!g) return "";
  const scheme = app.input ? app.input.activeScheme : "keyboard";
  const prisoner = g.turn === "Prisoner";
  // The hint bar (and its device-specific touch/gamepad phrasing below)
  // teaches controls for the role whose turn it is — but g.turn only says
  // WHICH role is acting, not whether the human is the one acting. During
  // an AI turn (the opponent, or an AI companion mid-group — activePrisoner
  // != 0), those controls do nothing, so teaching them here just confuses
  // a player watching the AI move. Same gate the touch/Zone HUD already use.
  if (prisoner ? !humanControlsPrisoner() : !humanControlsWatcher()) {
    return prisoner ? "Watching the Prisoner's turn…" : "Watching the Watcher's turn…";
  }
  if (!prisoner && app.armedSkill) return targetedSkillHint(app.armedSkill, scheme);
  // An armed item is mid-verb: the player has committed to spending it and the
  // only thing left to teach is where to point it. Same treatment the Watcher's
  // targeted skills already got — items were the side that never had it, which
  // is why arming one felt like nothing happened.
  if (prisoner && armedItem) return armedItemHint(armedItem, scheme);
  // Custody overrides every movement hint below it: none of those controls do
  // anything from a cell, and the three turns are short enough that spending
  // one reading the wrong instructions is a real loss.
  if (prisoner && humanControlsPrisoner()) {
    const me = g.prisoners[g.activePrisoner];
    if (me?.custody > 0) return custodyHint(me, scheme);
    // Just out of a cell. This window is the only time in the game the gaze
    // cannot touch you, and it is short — saying so turns it from invisible
    // luck into the thing you spend crossing the open ground you have been
    // creeping around all match.
    if (me?.graceTurns > 0) {
      const move = scheme === "gamepad" ? "Stick / D-pad" : scheme === "touch" ? "Tap a direction" : "WASD / arrows";
      return `🟢 LOOSE — the eye cannot take you for ${me.graceTurns} more turn${me.graceTurns === 1 ? "" : "s"} (guards still can)  ·  ${move}: run  ·  use it`;
    }
  }
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
    return "LB / RB: aim the gaze (A confirms)  ·  D-pad: bluff/target, matched to the screen  ·  LT: pick skill, RT: arm/use  ·  A: scan & end turn  ·  Start: change view";
  }
  if (scheme === "touch") {
    if (prisoner) {
      return staged
        ? "Tap arrows to extend/undo the path  ·  Commit: move for real  ·  View: change camera"
        : "Tap arrows to plan a path  ·  💥: arm a window break, then tap a direction" + (carrying ? "  ·  tap an item, then a direction" : "") + "  ·  End: end turn  ·  View: change camera";
    }
    return "Rotate / bluff with the buttons  ·  tap a skill to arm/use it  ·  targeted skills then need a direction  ·  Scan: end turn";
  }
  if (prisoner) {
    return staged
      ? "WASD / arrows: extend or undo the path  ·  Space: commit the move  ·  V: view"
      : "WASD / arrows: plan a path  ·  Shift + direction: break a window" + (carrying ? "  ·  1-2: use an item" : "") + "  ·  Space: end turn  ·  V: view  ·  reach the green gate";
  }
  return "Q / E: aim the gaze (Space confirms)  ·  1-4: bluff/target  ·  5-9: skills  ·  Space: scan & end turn  ·  V: view";
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
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
// Is the human the one acting RIGHT NOW — as opposed to an AI opponent, or
// (single-player Prisoner mode) an AI companion's own turn within the human's
// group? Distinct from shouldShowWatcherInfo, which gates screen-secrecy
// (what a role is allowed to SEE) rather than input (who's allowed to ACT).
function humanControlsCurrentTurn() {
  const g = app.game;
  if (!g) return false;
  return g.turn === "Prisoner" ? humanControlsPrisoner() : humanControlsWatcher();
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
  // Every direction a Prisoner can give is SPATIAL — W/A/S/D, the arrow keys,
  // the on-screen ▲▼◀▶ pad, a d-pad, a stick. There is no labelled N/E/S/W
  // control on this side at all (unlike the Watcher's bluff buttons), so all
  // of them mean "the direction I am pointing at on screen" and none of them
  // mean a compass bearing. Up is up, whatever the camera is currently
  // looking at — the prisoner camera orbits and the overview can be spun, so
  // a hardcoded up=North walked the player somewhere other than where they
  // pointed the moment the view turned.
  //
  // Same resolver the Watcher's d-pad already used (render.js
  // screenDirToWorld), applied at the one place every prisoner direction
  // funnels through: `move` also carries the aim for an armed item and, via
  // the break modifier, the window to smash.
  if (intent === "move" || intent === "break") {
    // Resolved from where the prisoner is standing, not the map centre: under
    // perspective the screen direction of a world cardinal shifts across the
    // map, and a move is given from the avatar.
    const me = app.game?.prisoners[app.game.activePrisoner];
    const tip = app.stagedPath.length ? app.stagedPath[app.stagedPath.length - 1] : me;
    arg = app.renderer.screenDirToWorld(arg, tip ? { x: tip.x, y: tip.y } : null);
  }
  if (intent === "toggleBreak") {
    breakArmed = !breakArmed;
    if (breakArmed) armedItem = null; // mutually exclusive modes
    app.audio.play("ui");
    updateBreakToggleUI();
    return;
  }
  if (intent === "struggle") {
    doStruggle();
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
function doStruggle() {
  const g = app.game;
  if (!g || g.turn !== "Prisoner") return;
  const p = g.prisoners[g.activePrisoner];
  if (!p.custody) {
    app.audio.play("blocked");
    app.ui.hint("Nothing to fight — you are not in custody.");
    return;
  }
  const r = struggle(g);
  if (!r.ok) {
    app.audio.play("blocked");
    app.ui.hint(r.reason === "already-tried" ? "You have already tried this turn." : hintFor());
  } else if (r.freed) {
    app.audio.play("glass");
    app.ui.hint("The cuff gives — you are loose.");
  } else {
    app.audio.play("blocked");
    app.ui.hint(r.blockedBy === "guard"
      ? "A guard has a hand on you — struggling is hopeless while one is posted."
      : "The cuffs hold. Try again, or spend something.");
  }
  updateItemBar();
  updateCustodyUI();
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
  app.ui.renderLog(g, shouldShowWatcherInfo());
}

// Swap the d-pad for the Struggle button while the human's own prisoner is
// held. Walking is not a choice they have, so offering the pad would be
// offering a control that does nothing.
let _custodySig = "";
function updateCustodyUI() {
  const g = app.game;
  const p = g && g.turn === "Prisoner" && humanControlsPrisoner() ? g.prisoners[g.activePrisoner] : null;
  const held = !!(p && p.custody > 0);
  const pad = document.getElementById("prisonerControls");
  const btn = document.getElementById("struggleBtn");
  if (btn) btn.classList.toggle("hidden", !held);
  if (pad) pad.classList.toggle("cuffed", held);
  // The stat rail and hint bar are refreshed from handleIntent, i.e. only when
  // the player does something. Custody starts and ends on turns that are NOT
  // the player's — a Watcher scan seizes you, a companion walking past frees
  // you — so without this the Held counter and the cell instructions could sit
  // a whole turn behind the actual state. Signature-guarded so the common
  // case (nothing changed) costs one string compare a frame.
  const sig = `${held}|${p ? p.custody : ""}`;
  if (sig === _custodySig) return;
  _custodySig = sig;
  if (!g) return; // menu / pre-game: there is no HUD to refresh yet
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
  app.ui.hint(hintFor());
}

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
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
  // Fire untargeted items immediately instead of arming them. This used to be
  // a hardcoded `kind === MUFFLE || kind === FEATHER`, which silently broke
  // the moment two more untargeted items existed: pressing 1 on a Shim armed
  // it, showed "Shim armed — arrows to aim it", and waited forever for a
  // direction it has no use for. Reading the item's own `targeted` field means
  // a new item cannot reintroduce the bug.
  if (!ITEM_INFO[kind].targeted) {
    doUseItem(kind, null); // no target — resolves the moment it is spent
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
      app.audio.play("cutters");
    } else if (r.event === "muffle") {
      app.audio.play("muffle");
    } else {
      app.audio.play("item");
    }
  } else {
    app.audio.play("blocked");
  }
  updateItemBar();
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(hintFor());
  updateCommitButton();
}

// Which quadrant the human's own prisoner is standing in, and whether a
// dispatched squad is currently sweeping it. DISPATCH became the dominant
// difficulty lever (Tension T25), and its arrival is announced publicly as
// an absolute compass quadrant — but a Prisoner had no on-screen frame of
// reference to resolve that against, so the single most important warning
// in the game was unreadable by its intended audience. Same signature-guard
// + loop()-driven pattern as the item bar, and the same role gate: a
// Watcher-role viewer must never read the human prisoner's position here.
let _zoneSig = "";
function updateZoneHud() {
  const stat = document.getElementById("zoneStat");
  const label = document.getElementById("zoneLabel");
  if (!stat || !label) return;
  const g = app.game;
  const show = g && g.turn === "Prisoner" && humanControlsPrisoner();
  const p = show ? g.prisoners[humanPrisonerIndex()] : null;
  const q = p && p.alive && !p.escaped ? quadrantOf(g, p.x, p.y) : null;
  // Only the guards' assigned quadrant is used, not their live position: the
  // quadrant is what was publicly announced, so surfacing exactly that keeps
  // the readout an aid to hearing the announcement, not free tracking intel.
  const hunted = q != null && g.watcher.guards.some((gd) => gd.quadrant === q);
  const sig = q == null ? "" : `${q}|${hunted ? 1 : 0}`;
  if (sig === _zoneSig) return;
  _zoneSig = sig;
  if (q == null) {
    stat.classList.add("hidden");
    return;
  }
  stat.classList.remove("hidden");
  label.textContent = hunted ? `⚠ ${DIRS[q]}` : DIRS[q];
  label.classList.toggle("hunted", hunted);
}

// Rebuild the on-screen inventory chips. Only ever shows the HUMAN's own
// prisoner — a companion's belt is not the player's to see or spend.
// Driven from loop() rather than from each of the many places inventory can
// change (pickup on commit, use, turn handoff, new game) — the multi-handoff
// audit problem that bit the 1→N prisoner scale-out (memory E10). The
// signature guard makes a per-frame call free when nothing changed, so
// there's no call site left to forget.
// Item copy is frozen constant data from map.js, not player input — but the
// caption is the one place that data reaches innerHTML, so escape it anyway
// rather than depend on nobody ever putting an ampersand in a blurb.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Can this item do anything in the state the prisoner is in right now? Mirrors
// the same split useItem() enforces (rules.js): custody items are inert while
// free, world items are inert while held, and the Flare is thrown so it works
// from either side of the bars.
function usableNow(kind, p) {
  const heldOnly = !!ITEM_INFO[kind].heldOnly;
  if (heldOnly) return p.custody > 0;
  if (p.custody > 0) return kind === ITEM_KINDS.FLARE;
  return true;
}

let _itemBarSig = "";
function updateItemBar() {
  const bar = document.getElementById("itemBar");
  if (!bar) return;
  const g = app.game;
  const show = g && g.turn === "Prisoner" && humanControlsPrisoner();
  const p = show ? g.prisoners[g.activePrisoner] : null;
  const caption = document.getElementById("itemCaption");
  // Custody is part of the signature: the same belt means different chips
  // in and out of a cell, since half the belt is unusable in each state.
  const sig = p ? `${p.items.join(",")}|${armedItem || ""}|${padSlot}|${p.custody}` : "";
  if (sig === _itemBarSig) return;
  _itemBarSig = sig;
  if (!p || !p.items.length) {
    bar.innerHTML = "";
    bar.classList.add("empty");
    if (caption) { caption.textContent = ""; caption.classList.add("empty"); }
    return;
  }
  bar.classList.remove("empty");
  bar.innerHTML = p.items
    .map((kind, i) => {
      const info = ITEM_INFO[kind];
      const armed = (armedItem === kind ? " armed" : "") + (padSlot === i ? " padsel" : "");
      // Dim what this state cannot spend, the same way the Watcher's skill
      // bar dims a cooling skill: a Shim is inert until you are caught, and
      // a Lockpick is inert once you are — pressing either and getting
      // nothing is how a player concludes an item is broken.
      const dead = usableNow(kind, p) ? "" : " unusable";
      // The name rides ON the chip, not in a title= tooltip. Hover doesn't
      // exist on touch and can't be reached by gamepad, so a tooltip taught
      // the item's name only to the one input scheme that needed it least.
      return `<button class="item-chip${armed}${dead}" data-intent="item" data-arg="${i}" title="${esc(info.label)}">` +
        `<span class="ic">${info.icon}</span><span class="ik">${i + 1}</span>` +
        `<span class="iname">${info.label}</span></button>`;
    })
    .join("");
  // Describe whichever item the player is about to spend: the armed one if
  // there is one, else the gamepad-highlighted slot, else the first. Something
  // is always described, because the failure mode is carrying an icon you were
  // never told the meaning of — not having too little screen furniture.
  if (caption) {
    const focus = armedItem && p.items.includes(armedItem)
      ? armedItem
      : p.items[Math.min(Math.max(padSlot, 0), p.items.length - 1)] || p.items[0];
    const info = ITEM_INFO[focus];
    const armedNow = armedItem === focus;
    caption.classList.remove("empty");
    // A dimmed chip has to say WHY, or it reads as a bug rather than a rule.
    const next = !usableNow(focus, p)
      ? (info.heldOnly
          ? "Nothing to use it on until you are caught."
          : "No use for this from inside a cell.")
      : !info.targeted
        ? "Spends the moment you press it."
        : armedNow
          ? `Armed — now ${info.use}.`
          : `Press it, then ${info.use}.`;
    caption.innerHTML = `<b>${esc(info.icon)} ${esc(info.label)}</b> — ${esc(info.blurb)} <i>${esc(next)}</i>`;
  }
  // The chips are rebuilt each time, so re-bind their taps to the same
  // intent pipeline every other on-screen control uses.
  bar.querySelectorAll("[data-intent]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      handleIntent("item", Number(btn.getAttribute("data-arg")));
    });
  });
}

// What a held prisoner can actually do, and — the part that decides the turn —
// whether a guard is posted, because that single fact flips the right move
// from "struggle" to "you need an item".
function custodyHint(p, scheme = app.input?.activeScheme || "keyboard") {
  const fight = scheme === "gamepad" ? "X" : scheme === "touch" ? "Struggle" : "F";
  const end = scheme === "gamepad" ? "A" : scheme === "touch" ? "End" : "Space";
  const turns = `${p.custody} turn${p.custody === 1 ? "" : "s"} before processing`;
  if (guardOver(app.game, p)) {
    return `⛓️ HELD — ${turns}  ·  a guard is posted: struggling will not work  ·  ${fight}: try anyway  ·  ${end}: end turn`;
  }
  return `⛓️ HELD — ${turns}  ·  ${fight}: fight the cuffs  ·  1-2: spend an item  ·  ${end}: end turn`;
}

// The prisoner-side twin of targetedSkillHint: an armed item is waiting on a
// direction, and until it gets one nothing visible happens — which reads as a
// dead button unless the hint bar says otherwise. Carries the item's own `use`
// text so the rule and the keypress arrive together.
function armedItemHint(kind, scheme = app.input?.activeScheme || "keyboard") {
  const info = ITEM_INFO[kind];
  // The caption above already carries the full rule, so this line only has to
  // name the button — repeating `info.use` here wrapped the hint bar to two
  // lines and said nothing the player had not just read.
  const control = scheme === "gamepad" ? "D-pad" : scheme === "touch" ? "tap" : "arrows / WASD";
  return `${info.icon} ${info.label} armed — ${control} to aim it  ·  press it again to cancel`;
}

// ---- Watcher skills ------------------------------------------------------

function targetedSkillHint(skill, scheme = app.input?.activeScheme || "keyboard") {
  const targetControl = scheme === "gamepad" ? "press a D-pad direction" :
    scheme === "touch" ? "tap a direction" : "press 1-4";
  return skill === SKILLS.DOUBLE_BLUFF
    ? `Double Bluff armed — ${targetControl} for the second claim`
    : `Dispatch armed — ${targetControl} to pick a quadrant`;
}

function skillUnavailableHint(g, skill) {
  const info = SKILL_INFO[skill];
  const cd = g.watcher.skills[skill] || 0;
  if (cd > 0) return `${info.label} is cooling down (${cd} turn${cd === 1 ? "" : "s"})`;
  if (skill === SKILLS.DOUBLE_BLUFF) return "Double Bluff needs a first bluff — make one, then activate the skill";
  if (skill === SKILLS.ECHO) return "Echo Memory needs an active noise trace to refresh";
  if (skill === SKILLS.LOCK) return "Remote Lock needs an open, unoccupied door";
  return `${info.label} cannot be used right now`;
}

function showSkillResult(skill, result) {
  if (!result.ok) {
    if (result.reason === "same-direction") return "Double Bluff needs a different second direction";
    if (result.reason === "occupied") return "Remote Lock cannot close a door occupied by a prisoner";
    return skillUnavailableHint(app.game, skill);
  }
  if (result.event === "wide-scan") return "Wide Scan armed — Scan & End Turn to sweep 180°";
  if (result.event === "echo") return `Echo Memory refreshed ${result.refreshed} noise trace${result.refreshed === 1 ? "" : "s"}`;
  if (result.event === "lock") return "Remote Lock sealed the selected door";
  if (result.event === "dispatch") return `Guards dispatched to the ${DIRS[result.quadrant]} quadrant`;
  if (result.event === "double-bluff") return `Second bluff declared toward ${DIRS[result.dir]}`;
  return hintFor();
}

// WIDE_SCAN/ECHO need no target. LOCK automatically targets the nearest
// eligible open door. DOUBLE_BLUFF and DISPATCH share one explicit arm-then-
// direction interaction across keyboard, touch, and gamepad.
function doUseSkill(skill) {
  const g = app.game;
  if (!g || g.turn !== "Watcher") return;
  if (app.armedSkill && app.armedSkill !== skill) app.armedSkill = null;
  if (!skillUsable(g, skill)) {
    app.audio.play("blocked");
    app.ui.hint(skillUnavailableHint(g, skill));
    updateSkillBar();
    return;
  }
  if (skill === SKILLS.DOUBLE_BLUFF || skill === SKILLS.DISPATCH) {
    app.armedSkill = app.armedSkill === skill ? null : skill;
    app.audio.play("ui");
    app.ui.hint(app.armedSkill ? targetedSkillHint(skill) : hintFor());
    updateSkillBar();
    return;
  }
  let arg = null;
  if (skill === SKILLS.LOCK) {
    arg = nearestOpenDoorInGaze(g);
    if (!arg) {
      app.audio.play("blocked");
      app.ui.hint("Remote Lock needs an open, unoccupied door");
      return;
    }
  }
  const r = useSkill(g, skill, arg);
  if (r.ok) {
    if (r.event === "lock") {
      app.audio.play("lock");
      app.renderer.triggerPing(r.x, r.y);
    } else if (r.event === "wide-scan") {
      app.audio.play("scan");
    } else {
      app.audio.play("skill");
    }
  } else {
    app.audio.play("blocked");
  }
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(showSkillResult(skill, r));
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
    unavailable: skillUnavailableHint(g, s),
  }));
  const sig = entries.map((e) => `${e.skill}:${e.cd}:${e.usable ? 1 : 0}`).join("|") + `|${padSlot}|${app.armedSkill || ""}`;
  if (sig === _skillBarSig) return;
  _skillBarSig = sig;
  bar.classList.remove("empty");
  bar.innerHTML = entries
    .map((e, i) => {
      const info = SKILL_INFO[e.skill];
      const armed = e.skill === app.armedSkill;
      const cls = (e.cd > 0 ? " cooling" : e.usable ? "" : " unusable") + (padSlot === i ? " padsel" : "") + (armed ? " armed" : "");
      const badge = e.cd > 0 ? `<span class="cd">${e.cd}</span>` : `<span class="ik">${i + 5}</span>`;
      const title = e.usable ? info.label : `${info.label}: ${e.unavailable}`;
      return `<button class="item-chip skill-chip${cls}" data-skill="${e.skill}" title="${title}" aria-label="${title}">` +
        `<span class="ic">${info.icon}</span>${badge}` +
        `<span class="iname">${info.label}</span></button>`;
    })
    .join("");
  bar.querySelectorAll("[data-skill]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      handleIntent("skill", btn.getAttribute("data-skill"));
    });
  });
}

const QUADRANT_LABEL = ["N", "E", "S", "W"];
let _suspicionSig = "";
// Same signal watcherAI.js's scoreDirections() already computes to play the
// AI opponent, surfaced here so a human Watcher (aiming DISPATCH, or just
// deciding where to rotate) gets the same read instead of guessing blind.
// A fixed neutral tuning (medium) is used for the DISPLAY only — this never
// touches the AI's own difficulty-tuned behaviour.
function updateSuspicionHud() {
  const bar = document.getElementById("suspicionHud");
  if (!bar) return;
  const g = app.game;
  const show = g && g.turn === "Watcher" && humanControlsWatcher() && shouldShowWatcherInfo();
  if (!show) {
    if (_suspicionSig !== "") {
      _suspicionSig = "";
      bar.innerHTML = "";
      bar.classList.add("empty");
    }
    return;
  }
  const scores = scoreDirections(g, DIFFICULTY.medium);
  const max = Math.max(...scores, 0.001); // relative bars — same comparison the AI itself makes
  const pct = scores.map((s) => Math.round((s / max) * 100));
  const sig = pct.join(",");
  if (sig === _suspicionSig) return;
  _suspicionSig = sig;
  bar.classList.remove("empty");
  bar.innerHTML = QUADRANT_LABEL
    .map((label, i) => (
      `<div class="susp-row"><span class="susp-label">${label}</span>` +
      `<div class="susp-track"><div class="susp-fill" style="width:${pct[i]}%"></div></div></div>`
    ))
    .join("");
}

// ---- Staged movement: nothing moves for real until the player commits ----
// (Brain telegraph#E6: a cosmetic/preview stays presentation-only; only what
// has real consequence touches authoritative state — here, the preview never
// calls moveActivePrisoner until commit.)

function resetStagedPath() {
  if (app.stagedPath.length) app.stagedPath = [];
}

// ---- Watcher: staged rotation -------------------------------------------

// The gaze the player is currently LOOKING at — the preview if one is staged,
// otherwise the committed facing. Everything player-facing (HUD, gaze cone,
// camera) reads this so the preview is something you can actually see and
// judge before spending the turn's single rotation on it.
function effectiveFacing() {
  const g = app.game;
  if (!g) return 0;
  return app.stagedFacing != null ? app.stagedFacing : g.watcher.facing;
}

function hasStagedRotation() {
  const g = app.game;
  return !!g && app.stagedFacing != null && app.stagedFacing !== g.watcher.facing;
}

function clearStagedRotation() {
  app.stagedFacing = null;
}

// One 90° step per turn is the rule, so the preview is clamped to the two
// neighbours of the committed facing. That clamp is what makes cancelling and
// switching sides fall out for free: from base, LB/RB pick a side; from a
// staged side, the opposite key walks back to base (cancel) and the same key
// is a no-op rather than an illegal 180.
function stageRotation(delta) {
  const g = app.game;
  if (!g || g.turn !== "Watcher") return;
  if (g.watcher.rotatedThisTurn) {
    app.audio.play("blocked");
    app.ui.hint("Already rotated this turn — Scan & End Turn when ready");
    return;
  }
  const base = g.watcher.facing;
  const cur = effectiveFacing();
  const offset = (cur - base + 4) % 4; // 0 = none, 1 = clockwise, 3 = ccw
  let next = offset === 0 ? (base + delta + 4) % 4
    : (offset === 1 && delta < 0) || (offset === 3 && delta > 0) ? base
      : cur; // same side again would be a 180 — refuse rather than silently allow
  if (next === cur) {
    app.audio.play("blocked");
  } else {
    app.stagedFacing = next === base ? null : next;
    app.audio.play("rotate");
  }
  afterWatcherStateChange();
}

// Spend the turn's rotation for real. Separate from staging so the rules only
// ever see a deliberate, confirmed choice.
function commitStagedRotation() {
  const g = app.game;
  if (!g || !hasStagedRotation()) return;
  const delta = ((app.stagedFacing - g.watcher.facing + 4) % 4) === 1 ? 1 : -1;
  const r = rotateWatcher(g, delta);
  clearStagedRotation();
  app.audio.play(r.ok ? "rotate" : "blocked");
  afterWatcherStateChange();
}

function afterWatcherStateChange() {
  const g = app.game;
  if (!g) return;
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), effectiveFacing());
  app.ui.renderLog(g, shouldShowWatcherInfo());
  app.ui.hint(hintFor());
  updateCommitButton();
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
        app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
  app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
  // Same reasoning as the Watcher's end-turn: endPrisonerTurn runs the rules'
  // end-condition check, and nothing downstream of here would notice if it
  // just ended the game — the handoff below would hand off into a finished
  // game instead of showing the result.
  checkOver();
  if (isOver(g)) return;
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
    stageRotation(arg);
  } else if (intent === "bluff" || intent === "bluffScreen") {
    // A spatial control (d-pad / stick) means a direction ON SCREEN; resolve
    // it against the live camera so "up" is always the top of the map as
    // drawn. Labelled controls (the N/E/S/W buttons, keys 1-4) name a compass
    // bearing and arrive as plain "bluff", already absolute.
    if (intent === "bluffScreen") arg = app.renderer.screenDirToWorld(arg);
    if (app.armedSkill === SKILLS.DOUBLE_BLUFF || app.armedSkill === SKILLS.DISPATCH) {
      // Same direction controls, reinterpreted as the target for whichever
      // explicit two-step skill the player armed.
      const skill = app.armedSkill;
      app.armedSkill = null;
      const r = useSkill(g, skill, arg);
      // A same-direction Double Bluff is a recoverable target mistake: keep
      // the skill armed so the player can choose another direction directly.
      if (!r.ok && skill === SKILLS.DOUBLE_BLUFF && r.reason === "same-direction") {
        app.armedSkill = skill;
      }
      app.audio.play(r.ok ? "skill" : "blocked");
      app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
      app.ui.renderLog(g, shouldShowWatcherInfo());
      app.ui.hint(showSkillResult(skill, r));
      updateSkillBar();
      return;
    }
    const r = setBluff(g, arg);
    if (r.ok) {
      app.audio.play("bluff");
    } else if (r.reason === "wide-scan-armed") {
      app.audio.play("blocked");
      app.ui.hint("Wide Scan is armed — its 180° sweep cannot be bluffed");
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
    // Same overloaded confirm as the Prisoner's: a staged rotation commits
    // first, and only a second press scans and ends the turn — so the gaze
    // you spend the turn on is always one you confirmed on purpose.
    if (hasStagedRotation()) {
      commitStagedRotation();
      return;
    }
    app.armedSkill = null;
    // Scan (commit), then end turn.
    const scan = watcherScan(g, exposureTier());
    app.audio.play("scan");
    if (scan.caught) {
      app.audio.play("caught");
      app.ui.banner("CAPTURED!", "bad");
      app.renderer.triggerCaptureFlash(scan.caught.x, scan.caught.y);
    }
    checkOver();
    if (isOver(g)) return;
    endWatcherTurn(g);
    // endWatcherTurn is itself an ending move: it advances the round (so it
    // is what trips the ROUND_LIMIT time-up) and, with no living prisoner
    // left to activate, declares the capture. The checkOver() above ran
    // BEFORE all of that, so without this second check a human Watcher who
    // ends the turn that hits the round limit gets no result screen at all —
    // the game just sits there finished and silent. Re-entry is safe: both
    // the overlay and the W/L record are latched behind app.resultRecorded.
    checkOver();
    if (isOver(g)) return;
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
    const actions = playWatcherTurn(g, app.config.difficulty, app.config.seed, exposureTier());
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
    app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
  }, AI_WATCHER_MS);
}

function scheduleAiPrisoner() {
  if (app.aiThinking) return;
  app.aiThinking = true;
  const idx = app.game ? app.game.activePrisoner : 0;
  app.ui.banner(`Prisoner ${idx + 1} is moving...`, "prisoner");
  setTimeout(() => {
    const g = app.game;
    if (!g || isOver(g)) { app.aiThinking = false; return; }
    const acting = g.activePrisoner;
    // Resolve the AI's whole turn in the sim, then hand the tile sequence to
    // the renderer so the avatar visibly WALKS it. Previously the sim jumped
    // the prisoner to its end tile and the avatar just slid there, which read
    // as teleporting; now a companion's move is legible as a route.
    const result = aiPrisonerTurn(g);
    if (result && result.path && result.path.length) {
      app.renderer.walkTo(acting, result.from, result.path, AI_STEP_DUR);
    }
    // Wait for the walk to finish before ending the turn, so the handoff
    // never races ahead of what the player can actually see happening.
    waitForWalk(acting, () => {
      if (!app.game || app.game !== g) { app.aiThinking = false; return; }
      endPrisonerTurn(g);
      app.aiThinking = false;
      checkOver();
      app.ui.updateHud(g, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
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
    });
  }, AI_THINK_MS);
}

// Poll until a given avatar's walk queue drains, then run `done`. Falls back
// to a hard timeout so a dropped frame or a zero-length walk can never wedge
// the turn chain waiting on an animation that will never complete.
function waitForWalk(prisonerIndex, done) {
  const started = performance.now();
  const tick = () => {
    const av = app.renderer && app.renderer.avatars[prisonerIndex];
    const idle = !av || av.walk.queue.length === 0;
    if (idle || performance.now() - started > 6000) {
      setTimeout(done, AI_SETTLE_MS);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Difficulty must always describe the HUMAN'S OPPOSITION. When the human
// plays Watcher, their opposition is the prisoners, so the tier drives
// prisoner-AI competence; the shared capture rule is held at a neutral
// baseline (see exposureTier below), because raising it would hand the
// human Watcher an easier job while calling it "hard".
function prisonerSkillTier() {
  return app.config.humanRole === "Watcher" ? app.config.difficulty : "medium";
}

// The capture rule is symmetric — it governs the tower, whoever holds it.
// Tier it by difficulty only when the human is the one being hunted.
function exposureTier() {
  return app.config.humanRole === "Watcher" ? "medium" : app.config.difficulty;
}

// DISPATCH is NOT symmetric like the capture rule above — it's a tool only
// whichever side holds the tower ever fires, human or AI, never both in one
// game. So there's no "who does this favor" ambiguity to dodge by holding a
// neutral baseline. But the SAME difficulty word still needs OPPOSITE guard
// strength depending on who's playing Watcher: "hard" should mean weaker
// guards when a human has to use them well (a harder tool to lean on, same
// spirit as prisonerSkillTier sharpening the AI on hard), and stronger
// guards when the AI wields them against a human prisoner (consistent with
// exposureTier and watcherAI's own DIFFICULTY table already scaling up
// against the prisoner on hard). One flip at game start settles it for both
// the human skill-use path and watcherAI's pickSkills.
function dispatchTierFor() {
  const d = app.config.difficulty;
  if (app.config.humanRole !== "Watcher") return d; // AI Watcher: hard = strong guards, as authored
  if (d === "hard") return "easy";
  if (d === "easy") return "hard";
  return "medium";
}

// The in-game AI prisoner uses the shared BFS pathing policy. After it acts we
// surface any noise it created as pings so the human Watcher gets feedback.
function aiPrisonerTurn(g) {
  const result = prisonerAITurn(g, Math.random, prisonerSkillTier());
  for (const n of g.noise) app.renderer.triggerPing(n.x, n.y);
  return result;
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

// Deliberately SEPARATE from shouldShowWatcherInfo(). That gate answers "is
// this viewer the Watcher"; this one answers "has this viewer bought one
// turn of true sight with a Golden Feather". Folding the feather into the
// role gate would leak everything else the Watcher sees (bluff claims, skill
// readiness, the suspicion read) — the feather buys the facing, nothing more.
function shouldRevealGaze() {
  const g = app.game;
  return !!g && g.gazeRevealedForRound === g.round;
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
  if (app.ui && app.game) app.ui.updateHud(app.game, app.viewMode, humanLabel(), shouldShowWatcherInfo(), humanControlsCurrentTurn(), app.stagedFacing, shouldRevealGaze());
}

// ---- End condition -------------------------------------------------------

function checkOver() {
  const g = app.game;
  if (g && isOver(g)) {
    app.running = false;
    // Latch BEFORE the setTimeout: the other checkOver() call sites can fire
    // again within the same 700ms, and each would otherwise queue its own
    // recording (and its own overlay) for the one finished game.
    const alreadyRecorded = app.resultRecorded;
    app.resultRecorded = true;
    if (alreadyRecorded) return;
    const result = recordGameResult(g);
    if (g.winner === "Prisoner") app.audio.play("escape");
    else app.audio.play("caught");
    setTimeout(() => {
      app.ui.gameOver(g, {
        difficulty: app.config.difficulty,
        record: result ? `${app.config.humanRole} on ${result.diff}: ${recordLine(result.role, result.diff)}` : "",
      });
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
      danger = isExposed(g, p.x, p.y, exposureTier());
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
  updateCustodyUI();
  updateSkillBar();
  updateSuspicionHud();
  updateZoneHud();
  // Safety net: a staged path (and an armed break) only make sense during
  // the Prisoner's own turn.
  if (app.game && app.game.turn !== "Prisoner") {
    resetStagedPath();
    if (breakArmed) { breakArmed = false; updateBreakToggleUI(); }
    if (armedItem) { armedItem = null; updateItemBar(); }
  }
  if (app.game && app.game.turn !== "Watcher" && app.armedSkill) {
    app.armedSkill = null;
    updateSkillBar();
  }
  // A previewed gaze belongs to the Watcher's own turn only — the same
  // cleanup the staged path and armed item get above.
  if (app.game && app.game.turn !== "Watcher" && app.stagedFacing != null) {
    clearStagedRotation();
    updateCommitButton();
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
      previewFacing: app.stagedFacing,
      stagedPath: app.stagedPath,
      viewedPrisoner: humanPrisonerIndex(),
      selfNoise: (viewedPrisoner && viewedPrisoner.selfNoise) || [],
    });
    // The avatar just visually arrived at one or more committed tiles — fire
    // that tile's audio/ping now (matching the footstep, not the sim resolve).
    if (result && result.arrived && result.arrived.length) {
      for (const step of result.arrived) {
        if (step.event === "glass") { app.audio.play("glass"); app.renderer.triggerPing(step.x, step.y); }
        else if (step.event === "item-pickup") app.audio.play("pickup");
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
