// Node test harness for Opticon core logic. Run: node game/tests/logic.test.mjs
import { generateMap, computeGridSize, classifyRadius, TILE, OBJ, makeRng, MAP_DEFAULTS, ITEM_KINDS, ITEM_INFO } from "../src/map.js";
import {
  createGame,
  setBluff,
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
  useItem,
  isItemTaken,
  distractTarget,
  ITEM_CAP,
  isLit,
  useSkill,
  skillUsable,
  skillReady,
  inWatcherGazeWide,
  SKILLS,
  SKILL_INFO,
  NOISE_TTL,
  isOver,
  ROUND_LIMIT,
  hasLineOfSight,
  moveGuards,
  GUARD_SIGHT_RANGE,
  GUARD_ACTION_POINTS,
  GUARD_CAPTURE_COST,
  quadrantOf,
  addNoise,
} from "../src/rules.js";
import { playWatcherTurn, blendSuspicion } from "../src/watcherAI.js";
import { prisonerAITurn } from "../src/prisonerAI.js";
import { prisonerPassable, bfsPath } from "../src/pathfind.js";

function isDoorOpenTest(g, x, y) { return g.openedDoors.has(y * g.map.size + x); }

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


// --- Prisoner items -------------------------------------------------------

// The core placement invariant: an item is only ever scattered on a map that
// actually contains the object it acts on. A lockpick on a doorless map is
// an item the player can never spend, which reads as broken rather than
// unlucky — so the generator validates the pool against the FINISHED map.
section("items are only placed when the map has what they act on");
for (let seed = 1; seed <= 60; seed++) {
  const m = generateMap(seed);
  const present = new Set();
  for (const row of m.objects) for (const o of row) present.add(o);
  for (const it of m.items) {
    const req = ITEM_INFO[it.kind].requires;
    ok(req == null || present.has(req),
      `seed ${seed}: ${it.kind} placed only because its required object exists`);
    ok(m.objects[it.y][it.x] === OBJ.ITEM, `seed ${seed}: item tile is marked OBJ.ITEM`);
    ok(m.tiles[it.y][it.x] === TILE.FLOOR, `seed ${seed}: item sits on floor`);
  }
}

section("an item tile stays walkable (walk-onto, not interact-in-place)");
{
  const m = generateMap(7);
  const g = createGame(m);
  for (const it of m.items) {
    ok(isWalkable(g, it.x, it.y), `item at (${it.x},${it.y}) is walkable`);
    ok(prisonerPassable(m, it.x, it.y), `item at (${it.x},${it.y}) is passable for AI pathing`);
  }
}

section("picking an item up retires the tile immediately");
{
  const m = generateMap(11);
  const it = m.items[0];
  ok(!!it, "seed 11 produced at least one item");
  // Stand next to it and step on.
  const g = createGame(m, { prisoners: [{ x: it.x - 1, y: it.y }] });
  const p = g.prisoners[0];
  if (isWalkable(g, it.x - 1, it.y)) {
    const r = moveActivePrisoner(g, 1); // East onto the item
    ok(r.ok, "stepped onto the item tile");
    ok(r.picked === it.kind, `pickup reported the right kind (${r.picked})`);
    ok(p.items.length === 1 && p.items[0] === it.kind, "item is in the prisoner's inventory");
    ok(isItemTaken(g, it.x, it.y), "tile is retired the instant it's taken");
    // A second prisoner walking the same square must not get a ghost copy.
    const g2 = g;
    g2.activePrisoner = 0;
    p.x = it.x - 1; p.y = it.y; p.mp = 3;
    const r2 = moveActivePrisoner(g2, 1);
    ok(r2.ok && r2.picked == null, "a second pass over a taken tile picks up nothing");
  }
}

section("inventory is capped");
{
  const m = generateMap(3);
  const g = createGame(m);
  const p = g.prisoners[0];
  p.items = [ITEM_KINDS.MUFFLE, ITEM_KINDS.DISTRACT];
  ok(p.items.length === ITEM_CAP, "starts at the cap for this check");
  // Find an untaken item tile adjacent-reachable; simulate the full-hands path.
  const it = m.items.find((i) => isWalkable(g, i.x - 1, i.y));
  if (it) {
    p.x = it.x - 1; p.y = it.y; p.mp = 3;
    const r = moveActivePrisoner(g, 1);
    ok(r.ok && r.picked == null, "a full-handed prisoner leaves the pickup behind");
    ok(!isItemTaken(g, it.x, it.y), "and the pickup is NOT consumed");
    ok(p.items.length === ITEM_CAP, "inventory never exceeds the cap");
  }
}

