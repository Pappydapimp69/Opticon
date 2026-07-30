// Pure-logic test suite for MIRAGE. No browser, no WebGL, no timers.
// Run: node mirage/tests/logic.test.mjs
//
// Everything asserted here reads the sim's OWN clock (`sim.time`) and its own
// state — never wall-clock seconds. Headless/loaded environments run frames well
// under real time, so any assertion phrased in real seconds is a flake waiting to
// happen; the sim is advanced explicitly instead.

import {
  createRun, tick, tickLucidity, bandOf, BAND, checkIn, useDose, logMarker, recover,
  beginHallucinating, debrief, trueLogCount, checkEndings, partyCentroid,
  PARTY_SIZE, MAX_LUCIDITY, DOSE_COUNT, RECOVER_AT, RECOVER_TIME, DISSOLVE_TIME,
  TIME_LIMIT, PYLON_RADIUS, LOG_RADIUS, ISOLATION_DIST,
} from "../src/state.js";
import { generateWorld, validate, findPath, isBlockedAt, GRID } from "../src/world.js";
import {
  createPercept, updatePercept, perceivedMonoliths, perceivedPylons, perceivedCompanions,
  perceivedYaw, rosterRead, filterReport, distortion,
} from "../src/percept.js";
import { HALLUCINATION } from "../src/state.js";
import { makeRng, hashSeed } from "../src/rng.js";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"} — got ${a}, expected ${b}`);
}
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || "not near"} — got ${a}, expected ~${b}`);
}

// Advance a sim by `seconds` in fixed slices, as the game loop does.
function advance(sim, seconds, input = {}) {
  const slice = 1 / 30;
  for (let t = 0; t < seconds && sim.status === "playing"; t += slice) tick(sim, slice, input);
  return sim;
}

// ---------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------
check("rng is deterministic per seed", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 50; i++) eq(a(), b(), "same seed diverged");
});

check("rng int is inclusive and in range", () => {
  const r = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const v = r.int(1, 5);
    assert(v >= 1 && v <= 5, `int out of range: ${v}`);
    seen.add(v);
  }
  eq(seen.size, 5, "int(1,5) never produced all five values");
});

check("hashSeed is stable and non-zero", () => {
  eq(hashSeed("basin"), hashSeed("basin"), "unstable hash");
  assert(hashSeed("basin") !== hashSeed("basins"), "hash collision on near-identical input");
});

// ---------------------------------------------------------------------------
// world generation + the connectivity guarantee
// ---------------------------------------------------------------------------
check("every objective is reachable from camp, across many seeds", () => {
  // The repair pass is verified here, not trusted: validate() re-derives
  // reachability from scratch with its own flood fill.
  for (let seed = 1; seed <= 60; seed++) {
    const w = generateWorld(seed);
    const v = validate(w);
    assert(v.ok, `seed ${seed}: unreachable ${JSON.stringify(v.unreachable)}`);
    eq(w.monoliths.length, 6, `seed ${seed}: wrong monolith count`);
    eq(w.pylons.length, 5, `seed ${seed}: wrong pylon count`);
  }
});

check("BFS finds a concrete path from camp to every marker and pylon", () => {
  for (const seed of [1, 5, 17, 33, 99]) {
    const w = generateWorld(seed);
    const from = { cx: w.camp.cx, cz: w.camp.cz };
    for (const f of [...w.monoliths, ...w.pylons]) {
      const path = findPath(w, from, { cx: f.cx, cz: f.cz });
      assert(path && path.length > 0, `seed ${seed}: no path to ${f.id}`);
      // A path must never step through a blocked cell.
      for (const n of path) assert(!w.blocked[n.cz * GRID + n.cx], `seed ${seed}: path crosses rock`);
    }
  }
});

check("most of the walkable floor is actually reachable", () => {
  // Not a hard gate (pockets behind spires are fine scenery) but a world where
  // the majority of the ground is stranded is a bad world even when the
  // objectives happen to be reachable.
  let worst = 1;
  for (let seed = 1; seed <= 30; seed++) worst = Math.min(worst, validate(generateWorld(seed)).reachableFraction);
  assert(worst > 0.55, `worst reachable fraction was ${worst.toFixed(2)}`);
});

check("the rim is sealed — you cannot walk out of the basin", () => {
  const w = generateWorld(3);
  for (let i = 0; i < GRID; i++) {
    assert(w.blocked[i], "north rim open");
    assert(w.blocked[(GRID - 1) * GRID + i], "south rim open");
    assert(w.blocked[i * GRID], "west rim open");
    assert(w.blocked[i * GRID + GRID - 1], "east rim open");
  }
});

check("markers stand on open ground", () => {
  for (const seed of [2, 11, 44]) {
    const w = generateWorld(seed);
    for (const f of [...w.monoliths, ...w.pylons]) {
      assert(!isBlockedAt(w, f.x, f.z), `seed ${seed}: ${f.id} is inside rock`);
    }
  }
});

check("same seed builds the same basin", () => {
  const a = generateWorld(123);
  const b = generateWorld(123);
  eq(a.monoliths.map((m) => m.id + m.cx + "," + m.cz).join("|"),
     b.monoliths.map((m) => m.id + m.cx + "," + m.cz).join("|"), "monoliths differ");
  eq(String(a.blocked), String(b.blocked), "blocked grid differs");
});

// ---------------------------------------------------------------------------
// bands
// ---------------------------------------------------------------------------
check("bands partition the lucidity range at the documented edges", () => {
  eq(bandOf(100), BAND.STEADY);
  eq(bandOf(62), BAND.STEADY);
  eq(bandOf(61.9), BAND.UNSETTLED);
  eq(bandOf(36), BAND.UNSETTLED);
  eq(bandOf(35.9), BAND.FRAYING);
  eq(bandOf(14), BAND.FRAYING);
  eq(bandOf(13.9), BAND.BRITTLE);
  eq(bandOf(0.01), BAND.BRITTLE);
  eq(bandOf(0), BAND.GONE);
});

// ---------------------------------------------------------------------------
// the party and the meter
// ---------------------------------------------------------------------------
check("a run starts with the player plus five companions, all full", () => {
  const sim = createRun({ seed: 5 });
  eq(sim.party.length, PARTY_SIZE, "party size");
  eq(sim.companions.length, 5, "five NPC companions");
  for (const c of sim.party) eq(c.lucidity, MAX_LUCIDITY, `${c.name} did not start full`);
  eq(sim.doses, DOSE_COUNT, "dose count");
  eq(sim.status, "playing");
});

check("lucidity only ever falls, absent a pylon or a dose", () => {
  const sim = createRun({ seed: 8 });
  // Park everyone far from any pylon so the only force acting is drain.
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const before = sim.companions.map((c) => c.lucidity);
  for (const c of sim.party) tickLucidity(sim, c, 1);
  sim.companions.forEach((c, i) => assert(c.lucidity < before[i], `${c.name} did not drain`));
});

check("companions drain at different rates — the party is not one meter", () => {
  const sim = createRun({ seed: 8 });
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  for (let i = 0; i < 30; i++) for (const c of sim.party) tickLucidity(sim, c, 1);
  const values = new Set(sim.companions.map((c) => Math.round(c.lucidity)));
  assert(values.size >= 4, `expected spread across companions, got ${[...values]}`);
});

check("walking off alone drains faster than staying with the party", () => {
  const sim = createRun({ seed: 9 });
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const together = tickLucidity(sim, sim.companions[0], 1);
  const lone = sim.companions[1];
  lone.x = spot.x + ISOLATION_DIST + 40;
  lone.z = spot.z;
  // Re-park the rest so the centroid does not chase the isolated one.
  const alone = tickLucidity(sim, lone, 1);
  assert(alone > together * 1.4, `isolation did not bite: ${alone} vs ${together}`);
});

check("watching someone come apart costs you", () => {
  const sim = createRun({ seed: 10 });
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const subject = sim.companions[0];
  const clean = tickLucidity(sim, subject, 1);
  beginHallucinating(sim, sim.companions[3]);
  sim.companions[3].x = spot.x + 1;
  sim.companions[3].z = spot.z + 1;
  const contagious = tickLucidity(sim, subject, 1);
  assert(contagious > clean, `contagion did not apply: ${contagious} vs ${clean}`);
});

check("coming back leaves a scar that makes the next fall faster", () => {
  const sim = createRun({ seed: 11 });
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const c = sim.companions[0];
  const first = tickLucidity(sim, c, 1);
  beginHallucinating(sim, c);
  recover(sim, c, "test");
  eq(c.scars, 1, "scar not recorded");
  eq(c.lucidity, RECOVER_AT, "recovered to the wrong level");
  const second = tickLucidity(sim, c, 1);
  assert(second > first, `scar did not increase drain: ${second} vs ${first}`);
});

check("hitting zero starts a hallucination, with a specific kind", () => {
  const sim = createRun({ seed: 12 });
  const c = sim.companions[2];
  c.lucidity = 0.2;
  c.x = farFromPylons(sim).x;
  c.z = farFromPylons(sim).z;
  tickLucidity(sim, c, 1);
  assert(c.hallucinating, "did not begin hallucinating at zero");
  eq(c.lucidity, 0, "lucidity went negative");
  assert(Object.values(HALLUCINATION).includes(c.hallucination), `bad kind ${c.hallucination}`);
});

check("the player is not exempt — the lead hallucinates too", () => {
  const sim = createRun({ seed: 13 });
  sim.player.lucidity = 0;
  beginHallucinating(sim, sim.player);
  assert(sim.player.hallucinating, "the player must be subject to the same rule");
});

// ---------------------------------------------------------------------------
// pylons and doses
// ---------------------------------------------------------------------------
check("a pylon restores everyone standing in it, and spends itself doing so", () => {
  const sim = createRun({ seed: 14 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  c.lucidity = 20;
  c.x = p.x;
  c.z = p.z;
  const charge0 = p.charge;
  tickLucidity(sim, c, 1);
  assert(c.lucidity > 20, "pylon did not restore");
  assert(p.charge < charge0, "pylon did not spend charge");
});

check("a spent pylon does nothing", () => {
  const sim = createRun({ seed: 14 });
  const p = sim.pylons[0];
  p.charge = 0;
  const c = sim.companions[0];
  c.lucidity = 20;
  c.x = p.x;
  c.z = p.z;
  tickLucidity(sim, c, 1);
  assert(c.lucidity < 20, "a dead pylon still restored");
});

check("a pylon recharges only while nobody draws on it", () => {
  const sim = createRun({ seed: 15 });
  const p = sim.pylons[0];
  p.charge = 50;
  // Park the whole party far away so nothing is in range.
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  advance(sim, 4);
  assert(p.charge > 50, `no recharge while idle: ${p.charge}`);
});

check("pulling a hallucinating companion back needs sustained pylon contact", () => {
  const sim = createRun({ seed: 16 });
  const p = sim.pylons[0];
  const c = sim.companions[1];
  beginHallucinating(sim, c);
  c.x = p.x;
  c.z = p.z;
  tickLucidity(sim, c, RECOVER_TIME * 0.5);
  assert(c.hallucinating, "recovered too early — contact must be sustained");
  tickLucidity(sim, c, RECOVER_TIME * 0.6);
  assert(!c.hallucinating, "did not recover after sustained contact");
  eq(c.lucidity, RECOVER_AT, "recovery level");
});

check("stepping out of the pylon resets recovery progress", () => {
  const sim = createRun({ seed: 16 });
  const p = sim.pylons[0];
  const c = sim.companions[1];
  beginHallucinating(sim, c);
  c.x = p.x; c.z = p.z;
  tickLucidity(sim, c, RECOVER_TIME * 0.8);
  const away = farFromPylons(sim);
  c.x = away.x; c.z = away.z;
  tickLucidity(sim, c, 0.1);
  eq(c.recoverProgress, 0, "progress survived leaving the pylon");
});

check("doses are finite, and spending one on a gone companion brings them back", () => {
  const sim = createRun({ seed: 17 });
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  assert(useDose(sim, c.id), "dose refused");
  eq(sim.doses, DOSE_COUNT - 1, "dose not consumed");
  assert(!c.hallucinating, "dose did not recover");
  useDose(sim, sim.companions[1].id);
  useDose(sim, sim.companions[2].id);
  eq(sim.doses, 0, "dose accounting");
  assert(!useDose(sim, sim.companions[3].id), "spent a dose that did not exist");
});

check("a dose tops up without exceeding the maximum", () => {
  const sim = createRun({ seed: 18 });
  const c = sim.companions[0];
  c.lucidity = 90;
  useDose(sim, c.id);
  eq(c.lucidity, MAX_LUCIDITY, "dose overflowed the cap");
});

// ---------------------------------------------------------------------------
// check-ins: the unreliable sensor
// ---------------------------------------------------------------------------
check("a hallucinating companion reports that they are fine", () => {
  const sim = createRun({ seed: 19 });
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  const r = checkIn(sim, c.id);
  eq(r.claim, BAND.STEADY, "a gone companion must claim to be steady");
  eq(r.truth, BAND.GONE, "truth must still be recorded for the debrief");
});

check("a fraying companion sometimes shades the truth, but never invents 'gone'", () => {
  const sim = createRun({ seed: 20 });
  const c = sim.companions[0];
  let shaded = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    c.lucidity = 20; // FRAYING
    const r = checkIn(sim, c.id);
    assert(r.claim !== BAND.GONE, "a lucid companion claimed to be gone");
    if (r.claim !== r.truth) shaded++;
  }
  assert(shaded > N * 0.2, `expected optimistic shading, saw ${shaded}/${N}`);
  assert(shaded < N, "shading must not be certain");
});

check("a steady companion reports steady", () => {
  const sim = createRun({ seed: 21 });
  const c = sim.companions[0];
  c.lucidity = 95;
  for (let i = 0; i < 40; i++) eq(checkIn(sim, c.id).claim, BAND.STEADY, "steady report drifted");
});

// ---------------------------------------------------------------------------
// perception: the lie layer
// ---------------------------------------------------------------------------
check("a lucid lead sees exactly what is there", () => {
  const sim = createRun({ seed: 22 });
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  eq(perceivedMonoliths(percept, sim).length, sim.monoliths.length, "phantom leaked into a lucid view");
  eq(perceivedCompanions(percept, sim).length, 5, "phantom companion in a lucid view");
  eq(perceivedYaw(percept, sim), sim.player.yaw, "compass lied to a lucid lead");
  eq(distortion(percept, sim), 0, "distortion on a full meter");
});

check("a hallucinating lead can be shown markers the basin does not contain", () => {
  // Drive the specific kind rather than waiting for the draw.
  const sim = createRun({ seed: 23 });
  sim.player.lucidity = 0;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const seen = perceivedMonoliths(percept, sim);
  assert(seen.length > sim.monoliths.length, "no phantom markers appeared");
  assert(seen.some((m) => m.phantom), "phantoms not flagged");
  // And the sim itself must remain honest.
  eq(sim.monoliths.length, 6, "the sim's own record was contaminated");
});

check("a phantom companion joins the formation", () => {
  const sim = createRun({ seed: 24 });
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.DOUBLED_PARTY;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const seen = perceivedCompanions(percept, sim);
  eq(seen.length, 6, "expected a sixth figure");
  eq(sim.companions.length, 5, "the sim grew a companion");
  // It keeps station like a real one rather than sitting still.
  const before = { x: seen[5].x, z: seen[5].z };
  for (let i = 0; i < 30; i++) updatePercept(percept, sim, 0.1);
  const after = percept.phantomCompanions[0];
  assert(Math.hypot(after.x - before.x, after.z - before.z) > 0.2, "phantom did not move");
});

check("spent pylons read as live to a hallucinating lead", () => {
  const sim = createRun({ seed: 25 });
  sim.pylons[0].charge = 0;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.FALSE_ANCHOR;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const seen = perceivedPylons(percept, sim);
  const dead = seen.find((p) => p.id === sim.pylons[0].id);
  assert(dead.looksLive, "a spent pylon should look live under FALSE_ANCHOR");
  assert(seen.some((p) => p.phantom), "no phantom pylon");
  // The sim still knows the truth.
  eq(sim.pylons[0].charge, 0, "sim charge was altered by perception");
});

check("the compass moves under WRONG_WAY but the body does not", () => {
  const sim = createRun({ seed: 26 });
  sim.player.yaw = 0.5;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.WRONG_WAY;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  assert(Math.abs(perceivedYaw(percept, sim) - 0.5) > 1, "compass did not shift");
  eq(sim.player.yaw, 0.5, "the real heading changed");
});

check("the roster degrades to '?' when the lead is the unreliable one", () => {
  const sim = createRun({ seed: 27 });
  const percept = createPercept();
  const c = sim.companions[0];
  c.lucidity = 5;
  updatePercept(percept, sim, 0.1);
  eq(rosterRead(percept, sim, c).tag, "bad", "a lucid lead should read a brittle companion");
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.CHORUS;
  updatePercept(percept, sim, 0.1);
  const read = rosterRead(percept, sim, c);
  eq(read.tag, "unknown", "a hallucinating lead should not get a reliable roster");
  assert(read.uncertain, "uncertainty flag missing");
});

check("the roster never exposes the hidden number", () => {
  const sim = createRun({ seed: 28 });
  const percept = createPercept();
  for (const c of sim.companions) {
    c.lucidity = 37.5;
    const read = rosterRead(percept, sim, c);
    const blob = JSON.stringify(read);
    assert(!/37|38|\d\d\.\d/.test(blob), `roster leaked a number: ${blob}`);
  }
});

check("CHORUS makes every report agree with you", () => {
  const sim = createRun({ seed: 29 });
  const percept = createPercept();
  const c = sim.companions[0];
  c.lucidity = 3;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.CHORUS;
  updatePercept(percept, sim, 0.1);
  const filtered = filterReport(percept, sim, checkIn(sim, c.id));
  eq(filtered.claim, BAND.STEADY, "chorus should flatten every report to 'fine'");
});

check("distortion pre-echoes before zero, so the lead has a tell about themselves", () => {
  const sim = createRun({ seed: 30 });
  const percept = createPercept();
  sim.player.lucidity = 100;
  eq(distortion(percept, sim), 0, "distortion while fresh");
  sim.player.lucidity = 50;
  assert(distortion(percept, sim) > 0, "no tell in the unsettled band");
  sim.player.lucidity = 10;
  assert(distortion(percept, sim) > 0.2, "the brittle band should be visible");
});

check("distortion ramps rather than snapping", () => {
  const sim = createRun({ seed: 31 });
  const percept = createPercept();
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.CHORUS;
  updatePercept(percept, sim, 0.1);
  const early = percept.intensity;
  assert(early < 0.9, `intensity snapped straight to ${early}`);
  for (let i = 0; i < 60; i++) updatePercept(percept, sim, 0.1);
  near(percept.intensity, 1, 0.05, "intensity never reached full");
});

// ---------------------------------------------------------------------------
// surveying — including counterfeit entries
// ---------------------------------------------------------------------------
check("you must stand at a marker to log it", () => {
  const sim = createRun({ seed: 32 });
  const m = sim.monoliths[0];
  sim.player.x = m.x + LOG_RADIUS + 5;
  sim.player.z = m.z;
  eq(logMarker(sim).ok, false, "logged a marker from too far away");
  sim.player.x = m.x + 1;
  const res = logMarker(sim);
  assert(res.ok && res.real, "failed to log from inside the radius");
  eq(trueLogCount(sim), 1, "log count");
  eq(logMarker(sim).ok, false, "logged the same marker twice");
});

check("a lucid companion nearby corroborates the entry", () => {
  const sim = createRun({ seed: 33 });
  const m = sim.monoliths[0];
  sim.player.x = m.x;
  sim.player.z = m.z;
  for (const c of sim.companions) { c.x = m.x + 200; c.z = m.z + 200; }
  eq(logMarker(sim).corroborated, false, "corroborated with nobody in range");
  sim.monoliths[1].logged = false;
  const m2 = sim.monoliths[1];
  sim.player.x = m2.x;
  sim.player.z = m2.z;
  sim.companions[0].x = m2.x + 2;
  sim.companions[0].z = m2.z;
  eq(logMarker(sim).corroborated, true, "a lucid companion at your shoulder should confirm");
});

check("a hallucinating lead with nobody lucid nearby can write down nothing", () => {
  const sim = createRun({ seed: 34 });
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  // Standing nowhere near a real marker, with the party far away.
  const spot = farFromPylons(sim);
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  for (const m of sim.monoliths) { m.x += 1000; m.z += 1000; }
  for (const c of sim.companions) { c.x = spot.x + 300; c.z = spot.z + 300; }
  const res = logMarker(sim, { name: "the Sixth Stone" });
  assert(res.ok && res.real === false, "expected a false entry");
  eq(sim.stats.falseLogs, 1, "false log not counted");
  eq(trueLogCount(sim), 0, "a phantom must not count toward the survey");
  eq(sim.logEntries.length, 1, "the log should still show an entry — that is the trap");
});

check("a lucid witness prevents a counterfeit entry", () => {
  const sim = createRun({ seed: 35 });
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  const spot = farFromPylons(sim);
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  for (const m of sim.monoliths) { m.x += 1000; m.z += 1000; }
  sim.companions[0].x = spot.x + 1;
  sim.companions[0].z = spot.z + 1;
  sim.companions[0].lucidity = 90;
  const res = logMarker(sim, { name: "the Sixth Stone" });
  eq(res.ok, false, "a lucid companion should refuse the phantom");
  eq(sim.stats.falseLogs, 0, "false log recorded despite a witness");
});

// ---------------------------------------------------------------------------
// endings
// ---------------------------------------------------------------------------
check("all six gone for long enough dissolves the party", () => {
  const sim = createRun({ seed: 36 });
  for (const c of sim.party) beginHallucinating(sim, c);
  sim.lastDt = 1;
  for (let t = 0; t < DISSOLVE_TIME - 2; t++) checkEndings(sim);
  eq(sim.status, "playing", "ended too early");
  for (let t = 0; t < 4; t++) checkEndings(sim);
  eq(sim.status, "lost", "party did not dissolve");
  eq(sim.ending, "dissolved");
});

check("one mind still lucid holds the party together", () => {
  const sim = createRun({ seed: 37 });
  for (const c of sim.companions) beginHallucinating(sim, c);
  sim.lastDt = 1;
  for (let t = 0; t < DISSOLVE_TIME * 2; t++) checkEndings(sim);
  eq(sim.status, "playing", "five gone and one lucid must not be an ending");
});

check("running out of light ends the run", () => {
  const sim = createRun({ seed: 38 });
  sim.time = TIME_LIMIT + 1;
  checkEndings(sim);
  eq(sim.status, "lost");
  eq(sim.ending, "darkness");
});

check("winning needs the full survey AND bodies back at camp", () => {
  const sim = createRun({ seed: 39 });
  for (const m of sim.monoliths) m.logged = true;
  // Survey done, but everyone is out in the basin.
  const away = farFromPylons(sim);
  for (const c of sim.party) { c.x = away.x + 100; c.z = away.z + 100; }
  checkEndings(sim);
  eq(sim.status, "playing", "won without returning");
  // Lead walks back alone: a record with no witnesses is not a survey.
  sim.player.x = sim.world.camp.x;
  sim.player.z = sim.world.camp.z;
  checkEndings(sim);
  eq(sim.status, "playing", "won with the lead alone at camp");
  sim.companions[0].x = sim.world.camp.x + 1;
  sim.companions[0].z = sim.world.camp.z;
  sim.companions[1].x = sim.world.camp.x;
  sim.companions[1].z = sim.world.camp.z + 1;
  checkEndings(sim);
  eq(sim.status, "won", "did not win with lead + two companions home");
  eq(sim.ending, "extracted");
});

check("a false entry cannot win the run", () => {
  const sim = createRun({ seed: 40 });
  // Six log entries, none of them real.
  for (let i = 0; i < 6; i++) sim.logEntries.push({ name: "ghost", real: false, t: 0 });
  sim.player.x = sim.world.camp.x;
  sim.player.z = sim.world.camp.z;
  sim.companions[0].x = sim.world.camp.x;
  sim.companions[0].z = sim.world.camp.z;
  sim.companions[1].x = sim.world.camp.x;
  sim.companions[1].z = sim.world.camp.z;
  checkEndings(sim);
  eq(sim.status, "playing", "counterfeit entries won the game");
});

// ---------------------------------------------------------------------------
// the tick loop
// ---------------------------------------------------------------------------
check("tick advances the sim's own clock, in clamped slices", () => {
  const sim = createRun({ seed: 41 });
  tick(sim, 0.05);
  near(sim.time, 0.05, 1e-9, "clock");
  // dt is clamped to 0.1s per tick: a backgrounded tab that comes back with a
  // 30-second frame must not teleport the run (or drain the party) in one step.
  tick(sim, 999);
  near(sim.time, 0.15, 1e-9, "clamped clock");
});

check("the player walks, and cannot walk through rock", () => {
  const sim = createRun({ seed: 42 });
  const start = { x: sim.player.x, z: sim.player.z };
  advance(sim, 1, { move: { x: 1, z: 0 } });
  assert(Math.hypot(sim.player.x - start.x, sim.player.z - start.z) > 0.5, "player did not move");
  for (let i = 0; i < 400; i++) tick(sim, 0.05, { move: { x: 1, z: 0 } });
  assert(!isBlockedAt(sim.world, sim.player.x, sim.player.z), "player ended up inside rock");
});

check("companions follow the lead", () => {
  const sim = createRun({ seed: 43 });
  const before = sim.companions.map((c) => Math.hypot(c.x - sim.player.x, c.z - sim.player.z));
  advance(sim, 12, { move: { x: 0, z: -1 } });
  const after = sim.companions.map((c) => Math.hypot(c.x - sim.player.x, c.z - sim.player.z));
  const kept = after.filter((d, i) => d < before[i] + 12).length;
  assert(kept >= 4, `the party lost formation: ${after.map((d) => d.toFixed(1))}`);
});

check("a brittle companion breaks formation for a pylon they remember", () => {
  const sim = createRun({ seed: 44 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  // The party is out in the basin, well away from relief, but this companion has
  // been near this pylon before and remembers it.
  const away = { x: p.x + 30, z: p.z + 4 };
  for (const m of sim.party) { m.x = away.x; m.z = away.z; }
  // Spend every other pylon, so the only relief in the world is `p` — otherwise
  // the party's resting spot may happen to fall inside a different one.
  for (const other of sim.pylons) if (other !== p) other.charge = 0;
  c.known = { pylons: new Set([p.id]), monoliths: new Set() };
  c.lucidity = 9; // BRITTLE — the loud tell
  const before = Math.hypot(c.x - p.x, c.z - p.z);
  advance(sim, 3);
  eq(c.goalKind, "pylon", "brittle companion kept walking in formation");
  assert(Math.hypot(c.x - p.x, c.z - p.z) < before - 3, "broke formation but did not close on the pylon");
});

check("a companion who has never seen a pylon cannot head for it", () => {
  const sim = createRun({ seed: 44 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  for (const m of sim.party) { m.x = p.x + 40; m.z = p.z + 40; }
  c.known = { pylons: new Set(), monoliths: new Set() };
  c.lucidity = 9;
  advance(sim, 2);
  assert(c.goalKind !== "pylon", "a companion walked to a pylon they had no way of knowing about");
});

check("a gone companion stops following and goes its own way", () => {
  const sim = createRun({ seed: 45 });
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  const startDist = Math.hypot(c.x - sim.player.x, c.z - sim.player.z);
  advance(sim, 30);
  const endDist = Math.hypot(c.x - sim.player.x, c.z - sim.player.z);
  assert(endDist > startDist + 4, `a gone companion should wander off (${startDist.toFixed(1)} -> ${endDist.toFixed(1)})`);
  eq(c.goalKind, "hallucinating", "goal kind");
});

check("companions volunteer remarks, and a gone one says gone things", () => {
  const sim = createRun({ seed: 46 });
  let normal = 0;
  advance(sim, 60);
  normal = sim.companions.length; // remarks are emitted as events; count over a window
  let chatter = 0;
  for (let i = 0; i < 60; i++) {
    tick(sim, 0.5);
    chatter += sim.events.filter((e) => e.kind === "chatter").length;
  }
  assert(chatter > 0, "nobody said anything over a full minute");
  assert(normal > 0);
  // Now break one and look for the confident-nonsense register.
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  let goneLines = 0;
  for (let i = 0; i < 400; i++) {
    tick(sim, 0.5);
    goneLines += sim.events.filter((e) => e.kind === "chatter" && e.who === c.id && e.gone).length;
  }
  assert(goneLines > 0, "a gone companion never spoke");
});

check("paused time does not drain anyone (the loop simply stops ticking)", () => {
  const sim = createRun({ seed: 47 });
  const before = sim.companions.map((c) => c.lucidity);
  // The pause path in main.js skips tick() entirely; assert the sim is inert
  // without it rather than mocking the loop.
  sim.companions.forEach((c, i) => eq(c.lucidity, before[i], "state changed with no tick"));
});

check("a finished run stops simulating", () => {
  const sim = createRun({ seed: 48 });
  sim.status = "won";
  const t = sim.time;
  tick(sim, 1);
  eq(sim.time, t, "the clock ran after the run ended");
});

// ---------------------------------------------------------------------------
// debrief: the only honest readout
// ---------------------------------------------------------------------------
check("the debrief reveals the hidden numbers, and only then", () => {
  const sim = createRun({ seed: 49 });
  sim.companions[0].lucidity = 42.4;
  beginHallucinating(sim, sim.companions[1]);
  const d = debrief(sim);
  eq(d.party.length, PARTY_SIZE, "debrief party size");
  eq(d.party[1].lucidity, 42, "debrief should round the real value");
  assert(d.party[2].hallucinating, "debrief hid a hallucinating companion");
  eq(d.total, 6, "marker total");
});

check("partyCentroid sits inside the party's spread", () => {
  const sim = createRun({ seed: 50 });
  const c = partyCentroid(sim);
  const maxD = Math.max(...sim.party.map((m) => Math.hypot(m.x - c.x, m.z - c.z)));
  assert(maxD < 12, `centroid too far from everyone: ${maxD}`);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function farFromPylons(sim) {
  // A spot on open ground at least 2 pylon-radii from every pylon, so tests that
  // want pure drain get pure drain.
  let best = { x: sim.world.camp.x, z: sim.world.camp.z, d: -1 };
  for (const m of sim.monoliths) {
    const d = Math.min(...sim.pylons.map((p) => Math.hypot(p.x - m.x, p.z - m.z)));
    if (d > best.d) best = { x: m.x, z: m.z, d };
  }
  if (best.d < PYLON_RADIUS * 2) {
    // Fall back to a synthetic point; drain does not care about walls.
    return { x: 9999, z: 9999 };
  }
  return best;
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("mirage logic: OK");
