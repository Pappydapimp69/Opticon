// Balance harness: plays complete MIRAGE runs headlessly with a scripted lead and
// reports the outcome distribution. Run: node mirage/tests/balance.mjs [seeds]
//
// Why whole runs and not step assertions: reachability/outcome is a distinct test
// axis from step-correctness. A sim can be right at every step and still produce a
// game that cannot be finished — the only way to see that is to drive runs to a
// terminal state and look at the spread.
//
// What it asserts (deliberately narrow):
//   1. EVERY run terminates and records an ending.
//   2. COMPLETABILITY — some reasonable policy finishes most standard seeds.
//   3. PRESSURE — the hardest tier is not a walkover for every policy.
// What it only REPORTS: the careful-vs-reckless gap, and the per-tier rates. A
// scripted bot is a completability oracle, not a difficulty oracle: it reads the
// sim's truth directly, so the hallucination layer — which is the entire
// difficulty for a human who is shown markers that do not exist and told by their
// own party that everything is fine — costs it almost nothing.

import { createRun, tick, logMarker, trueLogCount, debrief, LOG_RADIUS, PYLON_RADIUS } from "../src/state.js";
import { findPath, worldToCell, cellToWorld, floodFill, GRID } from "../src/world.js";

const SEEDS = Number(process.argv[2] || 40);
const DT = 1 / 20;

// A coarse lattice of sweep waypoints over the reachable floor. The bot has to
// SEARCH the basin — it is not allowed to route to a marker it has not sighted,
// because a bot with the answer key measures nothing about whether the area is
// explorable in the time given.
function sweepPoints(sim) {
  const reach = floodFill(sim.world.blocked, sim.world.camp.cx, sim.world.camp.cz);
  const pts = [];
  const stride = 7;
  for (let cz = 3; cz < GRID - 3; cz += stride) {
    for (let cx = 3; cx < GRID - 3; cx += stride) {
      // Snap to a reachable cell in the neighbourhood of the lattice point.
      let found = null;
      for (let r = 0; r <= 3 && !found; r++) {
        for (let dz = -r; dz <= r && !found; dz++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            const nx = cx + dx, nz = cz + dz;
            if (nx > 0 && nz > 0 && nx < GRID - 1 && nz < GRID - 1 && reach[nz * GRID + nx]) found = { cx: nx, cz: nz };
          }
        }
      }
      if (found) pts.push({ ...found, ...cellToWorld(found.cx, found.cz), visited: false });
    }
  }
  return pts;
}

/**
 * Drive one run to a terminal state.
 * @param policy "careful" | "reckless" — see the constants below
 */