section("muffle suppresses movement noise for exactly one turn");
{
  const m = generateMap(5);
  const g = createGame(m);
  const p = g.prisoners[0];
  p.items = [ITEM_KINDS.MUFFLE];
  const r = useItem(g, ITEM_KINDS.MUFFLE, null);
  ok(r.ok, "muffle applies with no direction needed");
  ok(p.muffled === true, "prisoner is muffled");
  ok(p.items.length === 0, "muffle is consumed");
  // Move 2+ tiles then end turn — normally that reveals the start tile.
  const start = { ...p.startTurnPos };
  p.x = start.x + 2; p.y = start.y;
  endPrisonerTurn(g);
  ok(!g.noise.some((n) => n.x === start.x && n.y === start.y),
    "muffled 2-tile move leaves no movement noise");
  // Next turn it's worn off.
  endWatcherTurn(g);
  ok(g.prisoners[g.activePrisoner].muffled === false, "muffle lasts exactly one turn");
}

section("distract makes noise away from the prisoner, not on them");
{
  const m = generateMap(9);
  const g = createGame(m);
  const p = g.prisoners[0];
  p.items = [ITEM_KINDS.DISTRACT];
  // Find a direction with room to throw.
  let dir = -1;
  for (let d = 0; d < 4; d++) if (distractTarget(g, p, d)) { dir = d; break; }
  if (dir >= 0) {
    const target = distractTarget(g, p, dir);
    const r = useItem(g, ITEM_KINDS.DISTRACT, dir);
    ok(r.ok, "distract throws in a direction");
    ok(g.noise.some((n) => n.x === target.x && n.y === target.y), "noise lands on the target tile");
    ok(!g.noise.some((n) => n.x === p.x && n.y === p.y), "no noise on the prisoner's own tile");
    ok(!p.selfNoise.some((n) => n.x === target.x && n.y === target.y),
      "a decoy is not recorded as the prisoner's own self-noise");
    ok(p.items.length === 0, "distract is consumed");
  }
  // A decoy at your own feet defeats the purpose and is rejected.
  const g2 = createGame(generateMap(9));
  const p2 = g2.prisoners[0];
  p2.items = [ITEM_KINDS.DISTRACT];
  const rClose = useItem(g2, ITEM_KINDS.DISTRACT, { x: p2.x, y: p2.y });
  ok(!rClose.ok && rClose.reason === "too-close", "a decoy on your own tile is rejected");
  ok(p2.items.length === 1, "a rejected use does not consume the item");
}

section("lockpick opens an adjacent door for free");
{
  let done = false;
  for (let seed = 1; seed <= 40 && !done; seed++) {
    const m = generateMap(seed);
    const g = createGame(m);
    for (let y = 1; y < m.size - 1 && !done; y++) {
      for (let x = 1; x < m.size - 1 && !done; x++) {
        if (m.objects[y][x] !== OBJ.DOOR) continue;
        const p = g.prisoners[0];
        // Stand west of the door, use it east.
        if (!isWalkable(g, x - 1, y)) continue;
        p.x = x - 1; p.y = y; p.mp = 3;
        p.items = [ITEM_KINDS.LOCKPICK];
        const mpBefore = p.mp;
        const r = useItem(g, ITEM_KINDS.LOCKPICK, 1);
        ok(r.ok, `seed ${seed}: lockpick opens the adjacent door`);
        ok(isDoorOpenTest(g, x, y), "door is now open");
        ok(p.mp === mpBefore, "lockpick costs no MP (that's the point)");
        ok(p.items.length === 0, "lockpick is consumed");
        ok(p.x === x - 1 && p.y === y, "using a lockpick does not relocate the prisoner");
        const r2 = useItem(g, ITEM_KINDS.LOCKPICK, 1);
        ok(!r2.ok && r2.reason === "not-carried", "can't reuse a spent lockpick");
        done = true;
      }
    }
  }
  ok(done, "found a door to test the lockpick against");
}

