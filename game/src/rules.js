// rules.js — Pure game logic for Opticon 3D. No rendering, no DOM.
// Runs identically in the browser (ES module) and Node (for tests).
//
// Design (from Panopticon.md):
//  * Asymmetric turn-based. Prisoner(s) sneak outward-in / toward an EXIT; the
//    Watcher sits in the tower and hunts by inference, not direct sight.
//  * A prisoner has MOVE POINTS per turn. A quiet 1-tile step is safe; moving
//    2+ tiles in a turn emits NOISE revealing a tile. Breaking a window
//    (a deliberate act, not automatic movement) is always loud too.
//  * The Watcher can only rotate 90 deg/turn and may BLUFF a second direction to
//    spread paranoia. A prisoner caught inside the Watcher's true 90 deg gaze
//    wedge (and lit / in-noise) is captured.
//  * Prisoner FoV is cardinal, range-limited, blocked by walls & closed doors,
//    and gated by tile light level.

import { TILE, OBJ, DIRS, DIR_VEC, ITEM_KINDS, ITEM_INFO } from "./map.js";
import { bfsPath } from "./pathfind.js";

export const MP_PER_TURN = 3;
export const ITEM_CAP = 2; // carried at once — forces a real "which do I keep" choice

// Watcher skills. Unlike prisoner items (found, one-use), these are always
// available but rate-limited by a cooldown — the Watcher is a fixed
// institution, not a scavenger, so its power is about WHEN to spend an
// action, not whether it happens to have found one.
export const SKILLS = Object.freeze({
  DOUBLE_BLUFF: "doubleBluff", // claim a SECOND direction this turn
  WIDE_SCAN: "wideScan", // this scan sweeps 180 deg instead of 90
  ECHO: "echo", // refresh every current noise marker to full TTL
  LOCK: "lock", // slam an open door shut from the tower
  DISPATCH: "dispatch", // send guards to hunt a quadrant
});

export const SKILL_INFO = Object.freeze({
  [SKILLS.DOUBLE_BLUFF]: { label: "Double bluff", icon: "🎭", cooldown: 3 },
  [SKILLS.WIDE_SCAN]: { label: "Wide scan", icon: "🔦", cooldown: 4 },
  [SKILLS.ECHO]: { label: "Echo memory", icon: "📡", cooldown: 3 },
  [SKILLS.LOCK]: { label: "Remote lock", icon: "🔒", cooldown: 4 },
  [SKILLS.DISPATCH]: { label: "Dispatch guards", icon: "🚨", cooldown: 4 },
});
export const GUARD_SPEED = 5; // tiles/turn — faster than a prisoner's MP_PER_TURN
export const GUARD_LIFESPAN = 6; // turns a dispatched pair searches before recalled
// Hard cap on turns. A game with no cap can in principle run forever
// against a passive human Prisoner, and the Watcher had no win condition of
// last resort. Chosen from the balance sim's own distribution rather than
// picked: over 200 easy-difficulty games (the longest tier) the maximum
// observed was 87 rounds with 97% finishing under 60, so 90 guarantees
// termination while leaving the measured distribution essentially untouched.
// Note `round` ticks once per PRISONER turn, so with a group of 3 this is
// ~30 full rotations of the group.
export const ROUND_LIMIT = 90;
export const NOISE_TTL = 2; // turns a noise marker persists for the Watcher
export const FOV_RANGE = 5; // prisoner cardinal sight range (tiles)

// Visibility levels for tiles in prisoner FoV.
export const VIS = Object.freeze({ DARK: 0, OUTLINE: 1, FOGGY: 2, CLEAR: 3 });

