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
  struggle,
  guardOver,
  CUSTODY_TURNS,
} from "./rules.js";
import { ITEM_KINDS, OBJ } from "./map.js";
import { costPath, stepToward } from "./pathfind.js";

// ---- What a prisoner is allowed to know about the eye ---------------------
//
// This AI used to read `game.watcher.facing` — the TRUE gaze — directly. That
// is the one fact the entire game exists to withhold: the rotation is logged
// `watcherOnly`, the Gaze stat reads "?" for a Prisoner, and the whole point
// of the bluff is to poison a guess the AI was never actually making. An AI
// that knows the answer is not playing the same game as the human beside it.
//
// So it now carries a BELIEF over the four facings, updated only from things
// a human prisoner can also observe:
//   * the Watcher's public CLAIM (`lastBluff`) — which may be a lie;
//   * where a companion was just caught (`game.lastCaught`) — announced to
//     everyone, and the strongest honest evidence there is;
//   * the standing rule that the eye turns at most 90 deg per turn, which is
//     printed in How-to-play and so is knowledge, not peeking.
// It deliberately does NOT include "am I lit right now": the danger vignette
// reports exposure (lit / noisy), not gaze coverage, so a human learns
// nothing about the facing from it either.

const UNIFORM = () => [0.25, 0.25, 0.25, 0.25];

function normalize(b) {
  const sum = b.reduce((a, v) => a + v, 0) || 1;
  for (let i = 0; i < 4; i++) b[i] /= sum;
  return b;
}

// Probability, under the current belief, that the gaze covers this tile.
// Summed over facings rather than tested against one: the whole point is that
// the prisoner does not know which facing is real.
function gazeRisk(game, belief, x, y) {
  let r = 0;
  for (let d = 0; d < 4; d++) {
    if (belief[d] > 0 && inWatcherGaze(game, d, x, y)) r += belief[d];
  }
  return r;
}

// A tile is only worth fearing if it is LIT (the capture rule needs exposure)
// and the eye plausibly covers it. `caution` is the tier's risk appetite.
function dangerous(game, x, y, belief, caution) {
  if (!isLit(game, x, y)) return false;
  return gazeRisk(game, belief, x, y) >= caution;
}

