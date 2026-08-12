// core-invariants.mjs — The old core, which nothing was actually testing.
//
// A mutation audit of the systems written earliest and touched least scored
// 5 survivors out of 16, against 1 out of 12 for the code written last week
// alongside its own tests. That gap is the finding: coverage tracks how
// recently something was written, not how important it is. Every check here
// exists because a deliberate defect in that area passed the entire suite.
//
// The five that survived:
//   * NOISE_TTL 2 -> 6      (the Watcher's only real intel, lasting 3x longer)
//   * FOV_RANGE 5 -> 2      (how far a Prisoner can see)
//   * light through walls   (the lamp line-of-sight trace deleted outright)
//   * doors cost no move    (a free action where one was priced)
//   * STALL_LIMIT disabled  (the T24 anti-stalemate guarantee, switched off)
//
// Written against LITERALS, not against the constants they check. An assertion
// like `ttl === NOISE_TTL` is the same value on both sides and holds for every
// possible value of it — that is exactly how the guard-capture-cost hole
// survived the first audit.
// Run: node game/tests/core-invariants.mjs
import { generateMap, MAP_DEFAULTS, TILE, OBJ } from "../src/map.js";
import {
  createGame, endPrisonerTurn, endWatcherTurn, watcherScan, isOver,
  addNoise, noiseAt, isLit, computeFoV, moveActivePrisoner,
  NOISE_TTL, FOV_RANGE, MP_PER_TURN, VIS, ROUND_LIMIT,
} from "../src/rules.js";
import { prisonerAITurn } from "../src/prisonerAI.js";

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}
function section(t) { console.log(`\n— ${t}`); }
function mul(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const map = generateMap(31337, { ...MAP_DEFAULTS, prisonerCount: 1 });
const build = () => createGame(map, { watcherFacing: 0, prisoners: map.spawns });

// ---- 1. Noise decays, and on a schedule ----------------------------------
// Noise is the Watcher's only intel besides light. Trebling how long it
// lingers changes every hunt in the game, and nothing noticed.
section("noise decays on a schedule");
{
  check(NOISE_TTL === 2, `a noise marker lasts exactly 2 Watcher turns (NOISE_TTL is ${NOISE_TTL})`);

  const g = build();
  const p = g.prisoners[0];
  addNoise(g, p.x, p.y, "test");
  check(noiseAt(g, p.x, p.y), "the sound is on the board the moment it is made");

  // Age it one Watcher turn at a time and record how many it survives.
  // endWatcherTurn decrements then filters `ttl > 0`, so NOISE_TTL 2 means:
  // visible on the turn it is made, visible through ONE further Watcher turn,
  // gone on the next. Counting the completed turns it survives gives 1.
  let survived = 0;
  for (let i = 0; i < 10; i++) {
    g.turn = "Prisoner";
    endPrisonerTurn(g);
    endWatcherTurn(g);
    if (!noiseAt(g, p.x, p.y)) break;
    survived++;
  }
  check(survived === 1,
    `it outlives exactly one further Watcher turn and is gone on the next (survived ${survived})`);
  check(survived < 3,
    "and it decays quickly — a marker that lingers makes the whole board permanent intel");
}

// ---- 2. A prisoner sees exactly as far as the rule says ------------------
// Halving the sight range passed the whole suite.
section("field of view reaches its stated range and stops");
{
  check(FOV_RANGE === 5, `cardinal sight is 5 tiles (FOV_RANGE is ${FOV_RANGE})`);

  // Carve a long clear corridor east of the prisoner so walls cannot be
  // mistaken for the range limit, and light it so visibility is not gated by
  // darkness instead.
  const g = build();
  const p = g.prisoners[0];
  const y = p.y;
  for (let x = p.x; x <= p.x + FOV_RANGE + 3 && x < map.size - 1; x++) {
    g.map.tiles[y][x] = TILE.FLOOR;
    g.map.objects[y][x] = OBJ.NONE;
  }
  g.map.lights.push({ x: p.x + 1, y, group: 999, radius: FOV_RANGE + 4 });
  g.lightState[999] = true;

  const vis = computeFoV(g, p);
  const at = (d) => vis.get(`${p.x + d},${y}`);
  const seen = (d) => at(d) !== undefined && at(d) !== VIS.DARK;
  check(seen(1), "sees the tile right in front of it");
  check(seen(5), "still sees at 5 tiles, the stated range");
  check(!seen(6), "and nothing at 6 — the range is a limit, not a suggestion");
  // The reverse failure: a range that collapsed to nothing.
  check(seen(3), "the middle of the corridor is visible too, so this is a range and not a lucky endpoint");
}

// ---- 3. Light does not pass through walls -------------------------------
// The lamp's line-of-sight trace could be deleted entirely and every test
// still passed. Light is half of the capture rule, so this is not cosmetic.
section("light is blocked by walls");
{
  const g = build();
  // Build a controlled row: lamp, floor, WALL, floor.
  const y = Math.max(2, Math.min(map.size - 3, g.prisoners[0].y));
  const x0 = Math.max(2, Math.min(map.size - 6, g.prisoners[0].x));
  for (let i = 0; i < 4; i++) {
    g.map.tiles[y][x0 + i] = TILE.FLOOR;
    g.map.objects[y][x0 + i] = OBJ.NONE;
  }
  g.map.tiles[y][x0 + 2] = TILE.WALL; // the blocker
  g.map.lights.push({ x: x0, y, group: 998, radius: 6 });
  g.lightState[998] = true;

  check(isLit(g, x0 + 1, y), "a tile with clear line to the lamp is lit");
  check(!isLit(g, x0 + 3, y),
    "a tile BEHIND a wall is not lit, even though it is well inside the lamp's radius");

  // ...and the radius still bites independently of the wall.
  const g2 = build();
  const yy = Math.max(2, Math.min(map.size - 3, g2.prisoners[0].y));
  const xx = Math.max(2, Math.min(map.size - 12, g2.prisoners[0].x));
  for (let i = 0; i < 10 && xx + i < map.size - 1; i++) {
    g2.map.tiles[yy][xx + i] = TILE.FLOOR;
    g2.map.objects[yy][xx + i] = OBJ.NONE;
  }
  g2.map.lights.push({ x: xx, y: yy, group: 997, radius: 3 });
  g2.lightState[997] = true;
  check(isLit(g2, xx + 3, yy), "a lamp lights out to its radius");
  check(!isLit(g2, xx + 5, yy), "and not beyond it, with clear line the whole way");

  // A switched-off group lights nothing at all.
  g2.lightState[997] = false;
  check(!isLit(g2, xx + 1, yy), "a dead circuit lights nothing");
}

// ---- 4. Opening a door costs the move it is supposed to cost -------------
section("a closed door costs a move point to open");
{
  const g = build();
  const p = g.prisoners[0];
  // Put a closed door directly north of the prisoner.
  const dx = p.x, dy = p.y - 1;
  g.map.tiles[dy][dx] = TILE.FLOOR;
  g.map.objects[dy][dx] = OBJ.DOOR;
  g.openedDoors.clear();
  g.turn = "Prisoner";
  p.mp = MP_PER_TURN;

  const before = { x: p.x, y: p.y, mp: p.mp };
  const r = moveActivePrisoner(g, 0);
  check(r.ok && r.event === "door-open", "walking into a closed door opens it");
  check(p.mp === MP_PER_TURN - 1, `and costs exactly 1 move point (${before.mp} -> ${p.mp})`);
  check(p.x === before.x && p.y === before.y, "without moving the prisoner through it");
  check(p.mp < before.mp, "a free door would make the whole move economy meaningless");
}

// ---- 5. The T24 anti-stalemate guarantee still holds ---------------------
// STALL_LIMIT could be set to 99999 — switching the guarantee off entirely —
// and nothing failed. Chased rather than papered over, and the answer was NOT
// missing coverage: it is dead code. Against a Watcher that never rotates
// (the T24 scenario, which only a human produces) 24/24 games resolve with
// the guard disabled, at every caution setting up to 0.99 / aversion 200.
// Removing the other guard — the `stepsThisTurn >= 1` clause — also resolves
// 24/24. The failure mode itself is gone: T24 predates `costPath`, which
// prices risk into the route instead of refusing routes outright, and a cost
// cannot deadlock the way a wall could.
//
// So this section deliberately does NOT pin STALL_LIMIT. Not every surviving
// mutation is a hole — some are redundant machinery, and writing a test to
// justify a constant that provably does nothing would be cargo cult. What it
// pins is the OUTCOME T24 exists for, which has to hold however it is
// achieved: a cautious prisoner facing a staring Watcher gets somewhere, and
// the game does not merely limp to the round cap.
section("a cautious prisoner cannot stall forever against a staring Watcher");
{
  let resolved = 0, timedOut = 0, worst = 0, stalledTurns = 0, totalTurns = 0;
  const GAMES = 24;
  for (let i = 0; i < GAMES; i++) {
    const m = generateMap((i * 2654435761) >>> 0 || 1, { ...MAP_DEFAULTS, prisonerCount: 1 });
    const g = createGame(m, { watcherFacing: i % 4, prisoners: m.spawns });
    const rng = mul(i + 1);
    // The Watcher never rotates and never bluffs: it just stares down one
    // wedge forever, which is the worst case for a prisoner that refuses to
    // cross watched ground.
    let guard = 400;
    while (!isOver(g) && guard-- > 0) {
      const p = g.prisoners[0];
      const from = { x: p.x, y: p.y };
      prisonerAITurn(g, rng, "hard");
      if (p.alive && !p.escaped && !p.custody) {
        totalTurns++;
        if (p.x === from.x && p.y === from.y) stalledTurns++;
      }
      if (isOver(g)) break;
      endPrisonerTurn(g);
      if (isOver(g)) break;
      watcherScan(g, "hard");
      endWatcherTurn(g);
    }
    if (isOver(g)) resolved++;
    if (g.timedOut) timedOut++;
    worst = Math.max(worst, g.round);
  }
  console.log(`    ${resolved}/${GAMES} resolved, ${timedOut} on the round limit, worst game ${worst} rounds`);
  console.log(`    ${stalledTurns}/${totalTurns} prisoner turns moved nothing at all`);
  check(resolved === GAMES, `every game against a staring Watcher resolves (${resolved}/${GAMES})`);
  // The real content of T24: it must resolve because the prisoner COMMITTED,
  // not because the round cap eventually swept it up. A run that only ends at
  // ROUND_LIMIT is the stalemate, just with a timer bolted on.
  check(timedOut === 0, `and none of them limps to the ${ROUND_LIMIT}-round cap (${timedOut})`);
  check(worst < ROUND_LIMIT / 2,
    `the worst case is comfortably short of the cap (${worst} < ${ROUND_LIMIT / 2})`);
  // Termination alone is not enough — a prisoner could in principle be swept
  // up by capture while never having moved. Fear must stay a cost it is
  // willing to pay, which shows up as the vast majority of turns making a
  // move even with the eye fixed on one wedge.
  check(totalTurns > 100, `enough turns sampled to say anything (${totalTurns})`);
  check(stalledTurns / totalTurns < 0.15,
    `and the prisoner keeps moving rather than freezing (${stalledTurns}/${totalTurns} turns stood still)`);
}

console.log(ok ? "\n✓ core-invariants passed" : "\n✗ core-invariants failed");
process.exit(ok ? 0 : 1);
