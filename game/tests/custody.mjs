// custody.mjs — Being caught is the start of a problem, not the end of a run.
//
// Capture used to be `p.alive = false`: the eye found you and you stopped
// existing. A seized prisoner now sits on the tile they were taken on with a
// three-turn processing clock, and four things can end it — a Shim, a Flare
// that pulls the posted guard off you, a companion reaching the cell, or bare
// hands and luck. A guard standing watch beats everything except the Shim.
//
// The traps this file is built around:
//  * a reprieve that hands you straight back on the very next scan is not a
//    reprieve (RELEASE_GRACE_ROUNDS);
//  * three turns must mean three of YOUR turns, not three of anyone's;
//  * `alive` stopped meaning "can act", so every gate that used to read it has
//    to read custody as well or a cuffed prisoner can still walk out;
//  * the odds compound — 0.3 a turn is a 66% escape, not "poor odds".
// Run: node game/tests/custody.mjs
import { generateMap, MAP_DEFAULTS, ITEM_KINDS } from "../src/map.js";
import {
  createGame, endPrisonerTurn, endWatcherTurn, isOver, watcherScan, moveGuards,
  moveActivePrisoner, breakWindow, useItem, struggle, guardOver,
  CUSTODY_TURNS, STRUGGLE_CHANCE, RELEASE_GRACE_ROUNDS,
  GUARD_ACTION_POINTS, GUARD_CAPTURE_COST, ROUND_LIMIT,
  distractTarget, quadrantOf,
} from "../src/rules.js";

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}
function section(t) { console.log(`\n— ${t}`); }

const map = generateMap(4242, { ...MAP_DEFAULTS, prisonerCount: 3 });
const build = (opts = {}) => createGame(map, { watcherFacing: 0, prisoners: map.spawns, ...opts });
// Clear the strip a guard test runs along so pathing and walls never decide
// the answer instead of the rule under test.
const clearRow = (g, y, x0, x1) => {
  for (let x = x0; x <= x1; x++) {
    g.map.tiles[y][x] = 0; // TILE.FLOOR
    g.map.objects[y][x] = 0; // OBJ.NONE
  }
};

// ---- 1. Seizure, not deletion --------------------------------------------
section("capture seizes; the clock is what kills");
{
  const g = build();
  const p = g.prisoners[0];
  const c = map.center;
  p.x = c.x;
  p.y = c.y - (map.cfg.towerRadius + map.cfg.moatThickness + 2);
  g.noise.push({ x: p.x, y: p.y, ttl: 2, source: "test" });
  g.turn = "Watcher";
  g.round = 2;
  g.watcher.facing = 0;
  const scan = watcherScan(g);
  check(!!scan.caught, "the gaze still catches an exposed prisoner in its wedge");
  check(p.alive, "but the prisoner is alive");
  check(p.custody === CUSTODY_TURNS, `and held for ${CUSTODY_TURNS} turns (got ${p.custody})`);
  check(!isOver(g), "the game keeps running");
  check(g.lastCaught && g.lastCaught.x === p.x,
    "the capture is still public evidence of where the eye was pointed");
}

// ---- 2. Three turns means three of YOUR turns ----------------------------
// With companions cycling in between, a clock that ticked on every prisoner
// turn would give the held player one chance instead of three.
{
  const g = build();
  const held = g.prisoners[0];
  held.custody = CUSTODY_TURNS;
  let mine = 0;
  for (let i = 0; i < 40 && held.alive; i++) {
    if (g.activePrisoner === 0) mine++;
    endPrisonerTurn(g);
    endWatcherTurn(g);
  }
  check(mine === CUSTODY_TURNS, `the clock spent exactly ${CUSTODY_TURNS} of the held prisoner's own turns (got ${mine})`);
  check(!held.alive, "and then they are processed");
  check(g.prisoners[1].alive && g.prisoners[2].alive, "companions were untouched by it");
}