function playRun(seed, policy, difficulty = "standard") {
  const sim = createRun({ seed, difficulty });
  const sweep = sweepPoints(sim);
  const cooldown = new Map(); // pylon id -> sim time it becomes selectable again
  let path = null;
  let goal = null;
  let goalKind = null;
  let repath = 0;

  // Two policies, both plausible readings of how to play:
  //   careful  — detour to relief only once somebody is actually breaking
  //              (brittle or gone), then top up and move on
  //   reckless — never stop for anyone; sweep, survey, go home
  // An earlier "cautious" policy detoured whenever anyone dropped below the
  // FRAYING line and rested until the worst member was nearly full. It lost 100%
  // of runs to the light limit — but that measured the policy, not the game: it
  // spent its entire day resting because someone in a six-person party is always
  // below that line. It is recorded here as a negative result, not kept.
  const REST_TRIGGER = 16; // brittle
  const REST_TARGET = 60;
  const REST_CAP = 20; // seconds per visit

  const pickGoal = () => {
    const partyWorst = Math.min(...sim.companions.map((c) => (c.hallucinating ? 0 : c.lucidity)));
    const selfLow = sim.player.lucidity < 25 || sim.player.hallucinating;
    if (policy === "careful" && (partyWorst < REST_TRIGGER || selfLow)) {
      // A pylon we have just finished using is on cooldown. Without this the bot
      // oscillates: "someone in the party is low" keeps selecting the pylon we
      // are standing in, while "nobody IN RANGE still needs it" keeps abandoning
      // it — a companion who is low but far away satisfies both forever.
      const live = sim.pylons.filter((p) => p.charge > 25 && (cooldown.get(p.id) || 0) < sim.time);
      if (live.length) {
        const p = live.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
        return { target: p, kind: "pylon" };
      }
    }
    // Only DISCOVERED markers are legitimate destinations.
    const todo = sim.monoliths.filter((m) => m.discovered && !m.logged);
    if (todo.length) {
      const m = todo.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
      return { target: m, kind: "marker" };
    }
    if (trueLogCount(sim) >= sim.monoliths.length) return { target: sim.world.camp, kind: "camp" };
    // Nothing in hand: keep sweeping the basin for the ones still out there.
    const next = sweep.filter((p) => !p.visited);
    if (next.length) {
      const p = next.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
      return { target: p, kind: "sweep" };
    }
    for (const p of sweep) p.visited = false; // second lap
    return { target: sim.world.camp, kind: "camp" };
  };

  let restUntil = 0;
  // Watchdog. Several branches below re-decide without advancing the sim (goal
  // reached, goal abandoned), which is correct but means a policy bug can spin
  // forever without the clock moving — and a hanging test is far worse than a
  // failing one. Any long stretch of decisions with no tick is a bug here.
  let spins = 0;
  let ticksDone = 0;
  const guard = () => {
    if (++spins > 500) {
      throw new Error(
        `balance bot spun ${spins} decisions without ticking (seed ${seed}, ${policy}, ` +
          `goal=${goalKind}, t=${sim.time.toFixed(1)}s, ticks=${ticksDone})`,
      );
    }
  };
  const step = (input) => {
    tick(sim, DT, input);
    ticksDone++;
    spins = 0;
  };

  while (sim.status === "playing") {
    guard();
    repath -= DT;
    if (!goal || repath <= 0) {
      const g = pickGoal();
      if (!goal || g.kind !== goalKind || dist(g.target, goal) > 1) {
        goal = g.target;
        goalKind = g.kind;
        path = null;
      }
      repath = 1.0;
    }

    if (goalKind === "sweep" && dist(goal, sim.player) < 4) {
      goal.visited = true;
      goal = null;
      continue;
    }

    // Sitting in a pylon: hold position until the party is topped up (or the
    // pylon gives out), which is the whole cost of the careful policy. Bounded,
    // because "rest forever" is otherwise the bot's dominant move and it turns
    // every run into a light-limit loss that says nothing about the design.
    if (goalKind === "pylon" && dist(goal, sim.player) < PYLON_RADIUS * 0.6) {
      const inRange = sim.party.filter((c) => dist(goal, c) <= PYLON_RADIUS);
      const worst = Math.min(...inRange.map((c) => (c.hallucinating ? 0 : c.lucidity)), 100);
      if (!restUntil) restUntil = sim.time + REST_CAP;
      if ((worst < REST_TARGET || inRange.some((c) => c.hallucinating)) && goal.charge > 1 && sim.time < restUntil) {
        step({ move: { x: 0, z: 0 }, yaw: sim.player.yaw });
        continue;
      }
      restUntil = 0;
      cooldown.set(goal.id, sim.time + 25);
      goal = null;
      continue;
    }

    if (goalKind === "marker" && dist(goal, sim.player) <= LOG_RADIUS * 0.85) {
      logMarker(sim);
      goal = null;
      step({ move: { x: 0, z: 0 }, yaw: sim.player.yaw });
      continue;
    }

    // Walk the BFS path toward the current goal. `null` means "not computed";
    // an empty array is a computed answer and must not trigger a recompute every
    // tick (see the same distinction in party.js).
    if (path === null) {
      path = findPath(sim.world, worldToCell(sim.player.x, sim.player.z), worldToCell(goal.x, goal.z)) || [];
      if (!path.length) path = [worldToCell(goal.x, goal.z)]; // already in the goal cell
    }
    // Path exhausted: steer straight at the goal for the last few metres.
    const node = path[0];
    const aim = node ? cellToWorld(node.cx, node.cz) : goal;
    const dx = aim.x - sim.player.x;
    const dz = aim.z - sim.player.z;
    const len = Math.hypot(dx, dz) || 1;
    if (len < 1.2) path.shift();
    const yaw = Math.atan2(dx, -dz);
    step({ move: { x: dx / len, z: dz / len }, run: true, yaw });

    // Camp goal with the survey done: the win check needs bodies at camp, and the
    // companions arrive by following, so just keep standing there.
    if (goalKind === "camp" && dist(sim.world.camp, sim.player) < 4) {
      step({ move: { x: 0, z: 0 }, yaw });
    }
  }
  return debrief(sim);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function summarise(label, reports) {
  const n = reports.length;
  const wins = reports.filter((r) => r.status === "won").length;
  const dissolved = reports.filter((r) => r.ending === "dissolved").length;
  const dark = reports.filter((r) => r.ending === "darkness").length;
  const avg = (f) => (reports.reduce((s, r) => s + f(r), 0) / n).toFixed(1);
  const goneSecs = reports.map((r) => r.party.reduce((s, p) => s + p.goneSeconds, 0));
  console.log(
    `${label.padEnd(11)} n=${n}  won ${String(wins).padStart(3)} (${String(((wins / n) * 100).toFixed(0)).padStart(3)}%)` +
      `  dissolved ${dissolved}  dark ${dark}` +
      `  found ${avg((r) => r.found)}/6  logged ${avg((r) => r.logged)}/6  false ${avg((r) => r.falseLogs)}` +
      `  time ${avg((r) => r.time)}s  party-seconds-lost ${(goneSecs.reduce((a, b) => a + b, 0) / n).toFixed(0)}`,
  );
  return { n, wins, dissolved, dark, winRate: wins / n };
}

console.log(`MIRAGE balance — ${SEEDS} seeds per policy\n`);

const careful = [];
const reckless = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  careful.push(playRun(seed, "careful"));
  reckless.push(playRun(seed, "reckless"));
}

