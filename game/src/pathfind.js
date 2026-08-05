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


// ---- Risk-weighted routing -------------------------------------------------
//
// `bfsPath`'s `avoid` set is BINARY, and when it blocks the route entirely it
// is discarded (see the fallback above). That makes risk all-or-nothing: a
// tile is either forbidden or free, and the moment enough tiles are risky the
// whole notion is dropped. Measured consequence — raising the prisoner AI's
// caution from 0.34 to 0.15 moved its speed from 2.90 to 2.81 tiles/turn and
// its escape rate AGAINST A STARING WATCHER not at all (94% -> 96%): fear had
// nowhere to go, because "safer but longer" is not a thing the search can
// express. Every caution/bluff/skill lever routed through it measured ~3pt and
// was written off as weak (Tension T25); they were all bottlenecked here.
//
// This is uniform-cost search (Dijkstra) where entering a tile costs
// 1 + penalty(x, y). A detour is taken exactly when it is cheaper than the
// danger it avoids, so risk trades against tempo continuously instead of
// switching off. There is no fallback, and none is needed: the cheapest route
// always exists, it just runs through danger when danger is unavoidable.
export function costPath(map, sx, sy, tx, ty, penalty = null) {
  if (!prisonerPassable(map, tx, ty) && !(tx === sx && ty === sy)) {
    // The caller may legitimately target a tile that is not stand-on-able
    // (the exit is walkable, but guard against a bad target rather than
    // scanning the whole grid for nothing).
    if (!prisonerPassable(map, tx, ty)) return null;
  }
  const size = map.size;
  const n = size * size;
  const key = (x, y) => y * size + x;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const start = key(sx, sy);
  dist[start] = 0;

  // Binary min-heap of node keys, ordered by dist. Small grids (~35x35) but
  // this runs several times per prisoner per turn, so an O(n^2) scan would
  // show up in the balance sim (Brain opticon#E22: a pathfinding cost regression
  // hid as a 6x whole-sim slowdown with no visible symptom).
  const heap = [start];
  const heapPos = new Map([[start, 0]]);
  const less = (a, b) => dist[a] < dist[b];
  const swap = (i, j) => {
    const a = heap[i], b = heap[j];
    heap[i] = b; heap[j] = a;
    heapPos.set(b, i); heapPos.set(a, j);
  };
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; swap(i, p); i = p; } };
  const down = (i) => {
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[l], heap[m])) m = l;
      if (r < heap.length && less(heap[r], heap[m])) m = r;
      if (m === i) break;
      swap(i, m); i = m;
    }
  };
  const push = (k) => { heap.push(k); heapPos.set(k, heap.length - 1); up(heap.length - 1); };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    heapPos.delete(top);
    if (heap.length) { heap[0] = last; heapPos.set(last, 0); down(0); }
    return top;
  };

  const target = key(tx, ty);
  while (heap.length) {
    const cur = pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === target) break;
    const cx = cur % size, cy = (cur / size) | 0;
    for (const { dx, dy } of DIR_VEC) {
      const nx = cx + dx, ny = cy + dy;
      if (!prisonerPassable(map, nx, ny)) continue;
      const nk = key(nx, ny);
      if (done[nk]) continue;
      const step = 1 + (penalty ? Math.max(0, penalty(nx, ny)) : 0);
      const alt = dist[cur] + step;
      if (alt < dist[nk]) {
        dist[nk] = alt;
        prev[nk] = cur;
        if (heapPos.has(nk)) up(heapPos.get(nk));
        else push(nk);
      }
    }
  }

  if (!done[target] && target !== start) return null;
  const out = [];
  for (let k = target; k !== -1; k = prev[k]) {
    out.push({ x: k % size, y: (k / size) | 0 });
    if (k === start) break;
  }
  out.reverse();
  return out[0] && out[0].x === sx && out[0].y === sy ? out : null;
}