// ---- 3. `alive` no longer means "can act" --------------------------------
// The gate that would silently let a cuffed prisoner keep playing.
{
  const g = build();
  const p = g.prisoners[0];
  p.custody = CUSTODY_TURNS;
  for (let d = 0; d < 4; d++) {
    check(moveActivePrisoner(g, d).reason === "held", `held: cannot walk (dir ${d})`);
  }
  check(breakWindow(g, 0).reason === "held", "held: cannot break a window");
  p.items = [ITEM_KINDS.LOCKPICK];
  check(useItem(g, ITEM_KINDS.LOCKPICK, 0).reason === "held", "held: a world item does nothing from a cell");
  const start = { x: p.x, y: p.y };
  endPrisonerTurn(g);
  check(p.x === start.x && p.y === start.y, "and they are exactly where they were seized");
}

// ---- 4. Custody items are inert until you need them ----------------------
{
  const g = build();
  const p = g.prisoners[0];
  p.items = [ITEM_KINDS.SHIM, ITEM_KINDS.TRANSFER];
  check(useItem(g, ITEM_KINDS.SHIM, null).reason === "only-in-custody", "a Shim does nothing while you are free");
  check(useItem(g, ITEM_KINDS.TRANSFER, null).reason === "only-in-custody", "nor does a Forged Transfer");
  check(p.items.length === 2, "and neither is consumed by trying");
}

// ---- 5. The Shim: the certain out, guard or no guard ---------------------
{
  const g = build();
  const p = g.prisoners[0];
  p.custody = CUSTODY_TURNS;
  p.items = [ITEM_KINDS.SHIM];
  g.watcher.guards = [{ id: 1, x: p.x, y: p.y, quadrant: 0, ap: GUARD_ACTION_POINTS, turnsActive: 0, spent: false }];
  check(!!guardOver(g, p), "a guard is posted right on them");
  check(struggle(g, () => 0).freed === false, "struggling under a guard's hand cannot work, even on a perfect roll");
  p.struggledThisTurn = false;
  const r = useItem(g, ITEM_KINDS.SHIM, null);
  check(r.ok && !p.custody, "the Shim gets them out anyway — that is what it is for");
  check(!p.items.length, "and it is spent");
}

// ---- 6. The Forged Transfer buys turns, it does not open the door --------
{
  const g = build();
  const p = g.prisoners[0];
  p.custody = 1; // last turn before processing
  p.items = [ITEM_KINDS.TRANSFER];
  const r = useItem(g, ITEM_KINDS.TRANSFER, null);
  check(r.ok, "the papers are accepted");
  check(p.custody === CUSTODY_TURNS, `the clock resets to ${CUSTODY_TURNS} (got ${p.custody})`);
  check(p.custody > 0, "but they are still in the cell — this is time, not freedom");
  // Resets rather than accumulates, so it cannot be stacked into a permanent stay.
  p.items = [ITEM_KINDS.TRANSFER];
  useItem(g, ITEM_KINDS.TRANSFER, null);
  check(p.custody === CUSTODY_TURNS, "a second one resets rather than adds");
}

// ---- 7. The Flare answers the posted guard -------------------------------
{
  const g = build();
  const p = g.prisoners[0];
  clearRow(g, p.y, Math.max(1, p.x - 6), Math.min(map.size - 2, p.x + 6));
  p.custody = CUSTODY_TURNS;
  p.items = [ITEM_KINDS.FLARE];
  const guard = { id: 1, x: p.x, y: p.y, quadrant: 0, ap: GUARD_ACTION_POINTS, turnsActive: 0, spent: false };
  guard.quadrant = 0;
  g.watcher.guards = [guard];
  check(!!guardOver(g, p), "a guard is standing over them");
  // The pull is BY QUADRANT, so work out where the throw actually lands first
  // and put the guard in that quadrant — otherwise the seed decides whether
  // the effect under test runs at all, and an earlier version of this section
  // silently skipped its own three most important assertions.
  let dir = -1, landing = null;
  for (let d = 0; d < 4; d++) {
    const t = distractTarget(g, p, d);
    if (t) { dir = d; landing = t; break; }
  }
  check(!!landing, "there is somewhere to throw it");
  guard.quadrant = quadrantOf(g, landing.x, landing.y);
  const r = useItem(g, ITEM_KINDS.FLARE, dir);
  check(r.ok, "the flare can be thrown from inside a cell — unlike every other world item");
  check(r.pulled === 1, `it pulls the quadrant's guards (${r.pulled})`);
  check(guard.x === landing.x && guard.y === landing.y, "onto the tile it landed on");
  check(!guardOver(g, p), "so the guard that was standing over them is gone");
  check(guard.stunnedTurns === 1, "and blinded for its next move as well");
  const apBefore = guard.ap;
  moveGuards(g);
  check(guard.ap === apBefore, "being fooled costs the guard no action points, only the turn");
  // And the whole point: the struggle that was hopeless is now live.
  p.struggledThisTurn = false;
  check(struggle(g, () => 0).freed === true, "the struggle it bought actually works");
}

