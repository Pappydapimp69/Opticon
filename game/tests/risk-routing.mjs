// risk-routing.mjs — Risk must be a COST, not a wall.
//
// `bfsPath`'s `avoid` set is binary, and when it blocks the route it is
// discarded entirely (pathfind.js). So "risky" was all-or-nothing per tile
// with a total fallback, and "safer but longer" was not expressible. Measured
// consequence: raising the prisoner AI's caution from 0.34 to 0.15 moved its
// speed 2.90 -> 2.81 tiles/turn and its escape rate against a staring Watcher
// not at all (94% -> 96%). Fear had nowhere to go. Every caution / bluff /
// skill lever routed through that search measured ~3pt and was written off as
// weak (T25); they shared one bottleneck.
//
// costPath prices risk into the route instead, so a detour happens exactly
// when it is cheaper than the danger it avoids.
// Run: node game/tests/risk-routing.mjs
import { generateMap, MAP_DEFAULTS } from "../src/map.js";
import { createGame, endPrisonerTurn, endWatcherTurn, isOver, watcherScan, isLit, inWatcherGaze } from "../src/rules.js";
import { bfsPath, costPath } from "../src/pathfind.js";
import { prisonerAITurn, PRISONER_SKILL } from "../src/prisonerAI.js";

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}
function mul(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const world = (i, n = 3) => {
  const map = generateMap((i * 2654435761) >>> 0 || 1, { ...MAP_DEFAULTS, prisonerCount: n });
  return { map, g: createGame(map, { watcherFacing: i % 4, prisoners: map.spawns }) };
};

// ---- 1. With no penalty it must be exactly a shortest-path search ---------
{
  let same = 0, tot = 0;
  for (let i = 0; i < 40; i++) {
    const { map, g } = world(i);
    const p = g.prisoners[0], e = map.exit;
    const b = bfsPath(map, p.x, p.y, e.x, e.y, null);
    const c = costPath(map, p.x, p.y, e.x, e.y, null);
    if (!b || !c) continue;
    tot++;
    if (b.length === c.length) same++;
  }
  check(tot > 30, `sampled enough reachable maps (${tot})`);
  check(same === tot, `zero-cost routing is shortest-path, same as BFS (${same}/${tot})`);
}

// ---- 2. A priced risk buys a detour, and the detour is bounded ------------
{
  let detoured = 0, avoided = [], extra = 0, tot = 0;
  for (let i = 0; i < 40; i++) {
    const { map, g } = world(i);
    const p = g.prisoners[0], e = map.exit;
    const pen = (x, y) => (isLit(g, x, y) && inWatcherGaze(g, g.watcher.facing, x, y) ? 6 : 0);
    const plain = costPath(map, p.x, p.y, e.x, e.y, null);
    const safe = costPath(map, p.x, p.y, e.x, e.y, pen);
    if (!plain || !safe) continue;
    tot++;
    const risky = (path) => path.filter((t) => pen(t.x, t.y) > 0).length;
    if (safe.length > plain.length) { detoured++; extra += safe.length - plain.length; }
    if (risky(plain) > 0) avoided.push((risky(plain) - risky(safe)) / risky(plain));
  }
  const meanAvoided = avoided.reduce((a, b) => a + b, 0) / Math.max(avoided.length, 1);
  console.log(`    ${detoured}/${tot} routes detoured (avg +${(extra / Math.max(detoured, 1)).toFixed(1)} tiles); risky tiles cut by ${(meanAvoided * 100).toFixed(0)}% on ${avoided.length} initially-risky routes`);
  check(detoured > 0, "pricing risk changes at least some routes");
  check(meanAvoided > 0.2, `routes that started risky get materially safer (${(meanAvoided * 100).toFixed(0)}%)`);
}

// ---- 3. It never refuses a route that exists ------------------------------
// The old avoid-set needed a fallback because it could block everything. A
// cost search cannot: the cheapest path still exists, it just runs through
// danger when danger is unavoidable.
{
  let reachable = 0, found = 0;
  for (let i = 0; i < 30; i++) {
    const { map, g } = world(i);
    const p = g.prisoners[0], e = map.exit;
    if (!costPath(map, p.x, p.y, e.x, e.y, null)) continue;
    reachable++;
    // Price EVERY tile as maximally dangerous — the case that used to make
    // the avoid-set collapse to "ignore risk entirely".
    if (costPath(map, p.x, p.y, e.x, e.y, () => 1000)) found++;
  }
  check(reachable > 20 && found === reachable,
    `a route is still found when everything is dangerous (${found}/${reachable})`);
}

// ---- 4. The behaviour claim: aversion changes what prisoners DO -----------
// The whole point. Measured as the share of turns ENDED standing on a lit,
// genuinely-watched tile — the tile the Watcher's scan actually tests.
{
  const diff = "hard";
  const orig = PRISONER_SKILL[diff].riskAversion;
  const measure = (aversion) => {
    PRISONER_SKILL[diff].riskAversion = aversion;
    let stood = 0, exposed = 0, rounds = 0, games = 0;
    for (let i = 0; i < 60; i++) {
      const { g } = world(i);
      const rng = mul(i + 1);
      let guard = 200;
      while (!isOver(g) && guard-- > 0) {
        const p = g.prisoners[g.activePrisoner];
        prisonerAITurn(g, rng, diff);
        if (p.alive && !p.escaped) {
          stood++;
          if (isLit(g, p.x, p.y) && inWatcherGaze(g, g.watcher.facing, p.x, p.y)) exposed++;
        }
        if (isOver(g)) break;
        endPrisonerTurn(g);
        if (isOver(g)) break;
        watcherScan(g, diff);
        endWatcherTurn(g);
      }
      rounds += g.round; games++;
    }
    return { exposed: (exposed / stood) * 100, rounds: rounds / games };
  };
  const reckless = measure(0);
  const careful = measure(9);
  PRISONER_SKILL[diff].riskAversion = orig;
  console.log(`    reckless(0): ${reckless.exposed.toFixed(1)}% turns ended exposed, ${reckless.rounds.toFixed(1)} rounds`);
  console.log(`    careful(9):  ${careful.exposed.toFixed(1)}% turns ended exposed, ${careful.rounds.toFixed(1)} rounds`);
  check(careful.exposed < reckless.exposed * 0.8,
    `caution measurably reduces time spent watched (${reckless.exposed.toFixed(1)}% -> ${careful.exposed.toFixed(1)}%)`);
  // And it must COST something, or it is not a trade and there is no
  // discipline to be had — a free safety is just a better move.
  check(careful.rounds > reckless.rounds,
    `and it costs tempo (${reckless.rounds.toFixed(1)} -> ${careful.rounds.toFixed(1)} rounds)`);
}

// ---- 5. The tiers are ordered ---------------------------------------------
{
  const a = PRISONER_SKILL.easy.riskAversion;
  const b = PRISONER_SKILL.medium.riskAversion;
  const c = PRISONER_SKILL.hard.riskAversion;
  check(a < b && b < c, `risk aversion rises with skill (${a} / ${b} / ${c})`);
}

console.log(ok ? "\n✓ risk-routing passed" : "\n✗ risk-routing failed");
process.exit(ok ? 0 : 1);