export function createGame(map, opts = {}) {
  const prisoners = (opts.prisoners || [{ x: map.spawn.x, y: map.spawn.y }]).map(
    (p, i) => ({
      id: i,
      x: p.x,
      y: p.y,
      mp: MP_PER_TURN,
      startTurnPos: { x: p.x, y: p.y },
      alive: true,
      escaped: false,
      openedDoors: new Set(),
      // Tiles where THIS prisoner made noise this turn — their own private
      // "I heard that" feedback (unlike game.noise, the Watcher's shared
      // multi-turn intel). Reset at the start of each of their turns.
      selfNoise: [],
      // One-use pickups carried by THIS prisoner (max ITEM_CAP). Per-prisoner,
      // not shared: a companion picking something up doesn't stock the human's
      // belt, same as MP.
      items: [],
      // Set by the MUFFLE item, cleared when this prisoner's turn ends —
      // suppresses the movement-noise reveal for exactly one turn.
      muffled: false,
      // AI-controlled-only bookkeeping to guarantee eventual resolution
      // (resolves T24: a cautious prisoner AI could stall forever against a
      // human Watcher, with no round cap to force it). `stalledTurns` counts
      // turns since the LAST time the prisoner beat its own best-ever
      // distance to the exit — not just turn-over-turn delta, since a small
      // oscillation (advance/retreat in a loop) resets a naive consecutive
      // counter every other turn without ever making real progress.
      // Unused for a human-controlled prisoner. See prisonerAI.js.
      stalledTurns: 0,
      bestDistToExit: Infinity,
      // Cosmetic-only hook, unread by any current logic or renderer: reserves
      // the shape now so a future outfit/customization system (see
      // docs/cognitive-updates) doesn't need a data migration later. Must
      // stay purely visual — never gameplay-affecting (see Tension T25 /
      // the ideas repo's cosmetics-only monetization note).
      appearance: "default",
    })
  );

  // Start with the light groups nearest each spawn switched OFF, so the opening
  // moves happen in shadow (a safe on-ramp that teaches the light/dark dynamic).
  const lightState = { ...map.lightState };
  for (const l of map.lights) {
    for (const p of prisoners) {
      if (Math.max(Math.abs(l.x - p.x), Math.abs(l.y - p.y)) <= l.radius + 1) {
        lightState[l.group] = false;
      }
    }
  }

  return {
    map,
    prisoners,
    activePrisoner: 0,
    watcher: {
      facing: opts.watcherFacing ?? 0,
      bluff: null, // a direction index the Watcher claims to also be watching
      lastBluff: null, // snapshot of `bluff` from the turn just ended (see endWatcherTurn)
      rotatedThisTurn: false,
      // AI-controlled-only bookkeeping: an exponentially-blended running
      // suspicion per cardinal direction, letting a harder AI stay wary of a
      // direction after the noise that raised it has already expired out of
      // `noise` (see watcherAI.js DIFFICULTY.memory). Unused for a
      // human-controlled Watcher.
      suspicion: [0, 0, 0, 0],
      // A second claimed direction, unlocked by the DOUBLE_BLUFF skill. Like
      // `bluff` this is a public claim, not the truth.
      bluff2: null,
      // Set for exactly one scan by WIDE_SCAN — widens the capture wedge from
      // 90 to 180 degrees for that scan only.
      wideScan: false,
      // Guards dispatched by the DISPATCH skill: [{x,y,quadrant,life}].
      // `life` counts down each round; at 0 they're recalled (removed).
      guards: [],
      // Turns remaining before each skill is usable again; 0 === ready.
      skills: Object.keys(SKILL_INFO).reduce((m, k) => ((m[k] = 0), m), {}),
    },
    // Which side has the initiative this turn.
    turn: "Prisoner", // "Prisoner" | "Watcher"
    round: 1,
    noise: [], // [{x,y,ttl,source}]
    log: [],
    status: "playing", // "playing" | "escaped" | "captured"
    winner: null, // "Prisoner" | "Watcher"
    openedDoors: new Set(), // global door state (shared world)
    brokenWindows: new Set(), // global, permanent — a broken window stays broken
    // Item tiles already collected, keyed y*size+x. A pickup is retired here
    // the INSTANT it's taken (Brain lockstep#E5: never let a despawn
    // animation gate further hits) — the renderer reads this to hide the
    // prop, it is not what decides whether the pickup still exists.
    takenItems: new Set(),
    // Light groups killed for good by CUTTERS — a switch can no longer
    // toggle these back on.
    deadLightGroups: new Set(),
    lightState,
  };
}

// ---- Queries -------------------------------------------------------------

export function tileAt(game, x, y) {
  const { tiles, size } = game.map;
  if (x < 0 || y < 0 || x >= size || y >= size) return TILE.WALL;
  return tiles[y][x];
}
export function objAt(game, x, y) {
  const { objects, size } = game.map;
  if (x < 0 || y < 0 || x >= size || y >= size) return OBJ.NONE;
  return objects[y][x];
}

// A door is "open" if it was toggled open globally.
export function isDoorOpen(game, x, y) {
  return game.openedDoors.has(y * game.map.size + x);
}

// A window, once broken, stays broken (permanent, unlike a door which can
// only ever be opened anyway — this is just the equivalent query for glass).
export function isWindowBroken(game, x, y) {
  return game.brokenWindows.has(y * game.map.size + x);
}

// Can a prisoner stand on / move into this tile right now?
export function isWalkable(game, x, y) {
  const t = tileAt(game, x, y);
  if (t === TILE.WALL) {
    // A broken window is the one way a WALL tile ever becomes walkable.
    return objAt(game, x, y) === OBJ.GLASS && isWindowBroken(game, x, y);
  }
  if (t !== TILE.FLOOR) return false;
  const o = objAt(game, x, y);
  if (o === OBJ.LIGHT) return false; // solid lamp fixture
  if (o === OBJ.DOOR && !isDoorOpen(game, x, y)) return false; // closed door blocks
  return true;
}

