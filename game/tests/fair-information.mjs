// fair-information.mjs — Neither AI may read what its human counterpart
// cannot see.
//
// This is the game's central claim, and it was false: prisonerAI's danger
// check read `game.watcher.facing` — the TRUE gaze — directly, the one fact
// the whole design exists to withhold (the rotation is logged `watcherOnly`
// and the Gaze stat reads "?" for a Prisoner). An AI holding the answer is
// not playing the same game as the human beside it, and it made bluffing
// provably inert against a hard prisoner, whose `gullible` roll was 0.
//
// Asserted by TRAPPING the properties rather than by reading the source: a
// grep can be defeated by an alias or a destructure, an accessor cannot.
// Run: node game/tests/fair-information.mjs
import { generateMap, MAP_DEFAULTS, ITEM_KINDS } from "../src/map.js";
import { createGame, endPrisonerTurn, endWatcherTurn, isOver, setBluff, watcherScan } from "../src/rules.js";
import { prisonerAITurn } from "../src/prisonerAI.js";
import { playWatcherTurn } from "../src/watcherAI.js";

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freshGame(seed, prisonerCount = 3) {
  const map = generateMap(seed, { ...MAP_DEFAULTS, prisonerCount });
  return createGame(map, { watcherFacing: seed % 4, prisoners: map.spawns });
}

// Replace a data property with an accessor that records every read.
function trap(obj, key, log, label) {
  let value = obj[key];
  Object.defineProperty(obj, key, {
    configurable: true,
    get() { log.push(label); return value; },
    set(v) { value = v; },
  });
}

// ---- 1. The prisoner AI must not read the Watcher's true facing -----------
{
  const reads = [];
  let turns = 0;
  for (let i = 0; i < 25; i++) {
    const g = freshGame((i * 2654435761) >>> 0 || 1);
    const rng = mulberry(i + 1);
    trap(g.watcher, "facing", reads, "watcher.facing");
    // Give the AI every reason to want the answer: an active claim, a fresh
    // capture to reason from, and several turns to act.
    g.watcher.lastBluff = (i + 2) % 4;
    for (let t = 0; t < 6 && !isOver(g); t++) {
      prisonerAITurn(g, rng, ["easy", "medium", "hard"][i % 3]);
      turns++;
      endPrisonerTurn(g);
    }
  }
  check(turns > 50, `the prisoner AI actually ran (${turns} turns — a no-op would pass vacuously)`);
  check(reads.length === 0,
    `the prisoner AI never reads the true facing (${reads.length} reads)`);
}

// ---- 2. …unless it spent a Golden Feather, whose whole purpose is that ----
{
  const reads = [];
  const g = freshGame(777, 1);
  const p = g.prisoners[0];
  p.items = [ITEM_KINDS.FEATHER];
  p.gazeBelief = [0.25, 0.25, 0.25, 0.25]; // genuinely unsure, so it will spend
  trap(g.watcher, "facing", reads, "watcher.facing");
  prisonerAITurn(g, mulberry(9), "medium");
  check(reads.length > 0 && p.items.length === 0,
    `a spent feather is the ONE sanctioned read (${reads.length} reads, item consumed: ${p.items.length === 0})`);
}

// ---- 3. The watcher AI must not read prisoner positions -------------------
{
  const reads = [];
  let turns = 0;
  for (let i = 0; i < 25; i++) {
    const g = freshGame((i * 40503) >>> 0 || 3);
    // Open a door so the LOCK skill has something to aim at — the old
    // occupancy pre-check lived exactly on that path.
    const { size } = g.map;
    for (let y = 0; y < size && g.openedDoors.size === 0; y++) {
      for (let x = 0; x < size; x++) {
        if (g.map.objects[y][x] === 1) { g.openedDoors.add(y * size + x); break; }
      }
    }
    for (const p of g.prisoners) {
      trap(p, "x", reads, `p${p.id}.x`);
      trap(p, "y", reads, `p${p.id}.y`);
    }
    for (let t = 0; t < 6 && !isOver(g); t++) {
      playWatcherTurn(g, ["easy", "medium", "hard"][i % 3], i + 1);
      turns++;
    }
  }
  check(turns > 50, `the watcher AI actually ran (${turns} turns)`);
  check(reads.length === 0,
    `the watcher AI never reads prisoner coordinates (${reads.length} reads: ${[...new Set(reads)].slice(0, 4)})`);
}

