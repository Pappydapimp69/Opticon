// map.js — Procedural panopticon map generation for Opticon 3D.
// Pure data: no rendering, no DOM. Runs in browser (ES module) and Node.
//
// The world is a square grid. The Watcher's tower sits dead center, ringed by an
// impassable moat, then a series of concentric playable "rings" (bands) that wrap
// the tower. Prisoners spawn in the outermost ring and must reach an EXIT gate.
//
// Coordinates: grid[y][x]. Chebyshev radius r = max(|x-cx|, |y-cy|) defines bands.

export const TILE = Object.freeze({
  FLOOR: 0,
  WALL: 1,
  MOAT: 2,
  TOWER: 3,
});

export const OBJ = Object.freeze({
  NONE: 0,
  DOOR: 1, // blocks until opened; opening is silent, costs 1 MP
  GLASS: 2, // a breakable window on a WALL tile; blocks until broken (loud,
  // costs 1 MP), then passable + sight-open permanently — a deliberate
  // shortcut/distraction tool, not a floor hazard.
  SWITCH: 3, // toggles a linked light group; silent, costs 1 MP
  EXIT: 4, // reach it to win (prisoner)
  LIGHT: 5, // a lamp fixture; emits light when its group is on
});

export const DIRS = Object.freeze(["North", "East", "South", "West"]);
export const DIR_VEC = Object.freeze([
  { dx: 0, dy: -1 }, // North
  { dx: 1, dy: 0 }, // East
  { dx: 0, dy: 1 }, // South
  { dx: -1, dy: 0 }, // West
]);

// Small deterministic PRNG (mulberry32) so maps are reproducible from a seed.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Default map shape. Grid is derived so all rings fit with a 1-tile outer wall.
export const MAP_DEFAULTS = Object.freeze({
  towerRadius: 2, // tower spans Chebyshev r <= towerRadius (a (2R+1)^2 block)
  moatThickness: 2,
  ringCount: 4,
  ringThickness: 3,
  border: 1, // outer bounding wall thickness
});

export function computeGridSize(cfg = MAP_DEFAULTS) {
  const playRadius =
    cfg.towerRadius + cfg.moatThickness + cfg.ringCount * cfg.ringThickness;
  const half = playRadius + cfg.border;
  return 2 * half + 1; // odd => a true center tile
}

// Classify a Chebyshev radius into a band.
// returns { kind: 'tower'|'moat'|'ring'|'border', ring: n|null }
export function classifyRadius(r, cfg = MAP_DEFAULTS) {
  const moatOuter = cfg.towerRadius + cfg.moatThickness;
  const playOuter = moatOuter + cfg.ringCount * cfg.ringThickness;
  if (r <= cfg.towerRadius) return { kind: "tower", ring: null };
  if (r <= moatOuter) return { kind: "moat", ring: null };
  if (r <= playOuter) {
    const ring = Math.floor((r - moatOuter - 1) / cfg.ringThickness) + 1;
    return { kind: "ring", ring };
  }
  return { kind: "border", ring: null };
}

// Quadrant of a tile relative to center: 0..3 (N/E/S/W), matching DIRS.
// Ties on the diagonal are broken toward N/S (vertical dominance) for coverage.
export function quadrantOf(x, y, cx, cy) {
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return 0;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 0 : 2; // N : S
  return dx > 0 ? 1 : 3; // E : W
}