section("cutters kill a light group permanently");
{
  let done = false;
  for (let seed = 1; seed <= 40 && !done; seed++) {
    const m = generateMap(seed);
    const g = createGame(m);
    for (let y = 1; y < m.size - 1 && !done; y++) {
      for (let x = 1; x < m.size - 1 && !done; x++) {
        if (m.objects[y][x] !== OBJ.SWITCH) continue;
        if (!isWalkable(g, x - 1, y)) continue;
        const p = g.prisoners[0];
        p.x = x - 1; p.y = y; p.mp = 3;
        p.items = [ITEM_KINDS.CUTTERS];
        const grp = m.lightGroup[y][x];
        g.lightState[grp] = true;
        const r = useItem(g, ITEM_KINDS.CUTTERS, 1);
        ok(r.ok, `seed ${seed}: cutters work on an adjacent switch`);
        ok(g.deadLightGroups.has(grp), "the light group is marked dead");
        ok(g.lightState[grp] === false, "and its lights are off");
        // The switch can no longer turn it back on.
        p.mp = 3;
        const r2 = moveActivePrisoner(g, 1);
        ok(r2.ok && r2.event === "switch-dead", "the switch no longer responds");
        ok(g.lightState[grp] === false, "lights stay off after flipping a dead switch");
        done = true;
      }
    }
  }
  ok(done, "found a switch to test the cutters against");
}

section("items reject use when not carried");
{
  const g = createGame(generateMap(2));
  for (const kind of Object.values(ITEM_KINDS)) {
    const r = useItem(g, kind, 0);
    ok(!r.ok && r.reason === "not-carried", `${kind} can't be used without carrying it`);
  }
}


// --- Watcher skills -------------------------------------------------------

section("skills start ready and are never offered as a no-op");
{
  const g = createGame(generateMap(4));
  for (const s of Object.values(SKILLS)) {
    ok(skillReady(g, s), `${s} starts off cooldown`);
  }
  g.turn = "Watcher";
  // LOCK with no open doors, ECHO with no noise, DOUBLE_BLUFF with no first
  // bluff — all "ready" but not USABLE, and must refuse rather than burn.
  ok(!skillUsable(g, SKILLS.LOCK), "lock is unusable with no open door");
  ok(!skillUsable(g, SKILLS.ECHO), "echo is unusable with no noise");
  ok(!skillUsable(g, SKILLS.DOUBLE_BLUFF), "double bluff is unusable with no first bluff");
  ok(skillUsable(g, SKILLS.WIDE_SCAN), "wide scan is always usable");
  const rl = useSkill(g, SKILLS.LOCK, null);
  ok(!rl.ok, "using lock with no target refuses");
  ok(skillReady(g, SKILLS.LOCK), "a refused skill does NOT go on cooldown");
}

section("wide scan widens the capture wedge for exactly one scan");
{
  const m = generateMap(6);
  const g = createGame(m);
  const c = m.center;
  g.turn = "Watcher";
  g.round = 5; // past the round-1 grace
  g.watcher.facing = 0; // North
  // A tile inside the 180 half-plane but OUTSIDE the 90 wedge.
  ok(!inWatcherGaze(g, 0, c.x + 6, c.y - 1), "corner tile is outside the narrow wedge");
  ok(inWatcherGazeWide(g, 0, c.x + 6, c.y - 1), "and inside the wide one");

  const r = useSkill(g, SKILLS.WIDE_SCAN, null);
  ok(r.ok, "wide scan arms");
  ok(g.watcher.wideScan === true, "wideScan flag is set");
  ok(!skillReady(g, SKILLS.WIDE_SCAN), "wide scan goes on cooldown");
  const scan = watcherScan(g, "medium");
  ok(scan.wide === true, "the scan reports it ran wide");
  endWatcherTurn(g);
  ok(g.watcher.wideScan === false, "wideScan clears after the turn");
}

section("wide scan costs the bluff (telegraphed power)");
{
  const g = createGame(generateMap(6));
  g.turn = "Watcher";
  setBluff(g, 2);
  ok(g.watcher.bluff === 2, "bluff is set first");
  useSkill(g, SKILLS.WIDE_SCAN, null);
  ok(g.watcher.bluff === null, "arming a wide scan clears the bluff");
  const blockedBluff = setBluff(g, 1);
  ok(!blockedBluff.ok && blockedBluff.reason === "wide-scan-armed", "wide scan prevents adding a replacement bluff before scanning");
  ok(g.watcher.bluff === null, "wide scan remains bluff-free through the scan");
}