// ---- 4. The belief is a belief: it starts as a guess and stays uncertain ---
{
  const g = freshGame(4242);
  const p = g.prisoners[0];
  check(p.gazeBelief.length === 4 && p.gazeBelief.every((v) => v === 0.25),
    "a prisoner starts with a flat guess about the gaze");

  // A public claim moves it; the truth does not. Measured on MEDIUM, which is
  // the softest tier whose belief can actually reach behaviour — easy's
  // trustClaim is 0 by construction (see T29 and the comment on
  // PRISONER_SKILL.easy: riskAversion 0 and caution 1.01 both sever belief
  // from routing there, so a non-zero trust was dead configuration that read
  // as intent).
  const rng = mulberry(5);
  g.watcher.facing = 2;
  g.watcher.lastBluff = 0;
  prisonerAITurn(g, rng, "medium");
  const believesClaim = p.gazeBelief[0];
  const believesTruth = p.gazeBelief[2];
  check(believesClaim > believesTruth,
    `a medium prisoner is moved by the CLAIM, not the truth (claim ${believesClaim.toFixed(2)} vs true ${believesTruth.toFixed(2)})`);
  check(Math.abs(p.gazeBelief.reduce((a, b) => a + b, 0) - 1) < 1e-9, "the belief stays a distribution");

  // A hard prisoner ignores talk entirely.
  const g2 = freshGame(4242);
  g2.watcher.facing = 2;
  g2.watcher.lastBluff = 0;
  prisonerAITurn(g2, mulberry(5), "hard");
  const hardSpread = Math.max(...g2.prisoners[0].gazeBelief) - Math.min(...g2.prisoners[0].gazeBelief);
  check(hardSpread < 1e-9, `a hard prisoner is not moved by a claim at all (spread ${hardSpread.toFixed(3)})`);
}

// ---- 5. A claim that moves a NUMBER is not a claim that moves a PRISONER ---
// This section used to accept `positionDiffers || beliefDiffers` as proof that
// "bluffing reaches" a tier. That OR is the whole trap: a belief value can
// move while being structurally unable to reach behaviour, and the assertion
// still goes green. On easy it was doing exactly that — measured across 120
// full games, trustClaim 0 and trustClaim 1.2 produced byte-identical results
// (0/120 differed), because easy's riskAversion 0 short-circuits the route
// pricing and its caution of 1.01 can never be met by a distribution summing
// to 1. Belief and behaviour are counted separately now, and the claim that a
// bluff REACHES a tier is asserted against behaviour.
{
  const belief = {}, behaviour = {};
  for (const tier of ["easy", "medium", "hard"]) {
    let b = 0, moved = 0;
    for (let i = 0; i < 30; i++) {
      const seed = (i * 7919) >>> 0 || 11;
      const a = freshGame(seed); const c = freshGame(seed);
      a.watcher.lastBluff = null;
      c.watcher.lastBluff = (a.watcher.facing + 2) % 4; // claim the opposite
      prisonerAITurn(a, mulberry(i), tier);
      prisonerAITurn(c, mulberry(i), tier);
      const pa = a.prisoners[0], pc = c.prisoners[0];
      if (pa.gazeBelief.some((v, k) => Math.abs(v - pc.gazeBelief[k]) > 1e-9)) b++;
      if (pa.x !== pc.x || pa.y !== pc.y) moved++;
    }
    belief[tier] = b;
    behaviour[tier] = moved;
  }
  console.log(`    a claim moved the BELIEF in:    ${JSON.stringify(belief)} of 30 turns per tier`);
  console.log(`    a claim moved the PRISONER in:  ${JSON.stringify(behaviour)} of 30 turns per tier`);
  check(behaviour.medium > 0, "a bluff actually moves a medium prisoner, not just their belief");
  check(belief.easy === 0 && behaviour.easy === 0,
    "easy is honestly inert: no belief shift, no behaviour shift (T29)");
  check(belief.hard === 0,
    "a hard prisoner is deliberately immune to talk (trustClaim 0) — skill, not gullibility");
}

console.log(ok ? "\n✓ fair-information passed" : "\n✗ fair-information failed");
process.exit(ok ? 0 : 1);