// Does this tile block line of sight (for FoV rays)?
export function blocksSight(game, x, y) {
  const t = tileAt(game, x, y);
  if (t === TILE.WALL || t === TILE.TOWER || t === TILE.MOAT) {
    // A broken window punches a sightline through what was a solid wall.
    if (t === TILE.WALL && objAt(game, x, y) === OBJ.GLASS && isWindowBroken(game, x, y)) return false;
    return true;
  }
  const o = objAt(game, x, y);
  if (o === OBJ.DOOR && !isDoorOpen(game, x, y)) return true;
  if (o === OBJ.LIGHT) return true;
  return false;
}

// Is a tile currently lit by any ON light group within its radius (LoS-blocked)?
export function isLit(game, x, y) {
  for (const l of game.map.lights) {
    if (!game.lightState[l.group]) continue;
    const d = Math.max(Math.abs(l.x - x), Math.abs(l.y - y));
    if (d <= l.radius && lightReaches(game, l, x, y)) return true;
  }
  return false;
}

function lightReaches(game, light, x, y) {
  // Bresenham-ish LoS from lamp to tile; blocked by walls/closed doors.
  let x0 = light.x;
  let y0 = light.y;
  const dx = Math.abs(x - x0);
  const dy = -Math.abs(y - y0);
  const sx = x0 < x ? 1 : -1;
  const sy = y0 < y ? 1 : -1;
  let err = dx + dy;
  let guard = 64;
  while (guard-- > 0) {
    if (x0 === x && y0 === y) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
    if (x0 === x && y0 === y) return true;
    // opaque tile between lamp and target blocks the light
    if (blocksSight(game, x0, y0)) return false;
  }
  return false;
}

// Prisoner cardinal FoV → Map of "x,y" -> visibility level.
export function computeFoV(game, prisoner) {
  const vis = new Map();
  const key = (x, y) => `${x},${y}`;
  vis.set(key(prisoner.x, prisoner.y), VIS.CLEAR);
  for (const { dx, dy } of DIR_VEC) {
    let cx = prisoner.x;
    let cy = prisoner.y;
    for (let step = 1; step <= FOV_RANGE; step++) {
      cx += dx;
      cy += dy;
      if (tileAt(game, cx, cy) === TILE.WALL && step > 0) {
        // still reveal the wall's outline then stop
        vis.set(key(cx, cy), VIS.OUTLINE);
        break;
      }
      const lit = isLit(game, cx, cy);
      let level = lit ? VIS.CLEAR : step <= 2 ? VIS.FOGGY : VIS.OUTLINE;
      vis.set(key(cx, cy), Math.max(vis.get(key(cx, cy)) || 0, level));
      if (blocksSight(game, cx, cy)) break;
    }
  }
  return vis;
}

// The Watcher's true 90-degree gaze wedge from the tower center.
export function inWatcherGaze(game, dir, x, y) {
  const { center } = game.map;
  const dx = x - center.x;
  const dy = y - center.y;
  switch (dir) {
    case 0:
      return dy < 0 && Math.abs(dx) <= -dy; // North
    case 1:
      return dx > 0 && Math.abs(dy) <= dx; // East
    case 2:
      return dy > 0 && Math.abs(dx) <= dy; // South
    case 3:
      return dx < 0 && Math.abs(dy) <= -dx; // West
    default:
      return false;
  }
}

// ---- Prisoner actions ----------------------------------------------------

export function moveActivePrisoner(game, dir) {
  if (game.turn !== "Prisoner" || game.status !== "playing") {
    return { ok: false, reason: "not-your-turn" };
  }
  const p = game.prisoners[game.activePrisoner];
  if (!p.alive || p.escaped) return { ok: false, reason: "inactive" };
  if (p.mp <= 0) return { ok: false, reason: "no-mp" };

  const { dx, dy } = DIR_VEC[dir];
  const nx = p.x + dx;
  const ny = p.y + dy;

  const o = objAt(game, nx, ny);

  // Closed door in the way: opening it consumes the move, stays put, silent.
  if (o === OBJ.DOOR && !isDoorOpen(game, nx, ny)) {
    game.openedDoors.add(ny * game.map.size + nx);
    p.openedDoors.add(ny * game.map.size + nx);
    p.mp -= 1;
    logMsg(game, `Prisoner picks the lock — door opens.`);
    return { ok: true, event: "door-open", x: nx, y: ny };
  }

  // Switch: toggle its light group, stays put, silent, costs 1 MP. A group
  // cut by CUTTERS is dead for good and no longer responds.
  if (o === OBJ.SWITCH) {
    const g = game.map.lightGroup[ny][nx];
    if (game.deadLightGroups.has(g)) {
      p.mp -= 1;
      logMsg(game, `The switch is dead — that circuit was cut.`);
      return { ok: true, event: "switch-dead", group: g };
    }
    game.lightState[g] = !game.lightState[g];
    p.mp -= 1;
    logMsg(game, `Prisoner flips a switch — lights ${game.lightState[g] ? "on" : "off"}.`);
    return { ok: true, event: "switch", group: g, on: game.lightState[g] };
  }

  if (!isWalkable(game, nx, ny)) {
    return { ok: false, reason: "blocked" };
  }

  p.x = nx;
  p.y = ny;
  p.mp -= 1;

  let event = "move";
  let picked = null;

  // Walked onto a pickup: take it if there's room. Retire the tile the
  // instant it's taken, so a second prisoner stepping on the same square
  // this turn can't collect a ghost copy.
  if (o === OBJ.ITEM && !isItemTaken(game, nx, ny)) {
    const entry = (game.map.items || []).find((it) => it.x === nx && it.y === ny);
    if (entry && p.items.length < ITEM_CAP) {
      game.takenItems.add(ny * game.map.size + nx);
      p.items.push(entry.kind);
      picked = entry.kind;
      logMsg(game, `Prisoner picks up a ${ITEM_INFO[entry.kind].label}.`);
      event = "item-pickup";
    } else if (entry) {
      logMsg(game, `Hands full — left the ${ITEM_INFO[entry.kind].label} behind.`);
    }
  }

  // Reached the exit?
  if (o === OBJ.EXIT) {
    p.escaped = true;
    checkEndConditions(game);
    event = "exit";
  }

  return { ok: true, event, x: nx, y: ny, picked };
}

