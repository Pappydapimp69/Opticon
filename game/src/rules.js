// rules.js — Pure game logic for Opticon 3D. No rendering, no DOM.
// Runs identically in the browser (ES module) and Node (for tests).
//
// Design (from Panopticon.md):
//  * Asymmetric turn-based. Prisoner(s) sneak outward-in / toward an EXIT; the
//    Watcher sits in the tower and hunts by inference, not direct sight.
//  * A prisoner has MOVE POINTS per turn. A quiet 1-tile step is safe; moving
//    2+ tiles in a turn, or stepping on glass, emits NOISE revealing a tile.
//  * The Watcher can only rotate 90 deg/turn and may BLUFF a second direction to
//    spread paranoia. A prisoner caught inside the Watcher's true 90 deg gaze
//    wedge (and lit / in-noise) is captured.
//  * Prisoner FoV is cardinal, range-limited, blocked by walls & closed doors,
//    and gated by tile light level.

import { TILE, OBJ, DIRS, DIR_VEC } from "./map.js";

export const MP_PER_TURN = 3;
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
      rotatedThisTurn: false,
    },
    // Which side has the initiative this turn.
    turn: "Prisoner", // "Prisoner" | "Watcher"
    round: 1,
    noise: [], // [{x,y,ttl,source}]
    log: [],
    status: "playing", // "playing" | "escaped" | "captured"
    winner: null, // "Prisoner" | "Watcher"
    openedDoors: new Set(), // global door state (shared world)
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

// Can a prisoner stand on / move into this tile right now?
export function isWalkable(game, x, y) {
  if (tileAt(game, x, y) !== TILE.FLOOR) return false;
  const o = objAt(game, x, y);
  if (o === OBJ.LIGHT) return false; // solid lamp fixture
  if (o === OBJ.DOOR && !isDoorOpen(game, x, y)) return false; // closed door blocks
  return true;
}

// Does this tile block line of sight (for FoV rays)?
export function blocksSight(game, x, y) {
  const t = tileAt(game, x, y);
  if (t === TILE.WALL || t === TILE.TOWER || t === TILE.MOAT) return true;
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

  // Switch: toggle its light group, stays put, silent, costs 1 MP.
  if (o === OBJ.SWITCH) {
    const g = game.map.lightGroup[ny][nx];
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
  // Glass always makes immediate noise at the landing tile.
  if (o === OBJ.GLASS) {
    addNoise(game, nx, ny, "glass");
    pushSelfNoise(p, nx, ny);
    event = "glass";
    logMsg(game, `Glass crunches under the Prisoner's step.`);
  }

  // Reached the exit?
  if (o === OBJ.EXIT) {
    p.escaped = true;
    checkEndConditions(game);
    event = "exit";
  }

  return { ok: true, event, x: nx, y: ny };
}

// End the prisoner's turn: resolve movement noise, hand initiative to Watcher.
export function endPrisonerTurn(game) {
  if (game.turn !== "Prisoner") return { ok: false };
  const p = game.prisoners[game.activePrisoner];
  const dist =
    Math.abs(p.x - p.startTurnPos.x) + Math.abs(p.y - p.startTurnPos.y);
  // Moving 2+ tiles this turn reveals the tile the prisoner STARTED on.
  if (dist >= 2) {
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
  logMsg(game, `Watcher turns to face ${DIRS[game.watcher.facing]}.`);
  return { ok: true };
}

export function setBluff(game, dir) {
  if (game.turn !== "Watcher" || game.status !== "playing") return { ok: false };
  game.watcher.bluff = dir;
  logMsg(game, `Watcher declares eyes on ${DIRS[dir]}...`);
  return { ok: true };
}

// The Watcher commits: scan the true gaze wedge. Any prisoner inside it that is
// exposed (lit OR on a fresh noise tile) is captured.
export function watcherScan(game) {
  if (game.turn !== "Watcher") return { ok: false };
  // First-round grace: the eye is still "waking up" — no captures on round 1.
  // This gives players a turn to read the board and the visible gaze before risk.
  if (game.round <= 1) {
    logMsg(game, `Watcher sweeps the yard... (the eye is still settling).`);
    return { ok: true, caught: null, grace: true };
  }
  const dir = game.watcher.facing;
  let caught = null;
  for (const p of game.prisoners) {
    if (!p.alive || p.escaped) continue;
    if (!inWatcherGaze(game, dir, p.x, p.y)) continue;
    const exposed = isLit(game, p.x, p.y) || noiseAt(game, p.x, p.y);
    if (exposed) {
      p.alive = false;
      caught = p;
      logMsg(game, `Watcher's gaze locks on — Prisoner ${p.id + 1} is caught!`);
      break;
    }
  }
  checkEndConditions(game);
  return { ok: true, caught };
}

// End the Watcher's turn: age noise, refresh prisoner MP, hand back initiative.
export function endWatcherTurn(game) {
  if (game.turn !== "Watcher") return { ok: false };
  // Age noise markers.
  game.noise = game.noise
    .map((n) => ({ ...n, ttl: n.ttl - 1 }))
    .filter((n) => n.ttl > 0);
  game.watcher.bluff = null;

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
  game.turn = "Prisoner";
  game.round += 1;
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

function logMsg(game, msg) {
  game.log.unshift({ round: game.round, msg });
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
  }
}

// Convenience for AI / UI: is the game over?
export function isOver(game) {
  return game.status !== "playing";
}
