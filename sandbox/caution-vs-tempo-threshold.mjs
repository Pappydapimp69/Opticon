// caution-vs-tempo-threshold.mjs — When does caution actually pay?
//
// Three separate times in one session, making a turn-based agent MORE
// cautious made it measurably WORSE at its objective (item-detour radius,
// prisoner stopping-discipline, gaze-quadrant avoidance). Each was explained
// the same way: caution costs turns, and the opponent acts on the same clock.
// Three anecdotes are not a law, and "caution is bad" is obviously false in
// general. This model asks the sharper question: WHERE IS THE BREAK-EVEN?
//
// Abstract pursuit, deliberately NOT Opticon-specific:
//   * An agent must cover DISTANCE steps to win.
//   * Each turn it either advances 1 step, or spends the turn being careful.
//   * Each turn it is exposed to a per-turn hazard p of being caught.
//   * Being careful costs `cautionTurns` turns and multiplies the hazard by
//     `riskFactor` (< 1) for `protectedTurns` turns.
// Question: for which (cost, benefit) pairs does caution raise survival?
//
// Closed-form + simulation, both deterministic. No RNG: survival probability
// is computed exactly, so results are exact rather than sampled.

const DISTANCE = 20;      // steps needed to win
const BASE_HAZARD = 0.06; // per-turn chance of being caught

// Survival probability of a plan expressed as a list of per-turn hazards.
const survive = (hazards) => hazards.reduce((acc, h) => acc * (1 - h), 1);

// Reckless: DISTANCE turns, all at base hazard.
function reckless(distance = DISTANCE, base = BASE_HAZARD) {
  return survive(new Array(distance).fill(base));
}

// Cautious: pay `cautionTurns` extra turns; during `protectedTurns` of the
// journey the hazard is base*riskFactor. The extra turns are ALSO exposed.
function cautious(cautionTurns, riskFactor, protectedTurns, distance = DISTANCE, base = BASE_HAZARD) {
  const total = distance + cautionTurns;
  const hazards = [];
  for (let i = 0; i < total; i++) {
    hazards.push(i < protectedTurns ? base * riskFactor : base);
  }
  return survive(hazards);
}

console.log(`Abstract turn-based pursuit: ${DISTANCE} steps, ${(BASE_HAZARD * 100).toFixed(0)}% hazard/turn`);
console.log(`Reckless baseline survival: ${(reckless() * 100).toFixed(1)}%\n`);

// How much risk reduction is needed to justify N extra turns, if the
// protection covers the WHOLE remaining journey (the most generous case)?
console.log("Break-even risk reduction needed, protection covering the whole run:");
console.log("extra turns |  required hazard multiplier  |  i.e. risk cut by");
for (const cost of [1, 2, 3, 5, 8]) {
  let need = null;
  for (let rf = 1.0; rf >= 0; rf -= 0.001) {
    if (cautious(cost, rf, DISTANCE + cost) > reckless()) { need = rf; break; }
  }
  console.log(
    `${String(cost).padStart(11)} | ${need === null ? "impossible".padStart(27) : need.toFixed(3).padStart(27)} | ${need === null ? "—" : ((1 - need) * 100).toFixed(0) + "%"}`
  );
}

// The realistic case: protection is TRANSIENT — it covers only a few turns
// (dodging one wedge, muffling one move), not the whole journey.
console.log("\nRealistic case — protection lasts only a few turns:");
console.log("cost(turns) x protected(turns), showing survival delta vs reckless (pp):");
console.log("            " + [1, 2, 3, 5, 10].map((p) => String(p).padStart(7)).join(""));
for (const cost of [1, 2, 3]) {
  const row = [1, 2, 3, 5, 10].map((prot) => {
    const d = (cautious(cost, 0.25, prot) - reckless()) * 100; // 75% risk cut
    return (d >= 0 ? "+" : "") + d.toFixed(1);
  });
  console.log(`cost ${cost} turn${cost > 1 ? "s" : " "} ` + row.map((r) => r.padStart(7)).join(""));
}

// Where does it flip? Solve for protected-turns needed at a 75% risk cut.
console.log("\nAt a 75% risk cut, protected turns needed to break even:");
for (const cost of [1, 2, 3, 5]) {
  let need = null;
  for (let prot = 1; prot <= 200; prot++) {
    if (cautious(cost, 0.25, prot) > reckless()) { need = prot; break; }
  }
  console.log(`  cost ${cost} turn(s): needs ${need === null ? ">200" : need} protected turns` +
    (need !== null && need > DISTANCE ? "  (LONGER THAN THE WHOLE JOURNEY — never pays)" : ""));
}

console.log(`
READING: caution buys a multiplier on a per-turn hazard, but pays in EXTRA
TURNS that are themselves exposed at the base rate. So its value scales with
how LONG the protection lasts, while its cost is immediate and certain. A
one-turn detour that protects one turn is close to a wash; anything that
costs turns to buy transient protection loses. That is why "route around the
danger" style heuristics kept failing: they pay certain turns for protection
that expires almost immediately.`);

// Is the "cost N needs about N+1 protected turns" pattern robust, or an
// artifact of the 75% risk cut and the 6% base hazard? Sweep both.
console.log("\nRobustness sweep — protected turns needed to break even:");
console.log("           riskCut:   50%    75%    90%   100%");
for (const base of [0.03, 0.06, 0.12]) {
  for (const cost of [1, 2, 3]) {
    const cells = [0.5, 0.25, 0.1, 0.0].map((rf) => {
      let need = null;
      for (let prot = 1; prot <= 500; prot++) {
        if (cautious(cost, rf, prot, DISTANCE, base) > reckless(DISTANCE, base)) { need = prot; break; }
      }
      return (need === null ? ">500" : String(need)).padStart(7);
    });
    console.log(`base ${(base * 100).toFixed(0).padStart(2)}%, cost ${cost}:` + cells.join(""));
  }
}