// ---- 8. Struggling: free, poor, and hopeless under a guard ---------------
{
  const g = build();
  const p = g.prisoners[0];
  p.custody = CUSTODY_TURNS;
  check(struggle(g, () => 0).freed === true, "a good roll gets a hand free");

  const g2 = build();
  const q = g2.prisoners[0];
  q.custody = CUSTODY_TURNS;
  check(struggle(g2, () => 0.99).freed === false, "a bad roll does not");
  check(struggle(g2, () => 0).ok === false, "and there is only one attempt per turn");

  // The compounding check — the number that actually decides how much capture
  // means. Three turns at STRUGGLE_CHANCE is not STRUGGLE_CHANCE.
  const overThree = 1 - Math.pow(1 - STRUGGLE_CHANCE, CUSTODY_TURNS);
  check(overThree < 0.5,
    `bare-handed escape stays a long shot over the full clock (${(overThree * 100).toFixed(0)}%)`);
}

// ---- 9. A guard on the cell stands watch, and pays for it ----------------
{
  const g = build();
  const p = g.prisoners[0];
  const y = p.y;
  clearRow(g, y, Math.max(1, p.x - 5), Math.min(map.size - 2, p.x + 5));
  p.custody = CUSTODY_TURNS;
  g.noise = [{ x: Math.min(map.size - 2, p.x + 4), y, ttl: 2, seq: 1, source: "test" }];
  const guard = { id: 1, x: p.x + 1, y, quadrant: 0, ap: GUARD_ACTION_POINTS, turnsActive: 0, spent: false };
  g.watcher.guards = [guard];
  const at = { x: guard.x, y: guard.y };
  moveGuards(g);
  check(guard.x === at.x && guard.y === at.y,
    "a guard beside a cell holds position instead of chasing the fresh noise");
  check(guard.ap === GUARD_ACTION_POINTS - 1, `and standing watch costs a point a turn (got ${guard.ap})`);
  check(guard.ap !== GUARD_ACTION_POINTS - GUARD_CAPTURE_COST, "it is not re-arresting someone already held");
}

// ---- 10. A companion opens the cell --------------------------------------
{
  const g = build();
  const held = g.prisoners[0];
  const friend = g.prisoners[1];
  held.custody = CUSTODY_TURNS;
  friend.x = held.x + 1;
  friend.y = held.y;
  friend.alive = true;
  g.activePrisoner = 1;
  endPrisonerTurn(g);
  check(!held.custody, "a teammate who ends their turn beside the cell lets them out");
  check(held.alive, "and they are back in the game");
}
{
  // ...but not through a posted guard.
  const g = build();
  const held = g.prisoners[0];
  const friend = g.prisoners[1];
  held.custody = CUSTODY_TURNS;
  friend.x = held.x + 1;
  friend.y = held.y;
  g.watcher.guards = [{ id: 1, x: held.x, y: held.y, quadrant: 0, ap: GUARD_ACTION_POINTS, turnsActive: 0, spent: false }];
  g.activePrisoner = 1;
  endPrisonerTurn(g);
  check(held.custody === CUSTODY_TURNS, "a posted guard turns the rescue away");
}
{
  // A teammate two tiles off is not a rescue.
  const g = build();
  const held = g.prisoners[0];
  const friend = g.prisoners[1];
  held.custody = CUSTODY_TURNS;
  friend.x = held.x + 2;
  friend.y = held.y;
  g.activePrisoner = 1;
  endPrisonerTurn(g);
  check(held.custody === CUSTODY_TURNS, "reach is adjacency, not line of sight");
}

