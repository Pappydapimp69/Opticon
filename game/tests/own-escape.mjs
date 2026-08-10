// own-escape.mjs — Your win has to be YOUR escape.
//
// Reported from play: "I won as a prisoner without reaching the gate myself."
// checkEndConditions ended the game on `prisoners.some(p => p.escaped)`, so an
// AI companion walking through the gate closed the game as a Prisoner win —
// the human could be standing in a cell across the map and still be told they
// slipped past the eye. Companions are cover and company, not a bus out.
//
// The rule now grades a human prisoner by their OWN fate, and falls back to
// the institutional "any escape beats the tower" only when nobody down there
// is the player (i.e. the human is in the Watcher seat).
// Run: node game/tests/own-escape.mjs
import { generateMap, MAP_DEFAULTS } from "../src/map.js";
import { createGame, isOver, endPrisonerTurn, endWatcherTurn, ROUND_LIMIT } from "../src/rules.js";

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}

const build = (opts = {}) => {
  const map = generateMap(12345, { ...MAP_DEFAULTS, prisonerCount: 3 });
  return createGame(map, { watcherFacing: 0, prisoners: map.spawns, ...opts });
};
// checkEndConditions is private. A full round handover is the cheapest public
// path that runs it without moving anybody or firing a scan — and it is the
// path a real game takes, so what it settles is what a player would see.
// Costs one round, which the clock tests below account for.
const settle = (g) => {
  endPrisonerTurn(g);
  endWatcherTurn(g);
};

// ---- 1. A companion's escape is not your win -----------------------------
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners[1].escaped = true;
  settle(g);
  check(!isOver(g), "a companion reaching the gate does not end the game");
  check(g.winner === null, "and does not award the human a win");
  check(g.prisoners[0].alive && !g.prisoners[0].escaped, "the human is still in play, where they left themselves");
}

// ---- 2. A companion's capture is not your loss ---------------------------
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners[1].alive = false;
  g.prisoners[2].alive = false;
  settle(g);
  check(!isOver(g), "losing both companions does not end the game either");
  check(g.winner === null, "the human's own run is still live");
}

// ---- 3. Your escape IS your win ------------------------------------------
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners[0].escaped = true;
  settle(g);
  check(g.status === "escaped" && g.winner === "Prisoner", "the human reaching the gate wins");
}

// ---- 4. Your capture IS your loss, even with the group still running -----
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners[0].alive = false;
  settle(g);
  check(g.status === "captured" && g.winner === "Watcher",
    "the human being taken loses, even with two companions still free");
}

// ---- 5. Escaping first, then the rest of the group, still reads as a win --
// Order must not matter: a companion out early must not poison the result.
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners[2].escaped = true;
  settle(g);
  check(!isOver(g), "companion out first: still playing");
  g.prisoners[0].escaped = true;
  settle(g);
  check(g.winner === "Prisoner", "then the human gets out: win");
}

// ---- 6. Watcher seat: the institutional rule is unchanged ----------------
// With no human prisoner there is no individual fate to grade, so a single
// escape is still the Watcher's failure — they have to run the whole table.
{
  const g = build({ humanPrisoner: null });
  check(g.humanPrisoner === null, "watcher-seat games carry no human prisoner");
  g.prisoners[1].escaped = true;
  settle(g);
  check(g.status === "escaped" && g.winner === "Prisoner",
    "one AI prisoner escaping still beats a human Watcher");
}
{
  const g = build({ humanPrisoner: null });
  g.prisoners.forEach((p) => (p.alive = false));
  settle(g);
  check(g.status === "captured" && g.winner === "Watcher", "catching all three wins for the Watcher");
}

// ---- 7. An empty board still resolves, human seat or not -----------------
// Defensive: the "nobody left in play" branch must not leave a game hung on
// "playing" forever if some other path retires the last prisoner.
{
  const g = build({ humanPrisoner: null });
  g.prisoners[0].escaped = true;
  g.prisoners[1].alive = false;
  g.prisoners[2].alive = false;
  settle(g);
  check(isOver(g), "a board with nobody left in play is over");
}

// ---- 8. The round limit still bites, and still favours the tower ---------
{
  const g = build({ humanPrisoner: 0 });
  g.round = ROUND_LIMIT; // settle() ticks it past the limit
  settle(g);
  check(g.status === "captured" && g.winner === "Watcher" && g.timedOut,
    `running out the ${ROUND_LIMIT}-round clock loses`);
}
// ...but a human already through the gate is not retroactively timed out.
{
  const g = build({ humanPrisoner: 0 });
  g.prisoners[0].escaped = true;
  g.round = ROUND_LIMIT; // settle() ticks it past the limit
  settle(g);
  check(g.winner === "Prisoner" && !g.timedOut, "an escape beats the clock, not the other way round");
}

// ---- 9. Hotseat (a single prisoner) is unaffected ------------------------
{
  const map = generateMap(999, { ...MAP_DEFAULTS, prisonerCount: 1 });
  const g = createGame(map, { watcherFacing: 0, prisoners: map.spawns, humanPrisoner: 0 });
  check(g.prisoners.length === 1, "hotseat runs one prisoner");
  g.prisoners[0].escaped = true;
  settle(g);
  check(g.winner === "Prisoner", "the lone prisoner escaping wins");
}

// ---- 10. A full game still terminates -------------------------------------
// The old rule ended most games early on the first companion out. With that
// gone, a game where the human simply never moves must still resolve — via
// capture or the clock — rather than running forever.
{
  const g = build({ humanPrisoner: 0 });
  let turns = 0;
  while (!isOver(g) && turns++ < 5000) {
    endPrisonerTurn(g);
    if (isOver(g)) break;
    endWatcherTurn(g);
  }
  check(isOver(g), `a passive human prisoner's game still ends (${turns} half-turns)`);
  check(g.winner === "Watcher", "and standing still loses it");
}

console.log(ok ? "\n✓ own-escape passed" : "\n✗ own-escape failed");
process.exit(ok ? 0 : 1);