export function isItemTaken(game, x, y) {
  return game.takenItems.has(y * game.map.size + x);
}

// ---- Prisoner items ------------------------------------------------------

// Use a carried item. `arg` is a direction index for the two that act on an
// adjacent tile (LOCKPICK/CUTTERS), or an {x,y} target for DISTRACT.
// Every item costs the item itself; only DISTRACT also costs MP, since it's
// the one that acts at range rather than on something you already walked to.
export function useItem(game, kind, arg) {
  if (game.turn !== "Prisoner" || game.status !== "playing") {
    return { ok: false, reason: "not-your-turn" };
  }
  const p = game.prisoners[game.activePrisoner];
  if (!p.alive || p.escaped) return { ok: false, reason: "inactive" };
  const slot = p.items.indexOf(kind);
  if (slot === -1) return { ok: false, reason: "not-carried" };

  const consume = () => p.items.splice(slot, 1);

  if (kind === ITEM_KINDS.MUFFLE) {
    if (p.muffled) return { ok: false, reason: "already-muffled" };
    p.muffled = true;
    consume();
    logMsg(game, `Cloth wrapped — this turn's steps make no noise.`);
    return { ok: true, event: "muffle" };
  }

  if (kind === ITEM_KINDS.DISTRACT) {
    if (p.mp <= 0) return { ok: false, reason: "no-mp" };
    // Accepts either an explicit {x,y} or a direction index — the direction
    // form throws it as far down that line as the map allows, so the UI can
    // reuse the same "arm, then press a direction" gesture as break-window
    // instead of needing a separate tile-picker.
    const target = typeof arg === "number" ? distractTarget(game, p, arg) : arg;
    const tx = target && target.x;
    const ty = target && target.y;
    if (!Number.isInteger(tx) || !Number.isInteger(ty)) return { ok: false, reason: "no-target" };
    if (tileAt(game, tx, ty) !== TILE.FLOOR) return { ok: false, reason: "bad-target" };
    const d = Math.max(Math.abs(tx - p.x), Math.abs(ty - p.y));
    if (d > DISTRACT_RANGE) return { ok: false, reason: "out-of-range" };
    if (d < 2) return { ok: false, reason: "too-close" }; // a decoy at your feet isn't a decoy
    p.mp -= 1;
    consume();
    // Real noise on the Watcher's board, but NOT self-noise — the whole
    // point is that it points somewhere the prisoner isn't.
    addNoise(game, tx, ty, "decoy");
    logMsg(game, `A clatter rings out across the yard.`);
    return { ok: true, event: "distract", x: tx, y: ty };
  }

  const { dx, dy } = DIR_VEC[arg] || {};
  if (dx === undefined) return { ok: false, reason: "no-direction" };
  const nx = p.x + dx;
  const ny = p.y + dy;

  if (kind === ITEM_KINDS.LOCKPICK) {
    if (objAt(game, nx, ny) !== OBJ.DOOR) return { ok: false, reason: "no-door" };
    if (isDoorOpen(game, nx, ny)) return { ok: false, reason: "already-open" };
    game.openedDoors.add(ny * game.map.size + nx);
    p.openedDoors.add(ny * game.map.size + nx);
    consume();
    logMsg(game, `Lockpick turns — the door swings open, free of charge.`);
    return { ok: true, event: "lockpick", x: nx, y: ny };
  }

  if (kind === ITEM_KINDS.CUTTERS) {
    if (objAt(game, nx, ny) !== OBJ.SWITCH) return { ok: false, reason: "no-switch" };
    const g = game.map.lightGroup[ny][nx];
    if (game.deadLightGroups.has(g)) return { ok: false, reason: "already-cut" };
    game.deadLightGroups.add(g);
    game.lightState[g] = false;
    consume();
    logMsg(game, `Wires snipped — that circuit is dark for good.`);
    return { ok: true, event: "cutters", group: g, x: nx, y: ny };
  }

  return { ok: false, reason: "unknown-item" };
}