// ---- 11. Release is not a revolving door ---------------------------------
// The eye that took you is usually still pointed at the tile it took you on.
{
  const g = build();
  const p = g.prisoners[0];
  const c = map.center;
  p.x = c.x;
  p.y = c.y - (map.cfg.towerRadius + map.cfg.moatThickness + 2);
  g.noise.push({ x: p.x, y: p.y, ttl: 9, source: "test" });
  g.turn = "Watcher";
  g.round = 2;
  g.watcher.facing = 0;
  watcherScan(g);
  check(p.custody === CUSTODY_TURNS, "seized on a lit, watched tile");
  g.turn = "Prisoner";
  const r = struggle(g, () => 0);
  check(r.freed, "they work loose");
  check(p.graceUntilRound === g.round + RELEASE_GRACE_ROUNDS,
    `and carry ${RELEASE_GRACE_ROUNDS} round of grace (through round ${p.graceUntilRound})`);
  g.turn = "Watcher";
  const again = watcherScan(g);
  check(!again.caught && !p.custody,
    "the very next scan, from the same gaze on the same tile, cannot re-take them");
  // ...and the grace is one round, not immunity.
  g.round = p.graceUntilRound + 1;
  g.turn = "Watcher";
  const third = watcherScan(g);
  check(!!third.caught && p.custody === CUSTODY_TURNS, "a round later the eye can take them again");
}
{
  // Guards are physical: the grace does not stop them.
  const g = build();
  const p = g.prisoners[0];
  p.graceUntilRound = g.round + 5;
  g.watcher.guards = [{ id: 1, x: p.x + 1, y: p.y, quadrant: 0, ap: GUARD_ACTION_POINTS, turnsActive: 0, spent: false }];
  g.noise = [];
  moveGuards(g);
  check(p.custody === CUSTODY_TURNS, "grace protects from the gaze, not from a guard's hands");
}

// ---- 12. A held human prisoner has not lost yet --------------------------
// The "your own escape" rule reads `alive`, and a held prisoner is alive —
// so custody must NOT be an instant loss, and processing must be.
{
  const g = build({ humanPrisoner: 0 });
  const p = g.prisoners[0];
  p.custody = CUSTODY_TURNS;
  endPrisonerTurn(g);
  endWatcherTurn(g);
  check(!isOver(g), "being held is not losing");
  let guardCount = 0;
  while (!isOver(g) && guardCount++ < 60) {
    endPrisonerTurn(g);
    endWatcherTurn(g);
  }
  check(isOver(g) && g.winner === "Watcher", "being processed is");
}
{
  const g = build({ humanPrisoner: 0 });
  const p = g.prisoners[0];
  p.custody = 1;
  p.items = [ITEM_KINDS.SHIM];
  useItem(g, ITEM_KINDS.SHIM, null);
  endPrisonerTurn(g);
  endWatcherTurn(g);
  check(!isOver(g) && p.alive && !p.custody, "getting out on the last turn saves the run");
}

// ---- 13. The clock still terminates --------------------------------------
// Custody adds a state a prisoner can sit in; it must not be one they can sit
// in forever, or the round limit is the only thing left holding the game up.
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners.forEach((p) => (p.custody = CUSTODY_TURNS));
  let turns = 0;
  while (!isOver(g) && turns++ < 5000) {
    endPrisonerTurn(g);
    if (isOver(g)) break;
    endWatcherTurn(g);
  }
  check(isOver(g), `a board where everyone is held still resolves (${turns} half-turns)`);
  check(g.round < ROUND_LIMIT, "and resolves on the custody clock, not the round limit");
}

console.log(ok ? "\n✓ custody passed" : "\n✗ custody failed");
process.exit(ok ? 0 : 1);
