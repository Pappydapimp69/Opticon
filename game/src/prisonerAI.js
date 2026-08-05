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

// Is a tile a place the Watcher could capture you on (lit AND in the gaze)?
// `believedFacing`, when set, means this prisoner was fooled this turn —
// it judges risk ONLY by that (possibly wrong) direction instead of the
// true facing. Note: `game.watcher.bluff` (the LIVE claim) only exists
// during the Watcher's own turn and is already cleared by the time a
// prisoner acts, so ground truth here is just the real facing — the
// gullible check below is what gives a bluff any effect at all (via
// `lastBluff`, a one-turn-stale snapshot of what was claimed).
function dangerous(game, x, y, believedFacing) {
  const lit = isLit(game, x, y);
  if (!lit) return false;
  return inWatcherGaze(game, believedFacing ?? game.watcher.facing, x, y);
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

// Prisoner-AI behaviour tiers.
//
// MEASURED, and the honest summary is a NEGATIVE result. These were added to
// give the difficulty setting something to mean when the human plays
// Watcher, because the capture-exposure rule it used to drive is symmetric
// and was handing a human Watcher an EASIER job on "hard" (see Tension T25
// and sandbox/t25-difficulty-semantics.mjs). Pinning exposure to the neutral
// baseline in Watcher mode fixed that inversion — that part works.
//
// What did NOT work is these tiers as a replacement lever. Four distinct
// designs were measured against 240 fixed-seed games per tier with a seeded
// PRNG, and every one came out within ~3 points:
//   1. more stopping-discipline on hard      -> 61/62/64% (backwards)
//   2. less stopping-discipline on hard      -> 65/67/65% (flat)
//   3. hard also avoids the gaze quadrant    -> 65/67/70% (backwards; routing
//                                               around it costs more tempo
//                                               than the risk it dodges)
//   4. tempo held constant, caution+items    -> 61/61/62% (flat)
// The pattern across all four: caution costs turns, turns are the scarce
// resource, and the saving never pays for the tempo. A prisoner's fate here
// is dominated by the map and the rules, not by its own decision quality.
//
// So these tiers are kept for FLAVOUR — an "easy" prisoner is visibly more
// careless — and are deliberately NOT relied on as a difficulty lever. A
// lever with real authority has to be a rules lever (prisoner count, MP, or
// item density), which is a design call left open in T25 rather than made
// unattended.
//   caution   — chance of refusing to end a turn on a catchable tile
//   dawdle    — chance of halting at 2 tiles instead of pressing on
//   useItems  — whether it bothers spending pickups at all
//   avoidGaze — route around the whole watched quadrant (measured harmful;
//               retained as a named, off-by-default knob so the refutation
//               is reproducible rather than lost)
// gullible — chance the prisoner trusts what the Watcher claimed LAST turn
// (lastBluff) as the true gaze this turn, i.e. actually gets fooled. This is
// the rules-level lever T25 said was still missing: previously a human
// Watcher's bluff was pure cosmetic UI — the AI's danger check only ever
// consulted the true facing (the live bluff field is already null by the
// time a prisoner acts), so bluffing never opened a real blind spot. hard
// never falls for it, matching the direction the other fields already set.
export const PRISONER_SKILL = Object.freeze({
  easy:   { caution: 0.0, dawdle: 0.6, useItems: false, avoidGaze: false, gullible: 0.55 },
  medium: { caution: 1.0, dawdle: 0.4, useItems: true,  avoidGaze: false, gullible: 0.22 },
  hard:   { caution: 1.0, dawdle: 0.0, useItems: true,  avoidGaze: false, gullible: 0 },
});
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
function useItemsOpportunistically(game, p, committed, rng, believedFacing) {
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
  if (p.items.includes(ITEM_KINDS.DISTRACT) && p.mp >= 2 && dangerous(game, p.x, p.y, believedFacing)) {
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
export function prisonerAITurn(game, rng = Math.random, skill = "medium") {
  const p = game.prisoners[game.activePrisoner];
  const exit = game.map.exit;
  const startPos = { x: p.x, y: p.y };
  const tune = PRISONER_SKILL[skill] || PRISONER_SKILL.medium;
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

  // Rolled once per turn, not per tile: a fooled prisoner stays fooled for
  // the whole turn rather than re-guessing at every step.
  let believedFacing = (tune.gullible > 0 && game.watcher.lastBluff != null && rng() < tune.gullible)
    ? game.watcher.lastBluff
    : null;

  // FEATHER: this AI reads game.watcher.facing directly, so true sight is
  // worth nothing to it EXCEPT in the one state where its knowledge is
  // actually wrong — when a bluff has fooled it this turn. Spending the
  // feather there is the same trade a human makes (one-use certainty
  // against a claim), and it stops the item being a dead slot in an AI's
  // two-item belt. A non-fooled AI correctly hoards it.
  if (believedFacing != null && p.items.includes(ITEM_KINDS.FEATHER)) {
    if (useItem(game, ITEM_KINDS.FEATHER, null).ok) believedFacing = null;
  }

  if (tune.useItems) useItemsOpportunistically(game, p, committed, rng, believedFacing);

  // A short detour to a pickup, but never while committed — the whole point
  // of the commit state is that it stops making side trips.
  const detour = committed || !tune.useItems ? null : nearbyItem(game, p);

  while (p.mp > 0 && !isOver(game)) {
    // Prefer a route that avoids dangerous tiles; fall back to shortest.
    const avoid = committed ? null : buildAvoidSet(game, tune.avoidGaze, believedFacing);
    const goal = detour && !isItemTaken(game, detour.x, detour.y) ? detour : exit;
    const path = bfsPath(game.map, p.x, p.y, goal.x, goal.y, avoid);
    if (!path || path.length < 2) break;

    const next = path[1];
    const dir = dirBetween(p.x, p.y, next.x, next.y);
    if (dir < 0) break;

    // If stepping there would strand us on a dangerous tile AND we've already
    // moved (so we can safely stop without wasting the turn), hold position —
    // unless we've committed, in which case danger no longer holds us back.
    if (!committed && rng() < tune.caution) {
      const endsDangerous = dangerous(game, next.x, next.y, believedFacing);
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
    if (!committed && stepsThisTurn >= 2 && distExit > 3 && rng() < tune.dawdle) break;
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

function buildAvoidSet(game, avoidGaze, believedFacing) {
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
        if (dangerous(game, tx, ty, believedFacing)) set.add(`${tx},${ty}`);
      }
    }
  }
  // A skilled prisoner treats the whole watched quadrant as risky, not just
  // the tiles that happen to be lit inside it — the gaze is the thing that
  // will still be pointing there next turn. bfsPath falls back to ignoring
  // the set entirely when no route avoids it, so this can never deadlock.
  if (avoidGaze) {
    const g = believedFacing != null ? { facing: believedFacing } : game.watcher;
    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        if (inWatcherGaze(game, g.facing, xx, yy)) set.add(`${xx},${yy}`);
      }
    }
  }
  return set;
}