export const DISTRACT_RANGE = 6;

// Furthest floor tile along `dir` within DISTRACT_RANGE that a thrown decoy
// could plausibly land on — stops at the first sight-blocker, since you
// can't lob it through a wall. Returns null if nothing valid is far enough
// (the "too close" rule still applies at the call site).
export function distractTarget(game, prisoner, dir) {
  const { dx, dy } = DIR_VEC[dir] || {};
  if (dx === undefined) return null;
  let best = null;
  let cx = prisoner.x;
  let cy = prisoner.y;
  for (let step = 1; step <= DISTRACT_RANGE; step++) {
    cx += dx;
    cy += dy;
    if (blocksSight(game, cx, cy)) break;
    if (tileAt(game, cx, cy) === TILE.FLOOR && step >= 2) best = { x: cx, y: cy };
  }
  return best;
}

// Break a window: a DELIBERATE alternate action, not automatic movement —
// unlike a door (silent, opens on approach), a window is loud on purpose,
// so breaking one is always a real choice: create a shortcut on your own
// path, or break a DIFFERENT one nearby purely as a distraction. Costs 1 MP,
// stays put (matches door/switch — "interact in place" tiles never relocate
// the mover), and the break is permanent (unlike a door it can never be
// closed again either way).
export function breakWindow(game, dir) {
  if (game.turn !== "Prisoner" || game.status !== "playing") {
    return { ok: false, reason: "not-your-turn" };
  }
  const p = game.prisoners[game.activePrisoner];
  if (!p.alive || p.escaped) return { ok: false, reason: "inactive" };
  if (p.mp <= 0) return { ok: false, reason: "no-mp" };

  const { dx, dy } = DIR_VEC[dir];
  const nx = p.x + dx;
  const ny = p.y + dy;

  if (tileAt(game, nx, ny) !== TILE.WALL || objAt(game, nx, ny) !== OBJ.GLASS) {
    return { ok: false, reason: "no-window" };
  }
  if (isWindowBroken(game, nx, ny)) return { ok: false, reason: "already-broken" };

  game.brokenWindows.add(ny * game.map.size + nx);
  p.mp -= 1;
  addNoise(game, nx, ny, "glass");
  pushSelfNoise(p, nx, ny);
  logMsg(game, `Glass shatters — a window breaks open.`);
  return { ok: true, event: "window-break", x: nx, y: ny };
}

// End the prisoner's turn: resolve movement noise, hand initiative to Watcher.
export function endPrisonerTurn(game) {
  if (game.turn !== "Prisoner") return { ok: false };
  const p = game.prisoners[game.activePrisoner];
  const dist =
    Math.abs(p.x - p.startTurnPos.x) + Math.abs(p.y - p.startTurnPos.y);
  // Moving 2+ tiles this turn reveals the tile the prisoner STARTED on —
  // unless a MUFFLE was spent this turn, which is exactly what it buys.
  if (dist >= 2 && p.muffled) {
    logMsg(game, `Muffled — the steps leave no trace.`);
  } else if (dist >= 2) {
    addNoise(game, p.startTurnPos.x, p.startTurnPos.y, "movement");
    pushSelfNoise(p, p.startTurnPos.x, p.startTurnPos.y);
    logMsg(game, `Movement noise heard near (${p.startTurnPos.x}, ${p.startTurnPos.y}).`);
  }
  game.turn = "Watcher";
  game.watcher.rotatedThisTurn = false;
  return { ok: true };
}

// ---- Watcher actions -----------------------------------------------------

export function rotateWatcher(game, delta) {
  if (game.turn !== "Watcher" || game.status !== "playing") return { ok: false };
  if (game.watcher.rotatedThisTurn) return { ok: false, reason: "already-rotated" };
  game.watcher.facing = (game.watcher.facing + delta + 4) % 4;
  game.watcher.rotatedThisTurn = true;
  logMsg(game, `Watcher turns to face ${DIRS[game.watcher.facing]}.`, { watcherOnly: true });
  return { ok: true };
}

// The 180-degree half-plane version, used only for a WIDE_SCAN turn. Kept
// as its own function rather than a flag inside inWatcherGaze so every
// existing caller (FoV rendering, the AI's own reasoning) keeps the normal
// 90-degree meaning unless a scan explicitly asks for the wide one.
export function inWatcherGazeWide(game, dir, x, y) {
  const { center } = game.map;
  const dx = x - center.x;
  const dy = y - center.y;
  switch (dir) {
    case 0: return dy < 0; // North half-plane
    case 1: return dx > 0; // East
    case 2: return dy > 0; // South
    case 3: return dx < 0; // West
    default: return false;
  }
}