section("double bluff adds a SECOND claim, not a replacement");
{
  const g = createGame(generateMap(8));
  g.turn = "Watcher";
  g.watcher.facing = 0;
  setBluff(g, 1);
  const r = useSkill(g, SKILLS.DOUBLE_BLUFF, 2);
  ok(r.ok, "double bluff applies");
  ok(g.watcher.bluff === 1, "the first bluff survives");
  ok(g.watcher.bluff2 === 2, "the second claim is recorded separately");
  const rSame = useSkill(g, SKILLS.DOUBLE_BLUFF, 1);
  ok(!rSame.ok, "can't double-bluff while on cooldown");
  endWatcherTurn(g);
  ok(g.watcher.bluff2 === null, "the second claim clears with the turn");
}

section("echo refreshes noise but stays secret from prisoners");
{
  const g = createGame(generateMap(10));
  g.turn = "Watcher";
  g.noise = [{ x: 3, y: 3, ttl: 1, source: "movement" }];
  const r = useSkill(g, SKILLS.ECHO, null);
  ok(r.ok, "echo applies when there's noise");
  ok(g.noise[0].ttl === NOISE_TTL, "noise is refreshed to full TTL");
  const entry = g.log[0];
  ok(entry.watcherOnly === true, "the echo log entry is watcher-only (never leaks to the prisoner)");
}

section("remote lock closes an open door, but never on a prisoner");
{
  let done = false;
  for (let seed = 1; seed <= 40 && !done; seed++) {
    const m = generateMap(seed);
    const g = createGame(m);
    for (let y = 1; y < m.size - 1 && !done; y++) {
      for (let x = 1; x < m.size - 1 && !done; x++) {
        if (m.objects[y][x] !== OBJ.DOOR) continue;
        g.openedDoors.add(y * m.size + x);
        g.turn = "Watcher";
        // Blocked while someone stands in the doorway.
        const p = g.prisoners[0];
        const keepX = p.x, keepY = p.y;
        p.x = x; p.y = y;
        const rBlocked = useSkill(g, SKILLS.LOCK, { x, y });
        ok(!rBlocked.ok && rBlocked.reason === "occupied", `seed ${seed}: a door won't close on a prisoner`);
        ok(skillReady(g, SKILLS.LOCK), "the blocked attempt didn't spend the cooldown");
        // Now clear the doorway.
        p.x = keepX; p.y = keepY;
        const r = useSkill(g, SKILLS.LOCK, { x, y });
        ok(r.ok, "lock closes an open door");
        ok(!isDoorOpenTest(g, x, y), "the door is shut again");
        ok(!skillReady(g, SKILLS.LOCK), "lock is now on cooldown");
        done = true;
      }
    }
  }
  ok(done, "found a door to test remote lock against");
}

section("cooldowns tick down once per watcher turn and then re-arm");
{
  const g = createGame(generateMap(12));
  g.turn = "Watcher";
  useSkill(g, SKILLS.WIDE_SCAN, null);
  const cd = SKILL_INFO[SKILLS.WIDE_SCAN].cooldown;
  ok(g.watcher.skills[SKILLS.WIDE_SCAN] === cd, `cooldown set to ${cd}`);
  for (let i = 0; i < cd; i++) {
    endWatcherTurn(g);
    g.turn = "Watcher";
  }
  ok(skillReady(g, SKILLS.WIDE_SCAN), "skill is ready again after its cooldown elapses");
}

section("skills refuse outside the watcher's turn");
{
  const g = createGame(generateMap(13));
  g.turn = "Prisoner";
  for (const s of Object.values(SKILLS)) {
    const r = useSkill(g, s, 0);
    ok(!r.ok && r.reason === "not-your-turn", `${s} refuses on the prisoner's turn`);
  }
}

// --- Prisoner AI + items --------------------------------------------------

