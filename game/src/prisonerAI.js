// prisonerAI.js — AI that plays the Prisoner. Pure logic (no rendering).
// Paths toward the exit with BFS, and tries not to END a turn standing on a
// tile that is both lit and inside the Watcher's (possibly bluffed) gaze — the
// only way to be captured. Shared by the in-game AI and the balance simulator.

import { DIR_VEC } from "./map.js";
import {
  moveActivePrisoner,
  isLit,
  inWatcherGaze,
  isOver,
  useItem,
  isItemTaken,
  distractTarget,
  objAt,
  isDoorOpen,
  ITEM_CAP,
} from "./rules.js";
import { ITEM_KINDS, OBJ } from "./map.js";
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

// How far off-route the AI will detour to grab a pickup. MEASURED, not
// guessed: at 3 the balance sim's escape rate fell consistently (41/34/13%
// -> 38/32/10% easy/medium/hard over 150 games/tier), and setting it to 0
// restored the baseline exactly — so the detour itself, not the items, was
// the whole cost. In this game tempo is the scarce resource, not safety:
// rounds spent wandering hand the Watcher more scans. At 1 (grab only what
// is literally adjacent) the rate is 40/35/13% — indistinguishable from
// baseline — while the AI still ends up carrying and spending items.
const ITEM_DETOUR = 1;

// Nearest uncollected item within ITEM_DETOUR, or null. Skipped entirely
// once the belt is full or the AI has committed to a straight run.
function nearbyItem(game, p) {
  if (p.items.length >= ITEM_CAP) return null;
  let best = null;
  let bestD = Infinity;
  for (const it of game.map.items || []) {
    if (isItemTaken(game, it.x, it.y)) continue;
    const d = Math.abs(it.x - p.x) + Math.abs(it.y - p.y);
    if (d > 0 && d <= ITEM_DETOUR && d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

// Spend carried items when they'd actually help THIS turn. Each check
// mirrors the item's own precondition, so a use is never attempted that
// rules.js would just refuse.
function useItemsOpportunistically(game, p, committed, rng) {
  // CUTTERS: standing next to a live switch, kill the circuit for good —
  // permanently removing light is worth more than any single turn's move.
  if (p.items.includes(ITEM_KINDS.CUTTERS)) {
    for (let d = 0; d < 4; d++) {
      const { dx, dy } = DIR_VEC[d];
      const nx = p.x + dx;
      const ny = p.y + dy;
      if (objAt(game, nx, ny) !== OBJ.SWITCH) continue;
      const grp = game.map.lightGroup[ny][nx];
      if (!game.lightState[grp] || game.deadLightGroups.has(grp)) continue;
      if (useItem(game, ITEM_KINDS.CUTTERS, d).ok) break;
    }
  }

  // MUFFLE: only worth it when we actually intend to cover ground this
  // turn (2+ tiles is what triggers the noise reveal in the first place)
  // and we're still far enough out that being heard matters.
  if (p.items.includes(ITEM_KINDS.MUFFLE) && !p.muffled && p.mp >= 2) {
    const exit = game.map.exit;
    const far = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y) > 3;
    if (far || committed) useItem(game, ITEM_KINDS.MUFFLE, null);
  }

  // DISTRACT: only when currently standing somewhere the Watcher could
  // catch us — throw the decoy AWAY from the exit so it pulls attention
  // off our actual route rather than onto it.
  if (p.items.includes(ITEM_KINDS.DISTRACT) && p.mp >= 2 && dangerous(game, p.x, p.y)) {
    const exit = game.map.exit;
    const toExit = Math.abs(exit.x - p.x) > Math.abs(exit.y - p.y)
      ? (exit.x > p.x ? 1 : 3)
      : (exit.y > p.y ? 2 : 0);
    const away = (toExit + 2) % 4;
    for (const d of [away, (away + 1) % 4, (away + 3) % 4]) {
      if (!distractTarget(game, p, d)) continue;
      if (useItem(game, ITEM_KINDS.DISTRACT, d).ok) break;
    }
  }
}

// Play one full prisoner turn (does NOT end the turn; caller does that).
// rng: optional () => [0,1) for tie-breaking variety.
export function prisonerAITurn(game, rng = Math.random) {
  const p = game.prisoners[game.activePrisoner];
  const exit = game.map.exit;
  const startPos = { x: p.x, y: p.y };
  let stepsThisTurn = 0;
  // Every tile actually entered this turn, in order. The renderer needs the
  // real sequence to step the avatar through it — without this an AI turn
  // resolves instantly in the sim and the avatar just slides to the end
  // point, so companions read as teleporting rather than moving.
  const walked = [];
  const distBefore = Math.abs(p.x - exit.x) + Math.abs(p.y - exit.y);

  // Once stalled too many turns in a row, drop caution entirely: no avoid
  // set, no danger-based early stop, no quiet-discipline pausing. This
  // guarantees the turn makes real progress (or ends the game trying), so a
  // stalemate can never persist indefinitely.
  const committed = p.stalledTurns >= STALL_LIMIT;

  useItemsOpportunistically(game, p, committed, rng);

  // A short detour to a pickup, but never while committed — the whole point
  // of the commit state is that it stops making side trips.
  const detour = committed ? null : nearbyItem(game, p);

  while (p.mp > 0 && !isOver(game)) {
    // Prefer a route that avoids dangerous tiles; fall back to shortest.
    const avoid = committed ? null : buildAvoidSet(game);
    const goal = detour && !isItemTaken(game, detour.x, detour.y) ? detour : exit;
    const path = bfsPath(game.map, p.x, p.y, goal.x, goal.y, avoid);
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

    // A closed door on the route: a carried lockpick opens it for free,
    // where walking into it would burn a move point.
    if (
      p.items.includes(ITEM_KINDS.LOCKPICK) &&
      objAt(game, next.x, next.y) === OBJ.DOOR &&
      !isDoorOpen(game, next.x, next.y) &&
      useItem(game, ITEM_KINDS.LOCKPICK, dir).ok
    ) {
      continue; // door now open, re-plan and step through with full MP
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
    walked.push({ x: p.x, y: p.y, event: r.event });
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

  return { steps: stepsThisTurn, path: walked, from: startPos };
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
