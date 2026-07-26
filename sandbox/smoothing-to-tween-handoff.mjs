// smoothing-to-tween-handoff.mjs — Composition sandbox.
//
// Composes:  dog/E10  (per-frame smoothing must be 1 - exp(-dt/tau), not a
//                      constant fraction, or it is frame-rate dependent)
//        +   Opticon's avatar motion, which drives the SAME object two ways:
//            a fixed-duration eased tween while a walk queue is non-empty,
//            and an exponential smoothing chase when it is empty.
//
// CLAIM UNDER TEST: making the smoothing frame-rate-independent does NOT make
// the HANDOFF frame-rate-independent. Exponential smoothing is asymptotic and
// never exactly arrives; a tween that assumes it starts at an exact known
// point therefore begins by JUMPING the residual. The residual — and so the
// size of the pop — depends on how long the object smoothed, which depends on
// frame rate. A "correct" smoothing formula hides, but does not remove, this.
//
// Deterministic: no RNG, no wall clock. dt is a parameter.

const TAU = 0.1;            // Opticon's idle-follow time constant
const STEP_DUR = 0.22;      // Opticon's per-tile walk duration
const smoothing = (dt, tau) => 1 - Math.exp(-dt / tau);
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// Simulate: object sits at 0, its logical tile becomes 1 (a teleport/AI move),
// it smooths toward 1 for `idleSeconds`, and THEN a walk tween is queued that
// declares it starts at tile 1 and ends at tile 2.
function handoff(fps, idleSeconds) {
  const dt = 1 / fps;
  let pos = 0;
  const target = 1;
  const frames = Math.round(idleSeconds * fps);
  for (let i = 0; i < frames; i++) {
    pos += (target - pos) * smoothing(dt, TAU);
  }
  const residual = target - pos;      // how far short the chase still is
  // The tween now asserts its own start point (grid coords), as walkTo does.
  const tweenStart = 1;
  const popAtHandoff = Math.abs(tweenStart - pos); // instantaneous jump
  return { residual, popAtHandoff, posBefore: pos };
}

console.log("Handoff pop, in TILES, when a walk tween follows an idle smooth:\n");
console.log("idle before walk |   30fps     60fps    144fps   |  fps-spread");
for (const idle of [0.02, 0.05, 0.1, 0.2, 0.5]) {
  const a = handoff(30, idle).popAtHandoff;
  const b = handoff(60, idle).popAtHandoff;
  const c = handoff(144, idle).popAtHandoff;
  const spread = Math.max(a, b, c) - Math.min(a, b, c);
  console.log(
    `${String(idle + "s").padStart(16)} | ${a.toFixed(4)}  ${b.toFixed(4)}  ${c.toFixed(4)}   |  ${spread.toFixed(4)}`
  );
}

// Is the smoothing itself frame-rate independent (dog/E10 satisfied)?
console.log("\nControl — is the smoothing formula itself fps-independent?");
for (const idle of [0.05, 0.2]) {
  const p30 = handoff(30, idle).posBefore;
  const p144 = handoff(144, idle).posBefore;
  console.log(`  after ${idle}s: 30fps=${p30.toFixed(6)}  144fps=${p144.toFixed(6)}  diff=${Math.abs(p30 - p144).toExponential(2)}`);
}

// What a naive CONSTANT-fraction smoother would do (the dog/E10 bug), for
// contrast — this is the failure E10 already covers.
console.log("\nContrast — constant-fraction smoother (the dog/E10 bug):");
function naive(fps, idleSeconds) {
  const frames = Math.round(idleSeconds * fps);
  let pos = 0;
  for (let i = 0; i < frames; i++) pos += (1 - pos) * 0.15; // fixed k
  return pos;
}
for (const idle of [0.05, 0.2]) {
  console.log(`  after ${idle}s: 30fps=${naive(30, idle).toFixed(6)}  144fps=${naive(144, idle).toFixed(6)}`);
}

// VERDICT
const popShort = handoff(60, 0.02).popAtHandoff;
const popLong = handoff(60, 0.5).popAtHandoff;
console.log(`\nPop after a SHORT idle (0.02s): ${popShort.toFixed(4)} tiles`);
console.log(`Pop after a LONG  idle (0.50s): ${popLong.toFixed(4)} tiles`);
console.log(
  popShort > 0.05
    ? "\nCONFIRMED: the tween inherits a visible discontinuity from the\n" +
      "asymptotic chase it took over from. Correct smoothing does not fix it —\n" +
      "the tween must start from the object's ACTUAL position, not an assumed one."
    : "\nNOT REPRODUCED: the residual is negligible at every tested idle length."
);
