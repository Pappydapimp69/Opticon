const TILE_SIZE = 20;
const GRID = 41;
const HALF = Math.floor(GRID / 2);

const TILE = {
  FLOOR: 0,
  WALL: 1,
  MOAT: 2,
};

const OBJ = {
  NONE: 0,
  DOOR_LOCKED: 1,
  WALL_OBJ: 2,
  GLASS: 3,
};

const state = {
  map: [],
  objects: [],
  ringIndex: [],
  ringThickness: 5,
  moatThickness: 5,
  ringCount: 0,
};

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID && y < GRID;
}

function buildMap() {
  state.map = new Array(GRID)
    .fill(0)
    .map(() => new Array(GRID).fill(TILE.FLOOR));
  state.objects = new Array(GRID)
    .fill(0)
    .map(() => new Array(GRID).fill(OBJ.NONE));
  state.ringIndex = new Array(GRID)
    .fill(0)
    .map(() => new Array(GRID).fill(0));

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = HALF + dx;
      const y = HALF + dy;
      state.map[y][x] = TILE.WALL;
      state.ringIndex[y][x] = -1;
    }
  }

  const moatT = state.moatThickness;
  const ringT = state.ringThickness;
  const ringBase = 1 + moatT;
  state.ringCount = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const r = Math.max(Math.abs(x - HALF), Math.abs(y - HALF));
      if (r === 0) continue;
      if (r <= 1 + moatT && state.ringIndex[y][x] === 0) {
        if (state.map[y][x] === TILE.FLOOR) state.map[y][x] = TILE.MOAT;
        state.ringIndex[y][x] = -1;
      } else if (r >= ringBase + 1) {
        const idx = Math.floor((r - (ringBase + 1)) / ringT) + 1;
        state.ringIndex[y][x] = idx > 0 ? idx : 0;
        if (idx > state.ringCount) state.ringCount = idx;
      }
    }
  }

  for (let i = 0; i < GRID; i++) {
    state.map[0][i] = TILE.WALL;
    state.map[GRID - 1][i] = TILE.WALL;
    state.map[i][0] = TILE.WALL;
    state.map[i][GRID - 1] = TILE.WALL;
  }

  const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)(12345);
  for (let i = 0; i < 220; i++) {
    const x = 3 + Math.floor(rng() * (GRID - 6));
    const y = 3 + Math.floor(rng() * (GRID - 6));
    if (Math.abs(x - HALF) <= 4 && Math.abs(y - HALF) <= 4) continue;
    if (state.map[y][x] === TILE.FLOOR && rng() < 0.15) {
      state.map[y][x] = TILE.WALL;
    }
  }

  function placeObj(x, y, type) {
    if (inBounds(x, y) && state.map[y][x] === TILE.FLOOR) state.objects[y][x] = type;
  }
  placeObj(HALF + 8, HALF + 2, OBJ.DOOR_LOCKED);
  placeObj(HALF - 9, HALF - 6, OBJ.WALL_OBJ);
  placeObj(HALF + 12, HALF - 10, OBJ.GLASS);
}

function tilePath(t) {
  switch (t) {
    case TILE.FLOOR:
      return "/turf/floor";
    case TILE.WALL:
      return "/turf/wall";
    case TILE.MOAT:
      return "/turf/moat";
    default:
      return "/turf/unknown";
  }
}

function objPath(o) {
  switch (o) {
    case OBJ.DOOR_LOCKED:
      return "/turf/door/locked";
    case OBJ.WALL_OBJ:
      return "/turf/wall";
    case OBJ.GLASS:
      return "/turf/window";
    default:
      return null;
  }
}

buildMap();

const grid = [];
for (let y = 0; y < GRID; y++) {
  const row = [];
  for (let x = 0; x < GRID; x++) {
    row.push({
      turf: tilePath(state.map[y][x]),
      overlay: objPath(state.objects[y][x]),
    });
  }
  grid.push(row);
}

process.stdout.write(JSON.stringify({ grid }, null, 2));