export function skillReady(game, skill) {
  return (game.watcher.skills[skill] || 0) === 0;
}

// Can this skill do anything RIGHT NOW? Cooldown aside, LOCK needs an
// actually-open door to slam, and ECHO needs noise to refresh — same
// principle as the items' map validation: never offer an action that
// silently no-ops.
export function skillUsable(game, skill) {
  if (!skillReady(game, skill)) return false;
  if (skill === SKILLS.LOCK) return game.openedDoors.size > 0;
  if (skill === SKILLS.ECHO) return game.noise.length > 0;
  if (skill === SKILLS.DOUBLE_BLUFF) return game.watcher.bluff != null;
  return true;
}

export function useSkill(game, skill, arg) {
  if (game.turn !== "Watcher" || game.status !== "playing") {
    return { ok: false, reason: "not-your-turn" };
  }
  if (!SKILL_INFO[skill]) return { ok: false, reason: "unknown-skill" };
  if (!skillReady(game, skill)) return { ok: false, reason: "cooling-down" };

  const spend = () => (game.watcher.skills[skill] = SKILL_INFO[skill].cooldown);

  if (skill === SKILLS.DOUBLE_BLUFF) {
    // Needs a first bluff to be a SECOND one — otherwise it's just setBluff.
    if (game.watcher.bluff == null) return { ok: false, reason: "no-first-bluff" };
    const dir = arg;
    if (!DIR_VEC[dir]) return { ok: false, reason: "no-direction" };
    if (dir === game.watcher.bluff) return { ok: false, reason: "same-direction" };
    game.watcher.bluff2 = dir;
    spend();
    logMsg(game, `Watcher also declares eyes on ${DIRS[dir]}...`);
    return { ok: true, event: "double-bluff", dir };
  }

  if (skill === SKILLS.WIDE_SCAN) {
    if (game.watcher.wideScan) return { ok: false, reason: "already-armed" };
    game.watcher.wideScan = true;
    // A sweep this broad can't be disguised — it costs you the whole bluff,
    // which is the tradeoff: raw coverage in exchange for misdirection.
    game.watcher.bluff = null;
    game.watcher.bluff2 = null;
    spend();
    logMsg(game, `The tower light widens — a full sweep is coming.`);
    return { ok: true, event: "wide-scan" };
  }

  if (skill === SKILLS.ECHO) {
    if (!game.noise.length) return { ok: false, reason: "no-noise" };
    for (const n of game.noise) n.ttl = NOISE_TTL;
    spend();
    // Watcher-only: the prisoners must not learn that stale intel just got
    // refreshed — that's precisely the information the skill buys.
    logMsg(game, `Echo memory — every trace is fresh again.`, { watcherOnly: true });
    return { ok: true, event: "echo", refreshed: game.noise.length };
  }

  if (skill === SKILLS.DISPATCH) {
    // arg is a quadrant index 0-3 (N/E/S/W), same convention as facing/bluff.
    if (!Number.isInteger(arg) || arg < 0 || arg > 3) return { ok: false, reason: "no-quadrant" };
    const post = game.map.guardPosts[arg];
    // Stable per-guard id so the renderer can track a mesh across moves
    // instead of re-keying by position (which changes every round).
    const w = game.watcher;
    w._guardSeq = (w._guardSeq || 0) + 1;
    const id1 = w._guardSeq;
    w._guardSeq += 1;
    const id2 = w._guardSeq;
    game.watcher.guards.push(
      { id: id1, x: post.x, y: post.y, quadrant: arg, life: GUARD_LIFESPAN },
      { id: id2, x: post.x, y: post.y, quadrant: arg, life: GUARD_LIFESPAN }
    );
    spend();
    logMsg(game, `Guards dispatched to the ${DIRS[arg]} quadrant.`);
    return { ok: true, event: "dispatch", quadrant: arg };
  }

  if (skill === SKILLS.LOCK) {
    // arg is {x,y} of an open door.
    const x = arg && arg.x;
    const y = arg && arg.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: "no-target" };
    if (objAt(game, x, y) !== OBJ.DOOR) return { ok: false, reason: "no-door" };
    if (!isDoorOpen(game, x, y)) return { ok: false, reason: "not-open" };
    // A prisoner standing IN the doorway can't be crushed shut — the door
    // simply won't close on an occupied tile.
    if (game.prisoners.some((p) => p.alive && !p.escaped && p.x === x && p.y === y)) {
      return { ok: false, reason: "occupied" };
    }
    game.openedDoors.delete(y * game.map.size + x);
    for (const p of game.prisoners) p.openedDoors.delete(y * game.map.size + x);
    spend();
    // A door slamming is loud and physical — everyone hears this one.
    logMsg(game, `A door slams shut somewhere in the yard.`);
    return { ok: true, event: "lock", x, y };
  }

  return { ok: false, reason: "unknown-skill" };
}