// Generate a full map object.
export function generateMap(seed = 1, cfg = MAP_DEFAULTS) {
  const rng = makeRng(seed);
  const size = computeGridSize(cfg);
  const c = (size - 1) / 2;

  const tiles = grid(size, TILE.FLOOR);
  const objects = grid(size, OBJ.NONE);
  const ring = grid(size, 0); // 0 => not a playable ring
  const quad = grid(size, -1);
  const lightGroup = grid(size, -1); // which switch-group a LIGHT/SWITCH belongs to

  const moatOuter = cfg.towerRadius + cfg.moatThickness;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.max(Math.abs(x - c), Math.abs(y - c));
      const cl = classifyRadius(r, cfg);
      if (cl.kind === "tower") tiles[y][x] = TILE.TOWER;
      else if (cl.kind === "moat") tiles[y][x] = TILE.MOAT;
      else if (cl.kind === "border") tiles[y][x] = TILE.WALL;
      else {
        tiles[y][x] = TILE.FLOOR;
        ring[y][x] = cl.ring;
        quad[y][x] = quadrantOf(x, y, c, c);
      }
    }
  }

  // --- Radial walls between quadrants create the "spoke" corridors + chokepoints.
  // Place walls along the 4 diagonals of each ring band, leaving gaps (doorways).
  addSpokeWalls(tiles, objects, ring, size, c, cfg, rng);

  // --- Scatter interior walls to form cover/chokepoints (avoid sealing tiles).
  scatterWalls(tiles, objects, ring, size, c, rng, cfg);

  // --- Lights + switches: each ring gets a few lamp fixtures grouped to a switch.
  const lights = placeLightsAndSwitches(tiles, objects, ring, lightGroup, size, c, cfg, rng);

  // --- Windows: breakable shortcuts on "thin" wall segments (floor on both
  // opposite sides), so breaking one actually connects two areas.
  placeWindows(tiles, objects, ring, size, rng, cfg);

  // --- Doors on some ring boundaries so movement inward needs effort.
  addBoundaryDoors(tiles, objects, ring, size, c, cfg, rng);

  // --- Exit gate: on the outer edge of the outermost ring, one cardinal side.
  const exit = placeExit(tiles, objects, ring, size, c, cfg, rng);

  // --- Prisoner spawn: outermost ring, opposite side from the exit.
  const spawn = placeSpawn(tiles, objects, ring, size, c, cfg, exit);

  // Repair connectivity: guarantee spawn can reach exit (flood fill; carve if needed).
  ensureConnected(tiles, objects, size, spawn, exit);

  return {
    seed,
    cfg,
    size,
    center: { x: c, y: c },
    tiles,
    objects,
    ring,
    quad,
    lightGroup,
    lights, // [{x,y,group,radius}]
    lightState: lights.reduce((m, l) => ((m[l.group] = true), m), {}), // group -> on/off
    exit, // {x,y}
    spawn, // {x,y}
    ringCount: cfg.ringCount,
  };
}

function grid(n, fill) {
  return Array.from({ length: n }, () => new Array(n).fill(fill));
}

function inBounds(x, y, size) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

function addSpokeWalls(tiles, objects, ring, size, c, cfg, rng) {
  // Along the two main diagonals, drop walls but punch a doorway per ring band.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (ring[y][x] === 0) continue;
      const dx = x - c;
      const dy = y - c;
      const onDiag = Math.abs(Math.abs(dx) - Math.abs(dy)) === 0;
      if (!onDiag) continue;
      // Leave a doorway near the middle of each ring band pseudo-randomly.
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      if (r % 2 === 0 && rng() < 0.5) continue; // gap
      tiles[y][x] = TILE.WALL;
    }
  }
}

function scatterWalls(tiles, objects, ring, size, c, rng, cfg) {
  const attempts = size * size * 0.12;
  for (let i = 0; i < attempts; i++) {
    const x = 1 + Math.floor(rng() * (size - 2));
    const y = 1 + Math.floor(rng() * (size - 2));
    if (ring[y][x] === 0) continue;
    if (tiles[y][x] !== TILE.FLOOR) continue;
    if (rng() < 0.14) tiles[y][x] = TILE.WALL;
  }
}