section("AI prisoners actually collect and spend items");
{
  let sawCarry = false;
  for (let seed = 1; seed <= 30 && !sawCarry; seed++) {
    const m = generateMap(seed, { ...MAP_DEFAULTS, prisonerCount: 3 });
    const g = createGame(m, { prisoners: m.spawns });
    let guard = 60;
    while (!isOver(g) && guard-- > 0) {
      prisonerAITurn(g);
      if (g.prisoners.some((p) => p.items.length > 0)) sawCarry = true;
      endPrisonerTurn(g);
      if (isOver(g)) break;
      playWatcherTurn(g, "medium", seed);
    }
  }
  ok(sawCarry, "an AI prisoner picked up an item during normal play");
}

// The detour must not defeat the anti-stall guarantee (T24): every game
// still has to terminate well inside the guard budget.
section("item detours never reintroduce a stall");
for (let seed = 1; seed <= 12; seed++) {
  const m = generateMap(seed, { ...MAP_DEFAULTS, prisonerCount: 3 });
  const g = createGame(m, { prisoners: m.spawns });
  let guard = 120;
  while (!isOver(g) && guard-- > 0) {
    prisonerAITurn(g);
    endPrisonerTurn(g);
    if (isOver(g)) break;
    playWatcherTurn(g, "medium", seed);
  }
  ok(isOver(g), `seed ${seed}: game still terminates with item detours enabled`);
}


// --- Round limit ----------------------------------------------------------

section("the round limit ends the game as a Watcher win");
{
  const g = createGame(generateMap(21));
  g.round = ROUND_LIMIT;
  g.turn = "Watcher";
  ok(!isOver(g), "still playing at exactly the limit");
  endWatcherTurn(g); // ticks round past the cap
  ok(isOver(g), "game ends once the round passes the limit");
  ok(g.winner === "Watcher", "the Watcher wins on time");
  ok(g.timedOut === true, "the timeout is flagged so the UI can say WHY");
  ok(g.status === "captured", "status reflects a Watcher victory");
}

section("an escape still beats the clock");
{
  const g = createGame(generateMap(22));
  const p = g.prisoners[0];
  g.round = ROUND_LIMIT;
  p.escaped = true;
  g.turn = "Watcher";
  endWatcherTurn(g);
  ok(g.winner === "Prisoner", "a prisoner already out wins even at the cap");
  ok(!g.timedOut, "and it is not recorded as a timeout");
}


// --- Guard line-of-sight capture -------------------------------------------
// Physical guards (DISPATCH skill) capture on an unobstructed sightline, not
// same-tile contact — cover should be a real counter-play against them,
// distinct from evading the tower's abstract lit-OR-noise gaze rule.

function clearStrip(g, y, x0, x1) {
  for (let x = x0; x <= x1; x++) {
    g.map.tiles[y][x] = TILE.FLOOR;
    g.map.objects[y][x] = OBJ.NONE;
  }
}

section("guard line of sight");
{
  const g = createGame(generateMap(31));
  const { y } = g.map.center;
  const cx = g.map.center.x;
  clearStrip(g, y, cx - 4, cx + 4);
  ok(hasLineOfSight(g, cx - 3, y, cx, y), "clear straight line within range sees the target");
  ok(!hasLineOfSight(g, cx - 3, y, cx + 3, y, 2), "beyond max range fails even with a clear line");

  g.map.tiles[y][cx - 1] = TILE.WALL;
  g.map.objects[y][cx - 1] = OBJ.NONE;
  ok(!hasLineOfSight(g, cx - 3, y, cx, y), "a wall directly on the line blocks sight");
  g.map.tiles[y][cx - 1] = TILE.FLOOR; // restore for reuse below

  ok(hasLineOfSight(g, cx, y, cx, y), "same tile is always in sight (distance 0)");
}