const c = summarise("careful", careful);
const r = summarise("reckless", reckless);
console.log("");
const bleak = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) bleak.push(playRun(seed, "careful", "bleak"));
const b = summarise("bleak/care", bleak);
const bleakReck = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) bleakReck.push(playRun(seed, "reckless", "bleak"));
const br = summarise("bleak/reck", bleakReck);
const gentle = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) gentle.push(playRun(seed, "careful", "gentle"));
summarise("gentle/care", gentle);

// ---- assertions ------------------------------------------------------------
const problems = [];

// 1. Termination. `playRun` only exits when status leaves "playing", so a
//    non-terminating run would hang rather than fail — the real check is that
//    every report carries an ending.
for (const rep of [...careful, ...reckless, ...bleak, ...bleakReck]) {
  if (!rep.ending) problems.push(`a run finished with no ending recorded: ${JSON.stringify(rep.status)}`);
}

// 2. Completability. The basin must be surveyable and returnable-from inside the
//    daylight, by SOME reasonable policy, on most seeds. This is the claim this
//    harness is actually entitled to make.
const best = Math.max(c.winRate, r.winRate);
if (best < 0.6) {
  problems.push(`no policy wins more than ${(best * 100).toFixed(0)}% of standard seeds — the basin is not reliably completable`);
}

// 3. Pressure. The hardest tier must not be a walkover for every policy.
if (Math.min(b.winRate, br.winRate) === 1) {
  problems.push("both policies won every bleak run — the hard tier applies no pressure");
}

console.log("");
console.log(
  `note: careful ${(c.winRate * 100).toFixed(0)}% vs reckless ${(r.winRate * 100).toFixed(0)}% is REPORTED, not asserted. ` +
    `Two policies on one seed diverge the moment they act differently, which re-rolls every\n` +
    `      later draw, so the gap is descriptive rather than a controlled measurement. And a bot ` +
    `is a valid oracle for COMPLETABILITY only: it reads the sim's truth\n` +
    `      directly, so the hallucination layer — the actual difficulty for a human, who sees ` +
    `phantom markers and gets lied to by their own party — costs it almost\n` +
    `      nothing. Do not read these win rates as human difficulty.`,
);

if (problems.length) {
  console.log("\nFAILED:");
  for (const p of problems) console.log("  ✗ " + p);
  process.exit(1);
}
console.log("\nmirage balance: OK");