// A window only makes sense on a "thin" wall segment — one with FLOOR on
// both opposite sides (N/S or E/W) — so breaking it actually joins two
// areas into a shortcut, rather than opening onto a dead corner or the
// moat/tower. Placed independently of `ring` (a wall tile between two rings
// has `ring === 0` itself, which would incorrectly skip every candidate).
function placeWindows(tiles, objects, ring, size, rng, cfg) {
  const attempts = size * size * 0.05;
  for (let i = 0; i < attempts; i++) {
    const x = 1 + Math.floor(rng() * (size - 2));
    const y = 1 + Math.floor(rng() * (size - 2));
    if (tiles[y][x] !== TILE.WALL) continue;
    if (objects[y][x] !== OBJ.NONE) continue;
    const nsOpen = tiles[y - 1][x] === TILE.FLOOR && tiles[y + 1][x] === TILE.FLOOR;
    const ewOpen = tiles[y][x - 1] === TILE.FLOOR && tiles[y][x + 1] === TILE.FLOOR;
    if (!nsOpen && !ewOpen) continue;
    if (rng() < 0.35) objects[y][x] = OBJ.GLASS;
  }
}

function placeLightsAndSwitches(tiles, objects, ring, lightGroup, size, c, cfg, rng) {
  const lights = [];
  let group = 0;
  for (let rIdx = 1; rIdx <= cfg.ringCount; rIdx++) {
    const perRing = 2 + (rIdx % 2); // 2 or 3 lamp groups per ring
    for (let k = 0; k < perRing; k++) {
      const spot = randomFloorInRing(tiles, objects, ring, size, rIdx, rng);
      if (!spot) continue;
      const g = group++;
      objects[spot.y][spot.x] = OBJ.LIGHT;
      lightGroup[spot.y][spot.x] = g;
      lights.push({ x: spot.x, y: spot.y, group: g, radius: 3 + (rIdx % 2) });
      // A switch a short distance away, same ring.
      const sw = randomFloorInRing(tiles, objects, ring, size, rIdx, rng);
      if (sw) {
        objects[sw.y][sw.x] = OBJ.SWITCH;
        lightGroup[sw.y][sw.x] = g;
      }
    }
  }
  return lights;
}

function addBoundaryDoors(tiles, objects, ring, size, c, cfg, rng) {
  // On cardinal axes, at each inner ring boundary, place a door to gate progress.
  for (const { dx, dy } of DIR_VEC) {
    for (let rIdx = 2; rIdx <= cfg.ringCount; rIdx++) {
      const rr = cfg.towerRadius + cfg.moatThickness + (rIdx - 1) * cfg.ringThickness + 1;
      const x = c + dx * rr;
      const y = c + dy * rr;
      if (!inBounds(x, y, size)) continue;
      if (tiles[y][x] === TILE.FLOOR && objects[y][x] === OBJ.NONE && rng() < 0.7) {
        objects[y][x] = OBJ.DOOR;
      }
    }
  }
}

function placeExit(tiles, objects, ring, size, c, cfg, rng) {
  // Exit sits on the outer edge of the outermost ring, on a random cardinal side.
  const side = Math.floor(rng() * 4);
  const { dx, dy } = DIR_VEC[side];
  const rr = cfg.towerRadius + cfg.moatThickness + cfg.ringCount * cfg.ringThickness;
  let x = c + dx * rr;
  let y = c + dy * rr;
  x = Math.max(1, Math.min(size - 2, x));
  y = Math.max(1, Math.min(size - 2, y));
  tiles[y][x] = TILE.FLOOR;
  objects[y][x] = OBJ.EXIT;
  // Clear a short lead-in so the gate isn't walled off.
  const ix = c + dx * (rr - 1);
  const iy = c + dy * (rr - 1);
  if (tiles[iy] && tiles[iy][ix] === TILE.FLOOR && objects[iy][ix] === OBJ.LIGHT) objects[iy][ix] = OBJ.NONE;
  return { x, y, side };
}

