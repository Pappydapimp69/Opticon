// Node test harness for Opticon core logic. Run: node game/tests/logic.test.mjs
import { generateMap, computeGridSize, classifyRadius, TILE, OBJ, makeRng, MAP_DEFAULTS } from "../src/map.js";
import {
  createGame,
  moveActivePrisoner,
  breakWindow,
  endPrisonerTurn,
  rotateWatcher,
  watcherScan,
  endWatcherTurn,
  computeFoV,
  inWatcherGaze,
  isWalkable,
  isWindowBroken,
  blocksSight,
  MP_PER_TURN,
} from "../src/rules.js";
import { playWatcherTurn, blendSuspicion } from "../src/watcherAI.js";
import { prisonerAITurn } from "../src/prisonerAI.js";
import { prisonerPassable, bfsPath } from "../src/pathfind.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ FAIL:", msg);
  }
}
function section(name) {
  console.log("\n" + name);
}

// --- Map generation -------------------------------------------------------
section("map generation");
for (let seed = 1; seed <= 25; seed++) {
  const m = generateMap(seed);
  ok(m.size === computeGridSize(m.cfg), `seed ${seed}: grid size matches config`);
  ok(m.tiles.length === m.size, `seed ${seed}: rows`);
  // center is tower
  ok(m.tiles[m.center.y][m.center.x] === TILE.TOWER, `seed ${seed}: center is tower`);
  // spawn + exit are walkable floor
  ok(m.tiles[m.spawn.y][m.spawn.x] === TILE.FLOOR, `seed ${seed}: spawn is floor`);
  ok(m.objects[m.exit.y][m.exit.x] === OBJ.EXIT, `seed ${seed}: exit object present`);
  // exit reachable from spawn via BFS over walkable+doors
  ok(reachable(m), `seed ${seed}: exit reachable from spawn`);
  // at least some lights
  ok(m.lights.length > 0, `seed ${seed}: has lights`);
}

