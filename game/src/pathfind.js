// pathfind.js — BFS over the grid for AI navigation. Pure, shared by the
// in-game prisoner AI and the balance simulator.

import { TILE, OBJ, DIR_VEC } from "./map.js";

// Passable for a prisoner planning a route: floor tiles, including closed doors
// (they can be opened), glass and switches. Walls/tower/moat/lamps block.
export function prisonerPassable(map, x, y) {
  if (x < 0 || y < 0 || x >= map.size || y >= map.size) return false;
  if (map.tiles[y][x] !== TILE.FLOOR) return false;
  const o = map.objects[y][x];
  if (o === OBJ.LIGHT) return false;
  // A switch can never actually be occupied — stepping "onto" one just
  // toggles it and leaves the mover in place (see rules.js moveActivePrisoner).
  // Treating it as passable here let BFS route a path "through" a tile that
  // gameplay can never actually cross, which stalled the prisoner AI forever
  // (every planned step toward it just re-toggled the switch, 0 progress).
  if (o === OBJ.SWITCH) return false;
  return true;
}

// BFS from (sx,sy) to (tx,ty). Returns array of {x,y} path incl. start & target,
// or null if unreachable. `avoid` is an optional Set of "x,y" soft-blocked tiles
// (e.g., lit/gaze tiles) — used only if a path exists that avoids them; falls
// back to shortest path ignoring `avoid`.
export function bfsPath(map, sx, sy, tx, ty, avoid = null) {
  const path = bfsInner(map, sx, sy, tx, ty, avoid);
  if (path) return path;
  if (avoid) return bfsInner(map, sx, sy, tx, ty, null);
  return null;
}

function bfsInner(map, sx, sy, tx, ty, avoid) {
  const size = map.size;
  const key = (x, y) => y * size + x;
  const prev = new Map();
  const seen = new Uint8Array(size * size);
  const q = [{ x: sx, y: sy }];
  seen[key(sx, sy)] = 1;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    if (cur.x === tx && cur.y === ty) {
      // reconstruct
      const out = [];
      let k = key(tx, ty);
      let node = { x: tx, y: ty };
      while (node) {
        out.push(node);
        const pk = prev.get(key(node.x, node.y));
        node = pk;
      }
      out.reverse();
      return out;
    }
    for (const { dx, dy } of DIR_VEC) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nk = key(nx, ny);
      if (seen[nk]) continue;
      if (!prisonerPassable(map, nx, ny)) continue;
      if (avoid && avoid.has(`${nx},${ny}`) && !(nx === tx && ny === ty)) continue;
      seen[nk] = 1;
      prev.set(nk, cur);
      q.push({ x: nx, y: ny });
    }
  }
  return null;
}

// First-step direction (0..3) from start toward target along the shortest path,
// or -1 if none / already there.
export function stepToward(map, sx, sy, tx, ty, avoid = null) {
  const path = bfsPath(map, sx, sy, tx, ty, avoid);
  if (!path || path.length < 2) return -1;
  const a = path[0];
  const b = path[1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dy < 0) return 0;
  if (dx > 0) return 1;
  if (dy > 0) return 2;
  if (dx < 0) return 3;
  return -1;
}