function quadrantOf(game, x, y) {
  const { center } = game.map;
  const dx = x - center.x, dy = y - center.y;
  if (dx === 0 && dy === 0) return 0;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 0 : 2;
  return dx > 0 ? 1 : 3;
}

// How far a guard can actually SEE, not just walk to. Deliberately much
// shorter than the map — a guard is a physical patroller, not the tower;
// its threat is "don't let one round a corner near you", not omniscience.
export const GUARD_SIGHT_RANGE = 5;

// Any-angle line of sight between two tiles, capped at `maxRange` — this is
// the guards' capture condition instead of the tower's lit-OR-noise
// abstraction: a physical squad just needs an unobstructed look at you, so
// cover (the same walls/closed doors that block computeFoV) is a real
// counter-play against them, distinct from evading the tower's gaze angle.
// Samples the straight line at unit steps and rounds to the nearest tile —
// an approximation (like the rest of this game's grid-based sight checks),
// not a rigorous supercover raycast, but sufficient at this map's scale.
export function hasLineOfSight(game, ax, ay, bx, by, maxRange = GUARD_SIGHT_RANGE) {
  const dist = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  if (dist > maxRange) return false;
  if (dist === 0) return true;
  const dx = bx - ax, dy = by - ay;
  for (let i = 1; i < dist; i++) {
    const t = i / dist;
    const cx = Math.round(ax + dx * t);
    const cy = Math.round(ay + dy * t);
    if (cx === bx && cy === by) continue; // reached target early via rounding
    if (blocksSight(game, cx, cy)) return false;
  }
  return true;
}

// Advance every dispatched guard one round: chase the freshest noise inside
// its assigned quadrant at GUARD_SPEED tiles/turn, capture any live prisoner
// within sight (line-of-sight + range, not just same-tile contact), and
// recall guards whose life ran out without finding anyone (the DISPATCH
// skill's "miss" cost is the spent cooldown, nothing more — a whiff doesn't
// strand a permanent hazard on the map).
export function moveGuards(game) {
  const w = game.watcher;
  for (const guard of w.guards) {
    guard.life -= 1;
    let target = null, bestTtl = -1;
    for (const n of game.noise) {
      if (quadrantOf(game, n.x, n.y) !== guard.quadrant) continue;
      if (n.ttl > bestTtl) { bestTtl = n.ttl; target = n; }
    }
    if (target) {
      const path = bfsPath(game.map, guard.x, guard.y, target.x, target.y, null);
      if (path && path.length > 1) {
        const steps = Math.min(GUARD_SPEED, path.length - 1);
        guard.x = path[steps].x;
        guard.y = path[steps].y;
      }
    }
    for (const p of game.prisoners) {
      if (!p.alive || p.escaped) continue;
      if (hasLineOfSight(game, guard.x, guard.y, p.x, p.y)) {
        p.alive = false;
        logMsg(game, `Guards corner Prisoner ${p.id + 1}!`);
      }
    }
  }
  w.guards = w.guards.filter((g) => g.life > 0);
  checkEndConditions(game);
}

export function setBluff(game, dir) {
  if (game.turn !== "Watcher" || game.status !== "playing") return { ok: false };
  game.watcher.bluff = dir;
  logMsg(game, `Watcher declares eyes on ${DIRS[dir]}...`);
  return { ok: true };
}

// The Watcher commits: scan the true gaze wedge. Any prisoner inside it that is
// exposed (lit OR on a fresh noise tile) is captured.
// Capture exposure widens with difficulty (Brain idea OPT-E1 / resolves
// tension OPT-1: an AI-vs-AI balance sim can't measure a "harder" Watcher
// whose only edge is bluff frequency, since the AI has no model of a human
// reading the tower eye — bluffing is invisible to the sim either way. This
// makes difficulty a genuine mechanical lever instead: easy forgives noise
// without light, hard punishes noise near you even unlit).
//  - easy:   caught only if actually LIT.
//  - medium: lit OR standing on a fresh noise tile (original rule).
//  - hard:   lit OR noise on/adjacent (within 1 tile) — sound alone can
//            doom you if you're careless nearby, not just on the exact tile.
export function isExposed(game, x, y, difficulty) {
  if (isLit(game, x, y)) return true;
  if (difficulty === "easy") return false;
  if (difficulty === "hard") return noiseNear(game, x, y, 1);
  return noiseAt(game, x, y); // medium (default)
}

function noiseNear(game, x, y, radius) {
  return game.noise.some(
    (n) => Math.max(Math.abs(n.x - x), Math.abs(n.y - y)) <= radius
  );
}