// One turn of belief revision, in evidence order: spread, then claim, then
// the hard evidence of a body.
function updateGazeBelief(game, p, tune) {
  const b = p.gazeBelief && p.gazeBelief.length === 4 ? p.gazeBelief.slice() : UNIFORM();

  // The eye turns at most 90 deg per turn, so yesterday's certainty is today's
  // three-way maybe. Without this the belief would harden permanently on one
  // direction after a single piece of evidence.
  const spread = [0, 0, 0, 0];
  for (let d = 0; d < 4; d++) {
    spread[d] += b[d] * 0.5;
    spread[(d + 1) % 4] += b[d] * 0.25;
    spread[(d + 3) % 4] += b[d] * 0.25;
  }
  for (let d = 0; d < 4; d++) b[d] = spread[d];

  // The public claim. `trustClaim` is exactly the lever the old `gullible`
  // roll was: how much this prisoner takes the Watcher at its word. A hard
  // prisoner ignores claims entirely, which is what makes bluffing a skill
  // question rather than a dice roll.
  if (game.watcher.lastBluff != null && tune.trustClaim > 0) {
    b[game.watcher.lastBluff] += tune.trustClaim;
  }

  // A companion just died in a wedge. That wedge contained the gaze one turn
  // ago; after the spread above, it still probably does.
  const caught = game.lastCaught;
  if (caught && game.round - caught.round <= 1) {
    for (let d = 0; d < 4; d++) {
      if (inWatcherGaze(game, d, caught.x, caught.y)) b[d] += tune.trustEvidence;
    }
  }

  p.gazeBelief = normalize(b);
  return p.gazeBelief;
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
// The bluff levers live in the belief model (see updateGazeBelief): a claim
// is evidence, not a coin flip. Previously a human Watcher's bluff could only
// matter through a `gullible` dice roll, and on hard that roll was 0 — so
// against a hard prisoner, bluffing was provably inert. Now a claim always
// moves the belief; how far is what the tier decides.
export const PRISONER_SKILL = Object.freeze({
  // caution — the belief threshold at which a lit tile counts as dangerous.
  //   1.01 = never (nothing can exceed certainty), 0.5 = "more likely than
  //   not", 0.25 = "a uniform guess is enough to spook me".
  // trustClaim — how much weight this prisoner gives the Watcher's public
  //   claim. Replaces the old `gullible` dice roll: an easy prisoner walks
  //   into bluffs, a hard one ignores talk entirely.
  // trustEvidence — weight given to where a companion was just caught, which
  //   is the one piece of honest public evidence about the gaze.
  // riskAversion — HOW MANY EXTRA TILES this prisoner will walk to avoid a
  //   lit tile it is certain is watched. This is the lever that replaced the
  //   binary avoid-set: risk is now priced into the route, so 0.25 ("no idea
  //   where the eye is") buys a real, proportionate detour instead of falling
  //   below a threshold and buying nothing. 0 = walks straight through.
  // caution — still a THRESHOLD, but only for the genuinely binary calls:
  //   hold position rather than step onto that tile, throw a decoy now.
  easy:   { caution: 1.01, dawdle: 0.6, useItems: false, riskAversion: 0,  trustClaim: 0.9, trustEvidence: 0.3 },
  medium: { caution: 0.55, dawdle: 0.4, useItems: true,  riskAversion: 5,  trustClaim: 0.35, trustEvidence: 0.9 },
  hard:   { caution: 0.34, dawdle: 0.0, useItems: true,  riskAversion: 9,  trustClaim: 0.0, trustEvidence: 1.4 },
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

// A turn spent in a cell. One decision, taken in priority order, because the
// clock only allows three of them:
//
//  1. Shim — the certain out. Never worth saving: the item exists for exactly
//     this moment and there is no later.
//  2. Flare — only when a guard is actually posted, since that is the one
//     situation struggling cannot beat. Throwing it at empty air wastes the
//     only tool that clears a guard.
//  3. Struggle — free, so always tried when it can do anything.
//  4. Forged Transfer — LAST, and only on the final turn. Spending it early
//     resets a clock that had turns left on it; spending it at 1 turn
//     remaining is the difference between three more attempts and none.
function custodyTurn(game, p, rng, skill) {
  const tune = PRISONER_SKILL[skill] || PRISONER_SKILL.medium;
  if (p.items.includes(ITEM_KINDS.SHIM) && useItem(game, ITEM_KINDS.SHIM, null).ok) return;

  const posted = !!guardOver(game, p);
  if (posted && tune.useItems && p.items.includes(ITEM_KINDS.FLARE)) {
    // Any direction that gives the flare somewhere to land; the pull is by
    // quadrant, so the exact tile matters far less than getting it away.
    for (let d = 0; d < 4; d++) {
      if (useItem(game, ITEM_KINDS.FLARE, d).ok) break;
    }
  }

  // Re-check: a flare that pulled the guard away makes this turn's struggle
  // live, which is the entire point of carrying one.
  if (!guardOver(game, p)) {
    const r = struggle(game, rng);
    if (r.ok && r.freed) return;
  }

  if (p.custody <= 1 && p.items.includes(ITEM_KINDS.TRANSFER)) {
    useItem(game, ITEM_KINDS.TRANSFER, null);
  }
}

// One turn's move (3) plus the adjacency the rescue itself needs.
const RESCUE_REACH = 4;

// Is any teammate close enough to be worth walking to instead of the exit?
// Returns the held prisoner a rescuer should divert toward, or null. Only
// looks at prisoners the rescuer could plausibly reach before the clock runs
// out — a rescue that arrives after processing is just a detour into the
// Watcher's field of view.
function rescueTarget(game, me) {
  let best = null;
  let bestD = Infinity;
  for (const p of game.prisoners) {
    if (p === me || !p.alive || p.escaped || !p.custody) continue;
    const d = Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y));
    // Opportunistic only: reachable within a single turn's move (MP_PER_TURN
    // is 3, and a rescue only needs to end ADJACENT). An earlier version
    // allowed `custody * 3 + 1` — up to ten tiles — reasoning that three turns
    // buys three moves. Measured, that was strictly worse: it marched
    // companions across the map toward the one tile the tower had just proved
    // it was watching, and AI-vs-AI escape on hard fell 29% -> 21% while easy
    // rose. A rescue you have to cross the yard for is not a rescue, it is two
    // captures.
    if (d > RESCUE_REACH) continue;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Spend carried items when they'd actually help THIS turn. Each check
// mirrors the item's own precondition, so a use is never attempted that
// rules.js would just refuse.
function useItemsOpportunistically(game, p, committed, rng, belief, tune) {
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
  if (p.items.includes(ITEM_KINDS.DISTRACT) && p.mp >= 2 && dangerous(game, p.x, p.y, belief, tune.caution)) {
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
  // In a cell there is exactly one problem, and none of the route planning
  // below applies — a held prisoner cannot move, so falling through would
  // burn all three of their turns doing nothing.
  if (p.custody > 0) return custodyTurn(game, p, rng, skill);
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
  // Two reasons to stop paying for safety. The anti-stall commit is one; the
  // other is that safety is currently FREE — a prisoner just out of custody
  // cannot be taken by the gaze at all for a turn or two (RELEASE_GRACE_TURNS),
  // so routing around lit, watched ground during that window buys nothing and
  // spends the only turns where the open ground is actually crossable. An AI
  // that kept creeping through its own reprieve would be modelling a threat
  // that is switched off.
  const committed = p.stalledTurns >= STALL_LIMIT || p.graceTurns > 0;

  // Rolled once per turn, not per tile: a fooled prisoner stays fooled for
  // the whole turn rather than re-guessing at every step.
  let belief = updateGazeBelief(game, p, tune);

  // FEATHER: the item buys certainty, and certainty is only worth spending on
  // when the prisoner is actually UNSURE and actually at risk. Spend it when
  // the belief is still close to a guess (nothing above ~40%) and we intend
  // to cross ground this turn; the answer then collapses the belief onto the
  // truth for the rest of the round — the same trade a human makes.
  if (tune.useItems && p.items.includes(ITEM_KINDS.FEATHER)) {
    const confident = Math.max(...belief) >= 0.4;
    if (!confident && p.mp >= 2 && useItem(game, ITEM_KINDS.FEATHER, null).ok) {
      // Legitimate: the feather's entire purpose is to reveal the facing, and
      // the reveal is surfaced to a human on the Gaze readout too.
      belief = [0, 0, 0, 0];
      belief[game.watcher.facing] = 1;
      p.gazeBelief = belief;
    }
  }

  if (tune.useItems) useItemsOpportunistically(game, p, committed, rng, belief, tune);

  // A short detour to a pickup, but never while committed — the whole point
  // of the commit state is that it stops making side trips.
  const detour = committed || !tune.useItems ? null : nearbyItem(game, p);
  // A teammate in a cell outranks both the exit and any pickup. This is the
  // only thing companions can do for the human now that only your own escape
  // wins the game, and it has to survive `committed` — the anti-stall state
  // exists to stop dithering, not to walk past someone who is about to be
  // processed.
  const rescue = rescueTarget(game, p);

  while (p.mp > 0 && !isOver(game)) {
    // Prefer a route that avoids dangerous tiles; fall back to shortest.
    // Risk is a COST, not a wall. `committed` (the anti-stall state) drops it
    // to zero, which is the whole point of committing: stop paying to be safe.
    const risk = committed || !tune.riskAversion ? null : riskPenalty(game, belief, tune);
    const goal = rescue && rescue.custody
      ? rescue
      : detour && !isItemTaken(game, detour.x, detour.y) ? detour : exit;
    const path = costPath(game.map, p.x, p.y, goal.x, goal.y, risk);
    if (!path || path.length < 2) break;

    const next = path[1];
    const dir = dirBetween(p.x, p.y, next.x, next.y);
    if (dir < 0) break;

    // If stepping there would strand us on a dangerous tile AND we've already
    // moved (so we can safely stop without wasting the turn), hold position —
    // unless we've committed, in which case danger no longer holds us back.
    if (!committed && rng() < tune.caution) {
      const endsDangerous = dangerous(game, next.x, next.y, belief, tune.caution);
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

// Extra route cost for entering a tile, in units of "tiles walked". A tile
// the prisoner is certain is both lit and watched costs `riskAversion` extra
// steps; a tile it thinks is watched with probability 0.25 costs a quarter of
// that. Continuous by construction, so uncertainty produces a proportionate
// detour rather than falling off a threshold and producing nothing.
function riskPenalty(game, belief, tune) {
  return (x, y) => {
    if (!isLit(game, x, y)) return 0;
    return gazeRisk(game, belief, x, y) * tune.riskAversion;
  };
}