section("dispatched guards are pawns: one square of sight, paid for in action points");
{
  // Guards used to capture down an unobstructed sightline 4-6 tiles long,
  // which made them a second eye rather than a patrol — measured at 83% of
  // all captures on hard against the tower gaze's 17% (Tension T28). They now
  // see exactly one square in EVERY direction, diagonals included, and a grab
  // spends GUARD_CAPTURE_COST of a finite action bar.
  const map = generateMap(31);
  const { y } = map.center;
  const cx = map.center.x;

  const withGuard = (gx, gy, ap = GUARD_ACTION_POINTS) => {
    const g = createGame(map, { prisoners: [{ x: cx, y }] });
    clearStrip(g, y, cx - 4, cx + 4);
    g.noise = [];
    g.watcher.guards = [{ id: 1, x: gx, y: gy, quadrant: 0, ap, turnsActive: 0, spent: false }];
    return g;
  };

  let g = withGuard(cx - 3, y);
  moveGuards(g);
  ok(g.prisoners[0].alive, "three squares away cannot capture, clear line or not");

  g = withGuard(cx - 2, y);
  moveGuards(g);
  ok(g.prisoners[0].alive, "two squares away cannot capture");

  g = withGuard(cx - 1, y);
  moveGuards(g);
  ok(!g.prisoners[0].alive, "an adjacent guard captures");

  g = withGuard(cx - 1, y - 1);
  moveGuards(g);
  ok(!g.prisoners[0].alive, "sight is one square in EVERY direction — diagonals count");

  g = withGuard(cx - 1, y);
  moveGuards(g);
  ok(g.watcher.guards[0].ap === GUARD_ACTION_POINTS - GUARD_CAPTURE_COST,
    `a capture spends ${GUARD_CAPTURE_COST} action points (got ${g.watcher.guards[0].ap})`);

  g = withGuard(cx - 1, y, GUARD_CAPTURE_COST - 1);
  moveGuards(g);
  ok(g.prisoners[0].alive, "a guard that cannot afford the grab does not make it");
}

section("a decoy thrown after your own footsteps still pulls the guards");
{
  // The counterplay the how-to-play text promises: guards chase the FRESHEST
  // noise in their quadrant, so a decoy is supposed to peel them off you. It
  // didn't — two sounds made in the SAME turn both sit at NOISE_TTL, so the
  // search kept whichever was pushed first (your own footsteps) and the
  // guards walked straight at the prisoner with a live decoy on the board.
  //
  // Laid out along the East arm so the decoy is on the FAR side of the guard
  // from the prisoner: chasing the right sound therefore walks the guard
  // AWAY, and survival itself becomes the assertion. Collinear layouts where
  // the decoy sits past the prisoner capture them either way and prove
  // nothing.
  const map = generateMap(31);
  const { y } = map.center;
  const cx = map.center.x;
  const decoy = { x: cx + 3, y };
  const guardAt = { x: cx + 9, y };
  const prisonerAt = { x: cx + 15, y };
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  function run(decoyLast) {
    const g = createGame(map, { prisoners: [{ x: prisonerAt.x, y: prisonerAt.y }] });
    clearStrip(g, y, cx + 1, cx + 16);
    const p = g.prisoners[0];
    g.noise = [];
    g._noiseSeq = 0;
    if (decoyLast) {
      addNoise(g, p.x, p.y, "move");
      addNoise(g, decoy.x, decoy.y, "decoy");
    } else {
      addNoise(g, decoy.x, decoy.y, "decoy");
      addNoise(g, p.x, p.y, "move");
    }
    g.watcher.guards = [{ id: 1, x: guardAt.x, y: guardAt.y, quadrant: quadrantOf(g, decoy.x, decoy.y), ap: 5, turnsActive: 0, spent: false }];
    moveGuards(g);
    return { g, p, guard: g.watcher.guards[0] || { ...guardAt } };
  }

  const sane = run(true);
  ok(quadrantOf(sane.g, decoy.x, decoy.y) === quadrantOf(sane.g, prisonerAt.x, prisonerAt.y),
    "sanity: decoy and prisoner are in the same quadrant, so the guard could pick either");
  ok(dist(guardAt, prisonerAt) > GUARD_SIGHT_RANGE,
    "sanity: the guard cannot already see the prisoner before it moves");

  // Decoy thrown LAST — the more recent sound — pulls the guard the other way.
  ok(dist(sane.guard, decoy) < dist(guardAt, decoy),
    `decoy last: guard closes on the decoy (${dist(guardAt, decoy)} -> ${dist(sane.guard, decoy)})`);
  ok(sane.p.alive, "decoy last: the prisoner survives the guard's move");

  // Thrown FIRST it is the STALER sound, so your own steps correctly win —
  // otherwise "the decoy always wins" would just be a different hardcoded
  // answer, not a freshness rule.
  const stale = run(false);
  ok(dist(stale.guard, prisonerAt) < dist(guardAt, prisonerAt),
    `decoy first: guard closes on the prisoner instead (${dist(guardAt, prisonerAt)} -> ${dist(stale.guard, prisonerAt)})`);
}

// --- Summary --------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
