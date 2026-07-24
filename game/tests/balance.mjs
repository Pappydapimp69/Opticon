// balance.mjs — Simulate many full games (headless, pure logic) to check that
// both outcomes are reachable and difficulty tiers actually differ.
// Run: node game/tests/balance.mjs [gamesPerDiff]
import { generateMap } from "../src/map.js";
import {
  createGame,
  moveActivePrisoner,
  endPrisonerTurn,
  isOver,
} from "../src/rules.js";
import { playWatcherTurn } from "../src/watcherAI.js";
import { prisonerAITurn } from "../src/prisonerAI.js";

const GAMES = Number(process.argv[2] || 300);
const MAX_ROUNDS = 120;

function prisonerPolicy(g, rng) {
  prisonerAITurn(g, rng);
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

function simulate(difficulty, n) {
  let escaped = 0, captured = 0, timeout = 0, totalRounds = 0;
  for (let i = 0; i < n; i++) {
    const seed = (i * 2654435761) >>> 0 || 1;
    const map = generateMap(seed);
    const g = createGame(map, { watcherFacing: seed % 4 });
    const rng = mulberry(seed ^ 0x9e3779b9);
    let guard = MAX_ROUNDS;
    while (!isOver(g) && guard-- > 0) {
      prisonerPolicy(g, rng);
      if (isOver(g)) break;
      endPrisonerTurn(g);
      if (isOver(g)) break;
      playWatcherTurn(g, difficulty, seed);
    }
    totalRounds += g.round;
    if (g.status === "escaped") escaped++;
    else if (g.status === "captured") captured++;
    else timeout++;
  }
  return { difficulty, n, escaped, captured, timeout, avgRounds: (totalRounds / n).toFixed(1) };
}

console.log(`Simulating ${GAMES} games per difficulty...\n`);
const rows = [];
for (const d of ["easy", "medium", "hard"]) {
  const r = simulate(d, GAMES);
  rows.push(r);
  const esc = ((r.escaped / r.n) * 100).toFixed(0);
  const cap = ((r.captured / r.n) * 100).toFixed(0);
  const to = ((r.timeout / r.n) * 100).toFixed(0);
  console.log(
    `${d.padEnd(7)} | escape ${esc.padStart(3)}%  capture ${cap.padStart(3)}%  timeout ${to.padStart(3)}%  | avg rounds ${r.avgRounds}`
  );
}

// Sanity checks for a healthy beta.
let ok = true;
for (const r of rows) {
  if (r.escaped === 0) { console.error(`\n✗ ${r.difficulty}: escape never happens — too hard`); ok = false; }
  if (r.captured === 0) { console.error(`\n✗ ${r.difficulty}: capture never happens — no threat`); ok = false; }
}
const easyEsc = rows[0].escaped / GAMES;
const hardEsc = rows[2].escaped / GAMES;
if (!(easyEsc >= hardEsc)) {
  console.error(`\n✗ difficulty inverted: easy escape ${(easyEsc*100)|0}% < hard ${(hardEsc*100)|0}%`);
  ok = false;
}
// Regression guard: a stalled/oscillating AI (e.g. routing through a tile it
// can never actually occupy, like a switch) shows up here as a spike in
// timeouts long before anyone notices in play. 15% is a generous ceiling
// above the ~0% baseline — catches a real regression, not sim noise.
const TIMEOUT_CEILING = 0.15;
for (const r of rows) {
  const rate = r.timeout / r.n;
  if (rate > TIMEOUT_CEILING) {
    console.error(`\n✗ ${r.difficulty}: timeout rate ${(rate*100)|0}% exceeds ${TIMEOUT_CEILING*100}% ceiling — AI may be stalling/oscillating`);
    ok = false;
  }
}
console.log(ok ? "\n✓ balance sane: both outcomes reachable; difficulty ordered." : "\n✗ balance needs tuning.");
process.exit(ok ? 0 : 1);
