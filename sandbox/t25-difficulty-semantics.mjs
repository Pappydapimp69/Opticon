// t25-difficulty-semantics.mjs — Sandbox model settling Tension T25:
// does "difficulty" mean SURVEILLANCE STRENGTH (helping whoever plays the
// Watcher) or OPPONENT SKILL RELATIVE TO THE HUMAN'S ROLE?
//
// The two readings make opposite predictions for a human WATCHER:
//   * surveillance-strength -> "hard" makes the human Watcher's job EASIER
//     (their scans catch more), i.e. the difficulty label is inverted for
//     that role.
//   * opponent-skill        -> "hard" makes the human Watcher's job HARDER
//     (the prisoners they hunt are better).
//
// Deterministic: fixed seeds, no RNG beyond the game's own seeded PRNG, no
// wall-clock timing. Run: node sandbox/t25-difficulty-semantics.mjs
import { generateMap, MAP_DEFAULTS } from "../game/src/map.js";
import { createGame, endPrisonerTurn, isOver } from "../game/src/rules.js";
import { playWatcherTurn, DIFFICULTY } from "../game/src/watcherAI.js";
import { prisonerAITurn } from "../game/src/prisonerAI.js";

const GAMES = 240;
const TIERS = ["easy", "medium", "hard"];

// One game. `behaviourTier` drives the Watcher AI's decision quality;
// `exposureTier` drives the capture rule (isExposed) inside watcherScan.
// Separating them is the whole point: the shipped game ties them together,
// so we have to pull them apart to see which one the label is really moving.
// Deterministic but NON-CONSTANT randomness. An earlier version of this
// sandbox pinned rng to a constant 0.5, which silently collapsed every
// probability-threshold parameter to always-true or always-false — two
// tiers differing only in a probability became the SAME agent, and the
// grid below reported them as indistinguishable for that reason rather
// than for any real one. A seeded PRNG keeps runs reproducible without
// disabling the very knobs under test.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(seed, behaviourTier, exposureTier) {
  const rng = seeded(seed ^ 0x9e3779b9);
  const map = generateMap(seed, { ...MAP_DEFAULTS, prisonerCount: 3 });
  const g = createGame(map, { watcherFacing: seed % 4, prisoners: map.spawns });
  let guard = 200;
  while (!isOver(g) && guard-- > 0) {
    prisonerAITurn(g, rng, behaviourTier === null ? "medium" : "medium");
    if (isOver(g)) break;
    endPrisonerTurn(g);
    if (isOver(g)) break;
    playWatcherTurn(g, behaviourTier, seed, exposureTier);
  }
  return g.status;
}

function rate(behaviourTier, exposureTier) {
  let captured = 0;
  for (let i = 0; i < GAMES; i++) {
    const seed = (i * 2654435761) >>> 0 || 1;
    if (run(seed, behaviourTier, exposureTier) === "captured") captured++;
  }
  return (captured / GAMES) * 100;
}

console.log("T25 sandbox — what does the difficulty label actually move?\n");
console.log("Capture rate %, by (Watcher BEHAVIOUR tier) x (EXPOSURE rule tier):\n");
console.log("behaviour \\ exposure |  easy  medium   hard");
const grid = {};
for (const b of TIERS) {
  const row = TIERS.map((e) => {
    const r = rate(b, e);
    grid[`${b}/${e}`] = r;
    return r.toFixed(0).padStart(6);
  });
  console.log(`${b.padEnd(20)}|${row.join("  ")}`);
}

// --- Experiment 1: hold BEHAVIOUR fixed, vary the EXPOSURE rule.
// This is the situation of a HUMAN Watcher: their own decision quality is
// whatever it is; the difficulty setting only changes the capture rule.
console.log("\n[1] Human-Watcher analogue — behaviour fixed, exposure varies:");
for (const b of TIERS) {
  const lo = grid[`${b}/easy`];
  const hi = grid[`${b}/hard`];
  console.log(
    `    behaviour=${b.padEnd(6)} exposure easy->hard: ${lo.toFixed(0)}% -> ${hi.toFixed(0)}% captured  (${(hi - lo >= 0 ? "+" : "")}${(hi - lo).toFixed(0)} pts for the Watcher)`
  );
}

// --- Experiment 2: hold EXPOSURE fixed, vary BEHAVIOUR.
console.log("\n[2] Behaviour alone — exposure fixed, behaviour varies:");
for (const e of TIERS) {
  const lo = grid[`easy/${e}`];
  const hi = grid[`hard/${e}`];
  console.log(
    `    exposure=${e.padEnd(6)}  behaviour easy->hard: ${lo.toFixed(0)}% -> ${hi.toFixed(0)}% captured  (${(hi - lo >= 0 ? "+" : "")}${(hi - lo).toFixed(0)} pts)`
  );
}

// --- Verdict.
const expDelta = TIERS.map((b) => grid[`${b}/hard`] - grid[`${b}/easy`]);
const behDelta = TIERS.map((e) => grid[`hard/${e}`] - grid[`easy/${e}`]);
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(`\nAverage swing from the EXPOSURE rule alone : ${avg(expDelta).toFixed(1)} pts`);
console.log(`Average swing from BEHAVIOUR alone        : ${avg(behDelta).toFixed(1)} pts`);
const exposureDominant = Math.abs(avg(expDelta)) > Math.abs(avg(behDelta));
console.log(
  `\nVERDICT: the difficulty label is dominated by ${exposureDominant ? "the EXPOSURE rule" : "Watcher BEHAVIOUR"}.`
);
if (avg(expDelta) > 0) {
  console.log(
    "Because the exposure rule helps WHOEVER holds the tower, raising difficulty\n" +
    "makes a HUMAN WATCHER's job EASIER, not harder — the label is inverted for\n" +
    "that role. This is exactly the fork T25 describes, now measured."
  );
}