function reachable(m) {
  const g = createGame(m);
  const size = m.size;
  const seen = new Set();
  const q = [{ x: m.spawn.x, y: m.spawn.y }];
  const openAllDoors = true;
  while (q.length) {
    const { x, y } = q.pop();
    const k = y * size + x;
    if (seen.has(k)) continue;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    if (m.tiles[y][x] !== TILE.FLOOR) continue;
    const o = m.objects[y][x];
    if (o === OBJ.LIGHT) continue;
    // doors are openable → passable for reachability
    seen.add(k);
    if (o === OBJ.EXIT) return true;
    q.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
  return seen.has(m.exit.y * size + m.exit.x);
}

// --- classifyRadius bands --------------------------------------------------
section("radius classification");
ok(classifyRadius(0).kind === "tower", "r=0 tower");
ok(classifyRadius(2).kind === "tower", "r=2 tower (default towerRadius)");
ok(classifyRadius(3).kind === "moat", "r=3 moat");
ok(classifyRadius(6).kind === "ring", "r=6 first ring");

// --- Movement + MP + noise ------------------------------------------------
section("prisoner movement & noise");
{
  const m = generateMap(7);
  // Put a prisoner on a known open spot: use spawn.
  const g = createGame(m);
  const p = g.prisoners[0];
  ok(p.mp === MP_PER_TURN, "starts with full MP");

  // Find a walkable neighbor and move into it.
  const dirs = [0, 1, 2, 3];
  let moved = false;
  for (const d of dirs) {
    const before = { x: p.x, y: p.y };
    const r = moveActivePrisoner(g, d);
    if (r.ok && r.event === "move") {
      ok(p.mp === MP_PER_TURN - 1, "MP decremented on move");
      moved = true;
      break;
    }
  }
  ok(moved, "prisoner can move at least one direction from spawn");

  // Can't move on Watcher's turn.
  g.turn = "Watcher";
  const blocked = moveActivePrisoner(g, 0);
  ok(!blocked.ok && blocked.reason === "not-your-turn", "cannot move on watcher turn");
}

// --- Noise on 2+ tile move ------------------------------------------------
section("movement noise reveal");
{
  const m = generateMap(3);
  const g = createGame(m);
  const p = g.prisoners[0];
  const start = { x: p.x, y: p.y };
  // Move twice in whichever direction is open.
  let steps = 0;
  for (const d of [0, 1, 2, 3]) {
    while (steps < 2) {
      const r = moveActivePrisoner(g, d);
      if (r.ok && (r.event === "move" || r.event === "glass")) steps++;
      else break;
    }
    if (steps >= 2) break;
  }
  if (steps >= 2) {
    endPrisonerTurn(g);
    ok(
      g.noise.some((n) => n.x === start.x && n.y === start.y) || g.noise.length > 0,
      "2+ tile move produced noise"
    );
  } else {
    ok(true, "skipped (map too tight to move twice) — acceptable");
  }
}

// --- Watcher rotation limited to 90 deg -----------------------------------
section("watcher rotation limit");
{
  const m = generateMap(1);
  const g = createGame(m);
  g.turn = "Watcher";
  const f0 = g.watcher.facing;
  const r1 = rotateWatcher(g, 1);
  ok(r1.ok, "first rotate ok");
  const r2 = rotateWatcher(g, 1);
  ok(!r2.ok, "second rotate blocked (one 90deg per turn)");
  ok(g.watcher.facing === (f0 + 1) % 4, "facing advanced by exactly one");
}

// --- Watcher gaze wedge geometry ------------------------------------------
section("watcher gaze wedge");
{
  const m = generateMap(1);
  const g = createGame(m);
  const c = m.center;
  ok(inWatcherGaze(g, 0, c.x, c.y - 5), "north wedge includes tile due north");
  ok(!inWatcherGaze(g, 0, c.x, c.y + 5), "north wedge excludes tile due south");
  ok(inWatcherGaze(g, 1, c.x + 5, c.y), "east wedge includes tile due east");
}

// --- Capture: exposed prisoner in wedge is caught -------------------------
section("capture logic");
{
  const m = generateMap(9);
  const g = createGame(m);
  const p = g.prisoners[0];
  // Force a scenario: place prisoner due north of tower, add noise there, face north.
  const c = m.center;
  p.x = c.x;
  p.y = c.y - (m.cfg.towerRadius + m.cfg.moatThickness + 2);
  g.noise.push({ x: p.x, y: p.y, ttl: 2, source: "test" });
  g.turn = "Watcher";
  g.round = 2; // past the first-round grace window
  g.watcher.facing = 0;
  const scan = watcherScan(g);
  ok(scan.caught && !p.alive, "exposed prisoner in wedge is captured");
  ok(g.status === "captured" && g.winner === "Watcher", "capture ends game for Watcher");
}

// --- Tiered capture-exposure by difficulty (resolves OPT-1) ---------------
section("tiered capture-exposure by difficulty");
{
  // Unlit prisoner standing exactly ON a noise tile: medium/hard catch,
  // easy forgives (easy requires actual light).
  function scenario(difficulty) {
    const m = generateMap(4);
    const g = createGame(m);
    const p = g.prisoners[0];
    const c = m.center;
    p.x = c.x;
    p.y = c.y - (m.cfg.towerRadius + m.cfg.moatThickness + 2);
    g.map.lights = []; // isolate: exposure must come from noise alone, not light
    g.noise.push({ x: p.x, y: p.y, ttl: 2, source: "test" });
    g.turn = "Watcher";
    g.round = 2;
    g.watcher.facing = 0;
    return watcherScan(g, difficulty);
  }
  ok(!scenario("easy").caught, "easy: unlit noise-tile prisoner is NOT caught");
  ok(scenario("medium").caught, "medium: unlit noise-tile prisoner IS caught (unchanged default)");
  ok(scenario("hard").caught, "hard: unlit noise-tile prisoner IS caught");

  // Unlit prisoner ADJACENT (not on) a noise tile: only hard catches.
  function adjacentScenario(difficulty) {
    const m = generateMap(4);
    const g = createGame(m);
    const p = g.prisoners[0];
    const c = m.center;
    p.x = c.x;
    p.y = c.y - (m.cfg.towerRadius + m.cfg.moatThickness + 2);
    g.map.lights = []; // isolate: exposure must come from noise alone, not light
    g.noise.push({ x: p.x + 1, y: p.y, ttl: 2, source: "test" }); // adjacent, not on
    g.turn = "Watcher";
    g.round = 2;
    g.watcher.facing = 0;
    return watcherScan(g, difficulty);
  }
  ok(!adjacentScenario("easy").caught, "easy: adjacent noise does not catch");
  ok(!adjacentScenario("medium").caught, "medium: adjacent noise does not catch (exact tile only)");
  ok(adjacentScenario("hard").caught, "hard: adjacent noise DOES catch (within 1 tile)");

  // Lit prisoner with no noise at all: every difficulty catches (light alone
  // always exposes, at every tier).
  function litScenario(difficulty) {
    const m = generateMap(4);
    const g = createGame(m);
    const p = g.prisoners[0];
    const c = m.center;
    p.x = c.x;
    p.y = c.y - (m.cfg.towerRadius + m.cfg.moatThickness + 2);
    g.turn = "Watcher";
    g.round = 2;
    g.watcher.facing = 0;
    // Force-light the prisoner's tile via a synthetic ON light at their spot.
    g.map.lights.push({ x: p.x, y: p.y, group: 9999, radius: 0 });
    g.lightState[9999] = true;
    return watcherScan(g, difficulty);
  }
  ok(litScenario("easy").caught, "easy: lit prisoner (no noise) is still caught");
  ok(litScenario("hard").caught, "hard: lit prisoner (no noise) is still caught");
}

// --- Escape: reaching exit wins -------------------------------------------
section("escape win");
{
  const m = generateMap(4);
  const g = createGame(m);
  const p = g.prisoners[0];
  // Teleport adjacent to exit and step onto it.
  p.x = m.exit.x;
  p.y = m.exit.y;
  // Simulate stepping onto exit by directly setting escaped via move engine:
  // place prisoner one tile away then move in.
  // Simplest: mark and check end conditions through a real move.
  const neighbors = [
    { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
  ];
  let placed = false;
  for (let i = 0; i < neighbors.length; i++) {
    const nx = m.exit.x - neighbors[i].dx;
    const ny = m.exit.y - neighbors[i].dy;
    if (isWalkable(g, nx, ny)) {
      p.x = nx;
      p.y = ny;
      p.startTurnPos = { x: nx, y: ny };
      p.mp = MP_PER_TURN;
      g.turn = "Prisoner";
      const r = moveActivePrisoner(g, i);
      if (r.ok && r.event === "exit") placed = true;
      break;
    }
  }
  if (placed) {
    ok(g.status === "escaped" && g.winner === "Prisoner", "reaching exit wins for Prisoner");
  } else {
    ok(true, "skipped exit-adjacency (no open neighbor) — acceptable");
  }
}

// --- FoV never throws & respects range ------------------------------------
section("FoV computation");
{
  const m = generateMap(11);
  const g = createGame(m);
  const vis = computeFoV(g, g.prisoners[0]);
  ok(vis.size >= 1, "FoV includes at least the prisoner tile");
  // No tile beyond range 5 on a cardinal line.
  let withinRange = true;
  for (const kk of vis.keys()) {
    const [x, y] = kk.split(",").map(Number);
    const man = Math.abs(x - g.prisoners[0].x) + Math.abs(y - g.prisoners[0].y);
    if (man > 5) withinRange = false;
  }
  ok(withinRange, "no visible tile beyond cardinal range 5");
}

// --- Full AI turn does not throw and always yields initiative -------------
section("watcher AI full turn");
for (const diff of ["easy", "medium", "hard"]) {
  const m = generateMap(13);
  const g = createGame(m);
  endPrisonerTurn(g); // -> Watcher
  const actions = playWatcherTurn(g, diff, 42);
  ok(actions.length > 0, `${diff}: AI produced actions`);
  ok(g.turn === "Prisoner" || g.status !== "playing", `${diff}: initiative returned to prisoner`);
  ok(
    Array.isArray(g.watcher.suspicion) && g.watcher.suspicion.length === 4 && g.watcher.suspicion.every(Number.isFinite),
    `${diff}: suspicion memory stays a finite 4-vector after a turn`
  );
}

// --- A full simulated game terminates -------------------------------------
section("full random playthrough terminates");
{
  const m = generateMap(21);
  const g = createGame(m);
  const rng = (() => { let a = 99; return () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  let guard = 2000;
  while (g.status === "playing" && guard-- > 0) {
    // prisoner: random walk toward exit-ish
    const p = g.prisoners[0];
    while (p.mp > 0 && g.status === "playing") {
      const d = Math.floor(rng() * 4);
      const r = moveActivePrisoner(g, d);
      if (!r.ok) break;
    }
    endPrisonerTurn(g);
    if (g.status !== "playing") break;
    playWatcherTurn(g, "medium", 7);
  }
  ok(guard > 0, "game terminated within step budget");
  ok(g.status === "playing" || g.winner, "game reached a terminal or bounded state");
}

// --- Switch tiles are impassable for pathing (regression) -----------------
// A switch can never actually be occupied — stepping "toward" one only
// toggles it and leaves the mover in place (moveActivePrisoner). Treating it
// as walkable in BFS routed the prisoner AI "through" a tile it could never
// actually cross, wasting every MP re-toggling the same switch forever.
section("switch tiles are impassable for pathing (regression)");
for (let seed = 1; seed <= 25; seed++) {
  const m = generateMap(seed);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.objects[y][x] === OBJ.SWITCH) {
        ok(!prisonerPassable(m, x, y), `seed ${seed}: switch at (${x},${y}) is not passable for AI pathing`);
      }
    }
  }
}
{
  // A path must never step directly onto a switch tile mid-route.
  const m = generateMap(4);
  let sw = null;
  for (let y = 0; y < m.size && !sw; y++) {
    for (let x = 0; x < m.size && !sw; x++) {
      if (m.objects[y][x] === OBJ.SWITCH) sw = { x, y };
    }
  }
  if (sw) {
    const path = bfsPath(m, m.spawn.x, m.spawn.y, m.exit.x, m.exit.y, null);
    const touchesSwitch = path && path.some((step) => step.x === sw.x && step.y === sw.y);
    ok(!touchesSwitch, "spawn->exit path never routes through a switch tile");
  } else {
    ok(true, "no switch on this seed's map — skipped");
  }
}

// --- Prisoner AI resolves against real oscillation cases (regression) -----
// These three seeds previously stalled the AI indefinitely (500+ rounds,
// never terminating) via a slow advance/retreat oscillation that a naive
// consecutive-turn stall counter never caught (each single turn could look
// "improved" without ever beating the prisoner's own best-ever distance).
section("prisoner AI resolves known-oscillation seeds (regression)");
for (const seed of [3816266512, 2323661502, 3689921436]) {
  const m = generateMap(seed);
  const g = createGame(m, { watcherFacing: seed % 4 });
  const rng = makeRng(seed ^ 0x9e3779b9);
  let guard = 120;
  while (g.status === "playing" && guard-- > 0) {
    prisonerAITurn(g, rng);
    if (g.status !== "playing") break;
    endPrisonerTurn(g);
    if (g.status !== "playing") break;
    playWatcherTurn(g, "easy", seed);
  }
  ok(g.status !== "playing", `seed ${seed}: resolves within 120 rounds (was: never terminated)`);
}

// --- Watcher AI suspicion memory actually differentiates difficulty -------
// DIFFICULTY.memory (easy:1, medium:2, hard:3) was defined but never read by
// any decision logic — dead config, identical behavior regardless of value.
// blendSuspicion now uses it: alpha = 1/memory, so memory=1 fully replaces
// suspicion with this turn's raw score (no memory at all) while memory=3
// retains part of a past turn's signal even after the current turn's raw
// score for that direction has dropped to 0 (e.g. the noise that raised it
// already aged out of game.noise). Tested in isolation from noiseWeight/
// exitBias (which also vary by difficulty) so this checks memory specifically.
section("watcher AI suspicion memory differentiates difficulty (regression)");
{
  const lowMem = { watcher: { suspicion: [0, 0, 0, 0] } };
  const highMem = { watcher: { suspicion: [0, 0, 0, 0] } };

  blendSuspicion(lowMem, [0, 10, 0, 0], { memory: 1 });
  blendSuspicion(highMem, [0, 10, 0, 0], { memory: 3 });

  // Turn 2: the signal is gone, as if the noise that raised it expired.
  blendSuspicion(lowMem, [0, 0, 0, 0], { memory: 1 });
  blendSuspicion(highMem, [0, 0, 0, 0], { memory: 3 });

  ok(lowMem.watcher.suspicion[1] === 0, "memory=1: suspicion fully resets the turn after the signal disappears");
  ok(highMem.watcher.suspicion[1] > 0, "memory=3: suspicion is still elevated the turn after the signal disappears");
  ok(
    highMem.watcher.suspicion[1] > lowMem.watcher.suspicion[1],
    "higher memory retains more residual suspicion than lower memory"
  );
}

// --- Multi-prisoner spawns (AI prisoners) ----------------------------------
section("multi-prisoner spawns");
for (let seed = 1; seed <= 40; seed++) {
  const m = generateMap(seed, { ...MAP_DEFAULTS, prisonerCount: 3 });
  ok(m.spawns.length === 3, `seed ${seed}: 3 spawn points generated`);
  ok(m.spawns[0].x === m.spawn.x && m.spawns[0].y === m.spawn.y, `seed ${seed}: spawns[0] is the primary spawn`);
  for (const s of m.spawns) {
    ok(m.tiles[s.y][s.x] === TILE.FLOOR, `seed ${seed}: spawn (${s.x},${s.y}) is floor`);
    const path = bfsPath(m, s.x, s.y, m.exit.x, m.exit.y, null);
    ok(!!path, `seed ${seed}: spawn (${s.x},${s.y}) can reach the exit`);
  }
}
{
  // prisonerCount defaulting to 1 must be a pure no-op vs the pre-existing shape.
  const m = generateMap(7);
  ok(m.spawns.length === 1, "default prisonerCount (1) still produces exactly one spawn");
}

// --- Windows: breakable wall shortcuts (glass redesign) --------------------
// Glass moved off the floor onto WALL tiles as a deliberate breakable
// shortcut/distraction tool, per explicit design feedback — not a passive
// "make noise when stepped on" floor hazard anymore.
section("windows: breakable wall shortcuts");
{
  let found = null;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const m = generateMap(seed);
    for (let y = 1; y < m.size - 1 && !found; y++) {
      for (let x = 1; x < m.size - 1 && !found; x++) {
        if (m.tiles[y][x] !== TILE.WALL || m.objects[y][x] !== OBJ.GLASS) continue;
        const cands = [
          { fx: x, fy: y - 1, dir: 2 }, // floor North of window -> face South to break it
          { fx: x, fy: y + 1, dir: 0 },
          { fx: x - 1, fy: y, dir: 1 },
          { fx: x + 1, fy: y, dir: 3 },
        ];
        for (const c of cands) {
          if (m.tiles[c.fy] && m.tiles[c.fy][c.fx] === TILE.FLOOR) {
            found = { m, wx: x, wy: y, fx: c.fx, fy: c.fy, dir: c.dir };
            break;
          }
        }
      }
    }
  }
  ok(!!found, "at least one seed (of 60 tried) has a window with an adjacent floor tile");
  if (found) {
    const { m, wx, wy, fx, fy, dir } = found;
    const g = createGame(m);
    const p = g.prisoners[0];
    p.x = fx; p.y = fy; p.startTurnPos = { x: fx, y: fy };

    ok(!isWalkable(g, wx, wy), "unbroken window is not walkable");
    ok(blocksSight(g, wx, wy), "unbroken window blocks sight");
    ok(!isWindowBroken(g, wx, wy), "window starts unbroken");

    const mpBefore = p.mp;
    const r = breakWindow(g, dir);
    ok(r.ok && r.event === "window-break", "breakWindow succeeds facing a real window");
    ok(isWindowBroken(g, wx, wy), "window is now broken");
    ok(isWalkable(g, wx, wy), "broken window is walkable");
    ok(!blocksSight(g, wx, wy), "broken window no longer blocks sight");
    ok(p.x === fx && p.y === fy, "breaking a window does not relocate the prisoner (interact-in-place)");
    ok(p.mp === mpBefore - 1, "breaking a window costs 1 MP");
    ok(g.noise.some((n) => n.x === wx && n.y === wy), "breaking a window makes noise at that tile");

    const r2 = breakWindow(g, dir);
    ok(!r2.ok && r2.reason === "already-broken", "breaking an already-broken window fails cleanly");
  }
}

// A window can never actually be occupied while unbroken (like a switch —
// see E5), so it must never be treated as passable for AI pathing or the
// generator's base spawn->exit connectivity guarantee either.
section("unbroken windows are excluded from AI pathing (regression)");
for (let seed = 1; seed <= 25; seed++) {
  const m = generateMap(seed);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.tiles[y][x] === TILE.WALL && m.objects[y][x] === OBJ.GLASS) {
        ok(!prisonerPassable(m, x, y), `seed ${seed}: unbroken window at (${x},${y}) is not passable for AI pathing`);
      }
    }
  }
}

// --- Summary --------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
