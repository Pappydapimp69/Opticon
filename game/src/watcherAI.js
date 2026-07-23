// watcherAI.js — Single-player opponent that plays the Watcher.
// Pure logic: given a game, it decides rotate/bluff/scan actions.
//
// The AI never "sees" prisoners directly (that would break the fantasy). It
// reasons from the same public signals a human Watcher gets: fresh NOISE tiles,
// lit tiles, and which quadrant the exit sits in (prisoners must trend there).

import {
  DIRS,
  DIR_VEC,
} from "./map.js";
import {
  rotateWatcher,
  setBluff,
  watcherScan,
  endWatcherTurn,
  inWatcherGaze,
  isOver,
} from "./rules.js";
import { makeRng } from "./map.js";

export const DIFFICULTY = Object.freeze({
  easy: { bluffChance: 0.15, exitBias: 0.2, noiseWeight: 1.0, memory: 1 },
  medium: { bluffChance: 0.4, exitBias: 0.5, noiseWeight: 1.5, memory: 2 },
  hard: { bluffChance: 0.7, exitBias: 0.9, noiseWeight: 2.0, memory: 3 },
});

// Score each of the 4 cardinal directions by how much "suspicion" it holds.
function scoreDirections(game, tuning) {
  const { center } = game.map;
  const scores = [0, 0, 0, 0];

  // Weight fresh noise: newer (higher ttl) matters more, in the wedge it implies.
  for (const n of game.noise) {
    const dx = n.x - center.x;
    const dy = n.y - center.y;
    const dir = dominantDir(dx, dy);
    if (dir < 0) continue;
    scores[dir] += tuning.noiseWeight * n.ttl;
  }

  // Lit, occupied-looking tiles: any lit tile in a wedge adds mild suspicion.
  for (const l of game.map.lights) {
    if (!game.lightState[l.group]) continue;
    const dir = dominantDir(l.x - center.x, l.y - center.y);
    if (dir >= 0) scores[dir] += 0.1;
  }

  // Exit bias: the AI knows prisoners must reach the exit; bias toward that side.
  if (game.map.exit) {
    const ed = dominantDir(
      game.map.exit.x - center.x,
      game.map.exit.y - center.y
    );
    if (ed >= 0) scores[ed] += tuning.exitBias;
  }

  return scores;
}

function dominantDir(dx, dy) {
  if (dx === 0 && dy === 0) return -1;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 0 : 2;
  return dx > 0 ? 1 : 3;
}

// Decide + apply a full Watcher turn. Returns a list of actions taken (for UI).
export function playWatcherTurn(game, difficulty = "medium", seed = 1) {
  const tuning = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const rng = makeRng((seed ^ (game.round * 2654435761)) >>> 0);
  const actions = [];
  if (isOver(game) || game.turn !== "Watcher") return actions;

  const scores = scoreDirections(game, tuning);
  const cur = game.watcher.facing;

  // Best reachable direction this turn (can only rotate +/-1 step, i.e. 90 deg).
  const reachable = [cur, (cur + 1) % 4, (cur + 3) % 4];
  let best = cur;
  let bestScore = -Infinity;
  for (const d of reachable) {
    if (scores[d] > bestScore) {
      bestScore = scores[d];
      best = d;
    }
  }

  // Rotate toward the best reachable direction (one 90-degree step max).
  if (best !== cur) {
    const delta = (best === (cur + 1) % 4) ? 1 : -1;
    const r = rotateWatcher(game, delta);
    if (r.ok) actions.push({ type: "rotate", to: game.watcher.facing });
  } else {
    actions.push({ type: "hold", facing: cur });
  }

  // Maybe bluff a different high-suspicion direction to spread paranoia.
  if (rng() < tuning.bluffChance) {
    // Pick the highest-scoring direction that ISN'T where we're really looking.
    let bluffDir = -1;
    let bs = -Infinity;
    for (let d = 0; d < 4; d++) {
      if (d === game.watcher.facing) continue;
      if (scores[d] > bs) {
        bs = scores[d];
        bluffDir = d;
      }
    }
    if (bluffDir >= 0) {
      setBluff(game, bluffDir);
      actions.push({ type: "bluff", dir: bluffDir });
    }
  }

  // Commit the scan (captures an exposed prisoner in the true wedge).
  const scan = watcherScan(game);
  actions.push({ type: "scan", caught: scan.caught ? scan.caught.id : null });

  // End the turn (ages noise, hands back to prisoner).
  const end = endWatcherTurn(game);
  actions.push({ type: "end", ended: !!end.ended });
  return actions;
}

export { scoreDirections };
