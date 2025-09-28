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

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID && y < GRID;
}

function tilePath(tileId) {
  switch (tileId) {
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

function overlayPath(objId) {
  switch (objId) {
    case OBJ.DOOR_LOCKED:
      return "/turf/door/locked";
    case OBJ.WALL_OBJ:
      return "/turf/wall"; // placeholder for wall object overlay
    case OBJ.GLASS:
      return "/turf/window";
    default:
      return null;
  }
}

function buildDefaultGrid() {
  const tiles = new Array(GRID)
    .fill(null)
    .map(() => new Array(GRID).fill(TILE.FLOOR));
  const objects = new Array(GRID)
    .fill(null)
    .map(() => new Array(GRID).fill(OBJ.NONE));
  const ringIndex = new Array(GRID)
    .fill(null)
    .map(() => new Array(GRID).fill(0));

  // Central tower (3x3)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = HALF + dx;
      const y = HALF + dy;
      tiles[y][x] = TILE.WALL;
      ringIndex[y][x] = -1;
    }
  }

  const moatThickness = 5;
  const ringThickness = 5;
  const ringBase = 1 + moatThickness;

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const r = Math.max(Math.abs(x - HALF), Math.abs(y - HALF));
      if (r === 0) continue;
      if (r <= 1 + moatThickness && ringIndex[y][x] === 0) {
        if (tiles[y][x] === TILE.FLOOR) tiles[y][x] = TILE.MOAT;
        ringIndex[y][x] = -1;
      } else if (r >= ringBase + 1) {
        const idx = Math.floor((r - (ringBase + 1)) / ringThickness) + 1;
        ringIndex[y][x] = idx > 0 ? idx : 0;
      }
    }
  }

  for (let i = 0; i < GRID; i++) {
    tiles[0][i] = TILE.WALL;
    tiles[GRID - 1][i] = TILE.WALL;
    tiles[i][0] = TILE.WALL;
    tiles[i][GRID - 1] = TILE.WALL;
  }

  const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)(12345);
  for (let i = 0; i < 220; i++) {
    const x = 3 + Math.floor(rng() * (GRID - 6));
    const y = 3 + Math.floor(rng() * (GRID - 6));
    if (Math.abs(x - HALF) <= 4 && Math.abs(y - HALF) <= 4) continue;
    if (tiles[y][x] === TILE.FLOOR && rng() < 0.15) {
      tiles[y][x] = TILE.WALL;
    }
  }

  function placeObj(x, y, objId) {
    if (inBounds(x, y) && tiles[y][x] === TILE.FLOOR) {
      objects[y][x] = objId;
    }
  }

  placeObj(HALF + 8, HALF + 2, OBJ.DOOR_LOCKED);
  placeObj(HALF - 9, HALF - 6, OBJ.WALL_OBJ);
  placeObj(HALF + 12, HALF - 10, OBJ.GLASS);

  const grid = [];
  for (let y = 0; y < GRID; y++) {
    const row = [];
    for (let x = 0; x < GRID; x++) {
      row.push({
        turf: tilePath(tiles[y][x]),
        overlay: overlayPath(objects[y][x]),
      });
    }
    grid.push(row);
  }

  return grid;
}

export const DEFAULT_MAP = {
  width: GRID,
  height: GRID,
  grid: buildDefaultGrid(),
};

export function cloneDefaultMap() {
  return {
    width: DEFAULT_MAP.width,
    height: DEFAULT_MAP.height,
    grid: DEFAULT_MAP.grid.map(row => row.map(cell => ({ ...cell }))),
  };
}