export function watcherScan(game, difficulty = "medium") {
  if (game.turn !== "Watcher") return { ok: false };
  // First-round grace: the eye is still "waking up" — no captures on round 1.
  // This gives players a turn to read the board and the visible gaze before risk.
  if (game.round <= 1) {
    logMsg(game, `Watcher sweeps the yard... (the eye is still settling).`);
    return { ok: true, caught: null, grace: true };
  }
  const dir = game.watcher.facing;
  const wide = !!game.watcher.wideScan;
  const inGaze = wide ? inWatcherGazeWide : inWatcherGaze;
  let caught = null;
  for (const p of game.prisoners) {
    if (!p.alive || p.escaped) continue;
    if (!inGaze(game, dir, p.x, p.y)) continue;
    if (isExposed(game, p.x, p.y, difficulty)) {
      p.alive = false;
      caught = p;
      logMsg(game, `Watcher's gaze locks on — Prisoner ${p.id + 1} is caught!`);
      break;
    }
  }
  checkEndConditions(game);
  return { ok: true, caught, wide };
}

// End the Watcher's turn: age noise, refresh prisoner MP, hand back initiative.
export function endWatcherTurn(game) {
  if (game.turn !== "Watcher") return { ok: false };
  // Age noise markers.
  game.noise = game.noise
    .map((n) => ({ ...n, ttl: n.ttl - 1 }))
    .filter((n) => n.ttl > 0);
  // Snapshot before clearing: the prisoner AI's gullible check reads what was
  // CLAIMED last turn (lastBluff), since the live bluff itself only exists
  // during the Watcher's own turn and is gone by the time prisoners act.
  game.watcher.lastBluff = game.watcher.bluff;
  game.watcher.bluff = null;
  game.watcher.bluff2 = null;
  game.watcher.wideScan = false; // armed for exactly one scan
  if (game.watcher.guards.length) moveGuards(game);
  // Tick every skill cooldown down one Watcher turn.
  for (const k of Object.keys(game.watcher.skills)) {
    if (game.watcher.skills[k] > 0) game.watcher.skills[k] -= 1;
  }

  // Advance to next living, un-escaped prisoner.
  const next = nextActivePrisoner(game);
  if (next === -1) {
    checkEndConditions(game);
    return { ok: true, ended: true };
  }
  game.activePrisoner = next;
  const p = game.prisoners[next];
  p.mp = MP_PER_TURN;
  p.startTurnPos = { x: p.x, y: p.y };
  p.selfNoise = []; // "erased when the Watcher's turn begins" — gone by next turn
  p.muffled = false; // one turn only
  game.turn = "Prisoner";
  game.round += 1;
  checkEndConditions(game);
  return { ok: true };
}

// ---- Helpers -------------------------------------------------------------

function nextActivePrisoner(game) {
  const n = game.prisoners.length;
  for (let i = 1; i <= n; i++) {
    const idx = (game.activePrisoner + i) % n;
    const p = game.prisoners[idx];
    if (p.alive && !p.escaped) return idx;
  }
  // maybe the current one is still active
  const cur = game.prisoners[game.activePrisoner];
  if (cur && cur.alive && !cur.escaped) return game.activePrisoner;
  return -1;
}

function addNoise(game, x, y, source) {
  game.noise = game.noise.filter((n) => !(n.x === x && n.y === y));
  game.noise.push({ x, y, ttl: NOISE_TTL, source });
}

function pushSelfNoise(prisoner, x, y) {
  if (!prisoner.selfNoise.some((n) => n.x === x && n.y === y)) {
    prisoner.selfNoise.push({ x, y });
  }
}

export function noiseAt(game, x, y) {
  return game.noise.some((n) => n.x === x && n.y === y);
}

// `watcherOnly`: true for an entry that reveals the Watcher's TRUE state
// (currently just the real facing on rotate) — the log has no per-viewer
// filtering of its own, so this flag is how ui.js's renderLog keeps a
// Prisoner-role viewer from reading the one thing the whole game hides from
// them. The Watcher's bluff *declaration* is deliberately NOT flagged: that
// claim is meant to be public (it's the paranoia mechanic), only the real
// rotation is secret.
function logMsg(game, msg, opts = {}) {
  game.log.unshift({ round: game.round, msg, watcherOnly: !!opts.watcherOnly });
  if (game.log.length > 60) game.log.pop();
}

function checkEndConditions(game) {
  const anyEscaped = game.prisoners.some((p) => p.escaped);
  const allDown = game.prisoners.every((p) => !p.alive || p.escaped);
  const anyAliveInPlay = game.prisoners.some((p) => p.alive && !p.escaped);

  if (anyEscaped) {
    game.status = "escaped";
    game.winner = "Prisoner";
  } else if (!anyAliveInPlay && allDown) {
    game.status = "captured";
    game.winner = "Watcher";
  } else if (game.round > ROUND_LIMIT) {
    // Time ran out: nobody reached the gate, so the institution holds.
    game.status = "captured";
    game.winner = "Watcher";
    game.timedOut = true;
  }
}

// Convenience for AI / UI: is the game over?
export function isOver(game) {
  return game.status !== "playing";
}
