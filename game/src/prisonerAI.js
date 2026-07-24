// prisonerAI.js — AI that plays the Prisoner. Pure logic (no rendering).
// Paths toward the exit with BFS, and tries not to END a turn standing on a
// tile that is both lit and inside the Watcher's (possibly bluffed) gaze — the
// only way to be captured. Shared by the in-game AI and the balance simulator.

import { DIR_VEC } from "./map.js";
import { moveActivePrisoner, isLit, inWatcherGaze, isOver } from "./rules.js";
import { bfsPath, stepToward } from "./pathfind.js";

// Is a tile a place the Watcher could capture you on (lit AND in true/bluff gaze)?
function dangerous(game, x, y) {
  const lit = isLit(game, x, y);
  if (!lit) return false;
  const g = game.watcher;
  if (inWatcherGaze(game, g.facing, x, y)) return true;
  if (g.bluff != null && inWatcherGaze(game, g.bluff, x, y)) return true;
  return false;
}

// Direction (0..3) from a to b if adjacent, else -1.
function dirBetween(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === -1) return 0;
  if (dx === 1 && dy === 0) return 1;
  if (dx === 0 && dy === 1) return 2;
  if (dx === -1 && dy === 0) return 3;
  return -1;
}

// Turns of zero progress before the AI abandons caution and commits to the
// exit unconditionally (resolves T24 — no round cap otherwise exists, so a
// cautious AI could in principle stall a human Watcher's game forever).
const STALL_LIMIT = 3;

// Play one full prisoner turn (does NOT end the turn; caller does that).
// rng: optional () => [0,1) for tie-breaking variety.
export function prisonerAITurn(game, rng = Math.random) {
  const p = game.prisoners[game.activePrisoner];
  const exit = game.map.exit;
  let stepsThisTurn = 0;
  const distBefore = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y);

  // Once stalled too many turns in a row, drop caution entirely: no avoid
  // set, no danger-based early stop, no quiet-discipline pausing. This
  // guarantees the turn makes real progress (or ends the game trying), so a
  // stalemate can never persist indefinitely.
  const committed = p.stalledTurns >= STALL_LIMIT;

  while (p.mp > 0 && !isOver(game)) {
    // Prefer a route that avoids dangerous tiles; fall back to shortest.
    const avoid = committed ? null : buildAvoidSet(game);
    const path = bfsPath(game.map, p.x, p.y, exit.x, exit.y, avoid);
    if (!path || path.length < 2) break;

    const next = path[1];
    const dir = dirBetween(p.x, p.y, next.x, next.y);
    if (dir < 0) break;

    // If stepping there would strand us on a dangerous tile AND we've already
    // moved (so we can safely stop without wasting the turn), hold position —
    // unless we've committed, in which case danger no longer holds us back.
    if (!committed) {
      const endsDangerous = dangerous(game, next.x, next.y);
      const nearExit = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y) <= 2;
      if (endsDangerous && stepsThisTurn >= 1 && !nearExit) break;
    }

    const r = moveActivePrisoner(game, dir);
    if (!r.ok) {
      // Blocked unexpectedly (e.g., door needed opening — that consumed MP).
      if (r.reason === "blocked") break;
      // door-open / switch consumed MP but didn't move; continue planning.
      if (r.event === "door-open" || r.event === "switch") continue;
      break;
    }
    stepsThisTurn++;
    if (r.event === "exit") break;

    // Quiet discipline when far from the exit: sometimes stop after 2 tiles so
    // the movement-noise reveal doesn't paint a long trail. Near the exit, or
    // once committed, push through instead.
    const distExit = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y);
    if (!committed && stepsThisTurn >= 2 && distExit > 3 && rng() < 0.4) break;
  }

  // Track genuine progress against the BEST distance ever reached, not just
  // this turn's delta — an oscillation (advance a turn, retreat the next,
  // repeat) can look "improved" turn-over-turn forever without the prisoner
  // ever actually getting closer than it already has been.
  const distAfter = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y);
  if (p.bestDistToExit === Infinity) p.bestDistToExit = distBefore;
  if (distAfter < p.bestDistToExit) {
    p.bestDistToExit = distAfter;
    p.stalledTurns = 0;
  } else {
    p.stalledTurns += 1;
  }

  return stepsThisTurn;
}

function buildAvoidSet(game) {
  // Soft-avoid every currently dangerous tile. bfsPath falls back to ignoring
  // this set if no safe route exists, so it never deadlocks.
  const set = new Set();
  const { size } = game.map;
  // Only scan lit tiles in the two possible wedges (cheap enough at this scale).
  for (const l of game.map.lights) {
    if (!game.lightState[l.group]) continue;
    for (let yy = -l.radius; yy <= l.radius; yy++) {
      for (let xx = -l.radius; xx <= l.radius; xx++) {
        const tx = l.x + xx;
        const ty = l.y + yy;
        if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
        if (dangerous(game, tx, ty)) set.add(`${tx},${ty}`);
      }
    }
  }
  return set;
}