function placeSpawn(tiles, objects, ring, size, c, cfg, exit) {
  // Spawn in an INNER ring (near the tower — maximum tension under the eye),
  // offset ~90 degrees from the exit so the run is a bounded radial+lateral
  // journey outward toward the gate, not a half-circumference slog.
  const spawnSide = (exit.side + 1) % 4;
  const { dx, dy } = DIR_VEC[spawnSide];
  const innerR = cfg.towerRadius + cfg.moatThickness + 2; // just inside ring 1
  let x = Math.max(1, Math.min(size - 2, c + dx * innerR));
  let y = Math.max(1, Math.min(size - 2, c + dy * innerR));
  const found = nearestFloor(tiles, objects, size, x, y);
  if (found) {
    x = found.x;
    y = found.y;
  }
  tiles[y][x] = TILE.FLOOR;
  if (objects[y][x] === OBJ.DOOR || objects[y][x] === OBJ.LIGHT) objects[y][x] = OBJ.NONE;
  return { x, y };
}

function randomFloorInRing(tiles, objects, ring, size, rIdx, rng) {
  for (let tries = 0; tries < 60; tries++) {
    const x = 1 + Math.floor(rng() * (size - 2));
    const y = 1 + Math.floor(rng() * (size - 2));
    if (ring[y][x] === rIdx && tiles[y][x] === TILE.FLOOR && objects[y][x] === OBJ.NONE) {
      return { x, y };
    }
  }
  return null;
}

function nearestFloor(tiles, objects, size, sx, sy) {
  const seen = new Set();
  const q = [{ x: sx, y: sy }];
  while (q.length) {
    const { x, y } = q.shift();
    const key = y * size + x;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!inBounds(x, y, size)) continue;
    if (tiles[y][x] === TILE.FLOOR && objects[y][x] !== OBJ.DOOR) return { x, y };
    for (const { dx, dy } of DIR_VEC) q.push({ x: x + dx, y: y + dy });
  }
  return null;
}

// Passable for connectivity purposes: floors, and doors (they can be opened),
// and glass/switch/light-adjacent floors. Tower/moat/wall/border block.
function passableForConnectivity(tiles, objects, x, y, size) {
  if (!inBounds(x, y, size)) return false;
  const t = tiles[y][x];
  if (t !== TILE.FLOOR) return false;
  const o = objects[y][x];
  if (o === OBJ.LIGHT) return false; // lamp fixture is solid
  // A switch can never actually be occupied (stepping toward one only
  // toggles it in place — see rules.js moveActivePrisoner), so it must not
  // count as a connectivity pass-through either, or the generator could
  // "guarantee" a route that real movement can never actually complete.
  if (o === OBJ.SWITCH) return false;
  return true; // doors count as passable (openable)
}

function ensureConnected(tiles, objects, size, spawn, exit) {
  // BFS from spawn; if exit unreachable, carve a path by knocking walls toward it.
  const reached = floodReachable(tiles, objects, size, spawn);
  if (reached.has(exit.y * size + exit.x)) return;
  // Greedy carve: walk from exit toward spawn, converting blockers to floor.
  let x = exit.x;
  let y = exit.y;
  let guard = size * size;
  while ((x !== spawn.x || y !== spawn.y) && guard-- > 0) {
    const sx = Math.sign(spawn.x - x);
    const sy = Math.sign(spawn.y - y);
    // Prefer the axis with greater remaining distance.
    if (Math.abs(spawn.x - x) >= Math.abs(spawn.y - y) && sx !== 0) x += sx;
    else if (sy !== 0) y += sy;
    else if (sx !== 0) x += sx;
    if (!inBounds(x, y, size)) break;
    if (tiles[y][x] !== TILE.TOWER && tiles[y][x] !== TILE.MOAT) {
      tiles[y][x] = TILE.FLOOR;
      if (objects[y][x] === OBJ.LIGHT || objects[y][x] === OBJ.WALL) objects[y][x] = OBJ.NONE;
    }
  }
}

function floodReachable(tiles, objects, size, start) {
  const seen = new Set();
  const q = [start];
  while (q.length) {
    const { x, y } = q.pop();
    const key = y * size + x;
    if (seen.has(key)) continue;
    if (!passableForConnectivity(tiles, objects, x, y, size)) continue;
    seen.add(key);
    for (const { dx, dy } of DIR_VEC) q.push({ x: x + dx, y: y + dy });
  }
  return seen;
}
