# Milestone 5 — Guards, and the lever that was never pulled

Covers `beta-0.38.0` → `beta-0.41.0`, all live at
https://pappydapimp69.github.io/Opticon/ .

The headline is that **T25 finally closed** — the tension that had been open
since M1 asking whether "difficulty" means anything at all for a human
Watcher. It closed on the fifth lever tried, and the interesting part is not
the lever. It's that the first measurement of the lever said it did nothing,
and that measurement was correct about the numbers and wrong about why.

## What shipped

- **DISPATCH became a real difficulty lever.** A `DISPATCH_TIER` table
  (guard speed, lifespan, cooldown, sight range) resolved once at
  `createGame` into `game.dispatchTier`, plus a `dispatchTierFor()` helper
  in main.js that *inverts* the tier when the human holds the tower — "hard"
  must mean weaker guards for a human Watcher and stronger guards for an AI
  one. Unlike the passive gaze rule, DISPATCH is asymmetric (only one side
  ever fires it), so the inversion is safe to do bluntly rather than by
  pinning a neutral baseline.
- **The AI Watcher started using DISPATCH at all.** See below.
- **A Zone readout for the Prisoner.** Guards are announced publicly by
  absolute quadrant; nothing on screen ever told a Prisoner which quadrant
  *they* were in. Gated exactly like the item bar, with tests asserting a
  Watcher-role viewer can't read it even mid-prisoner-turn.
- **The Distraction decoy actually pulls guards now.** It didn't.
- **How-to-play caught up with the code** — 5 skills, not 4; guards
  documented at all.

## New Memory

- **E32 — an identical-to-control measurement is a wiring signal, not a
  weak-lever signal.** Tiering DISPATCH's parameters produced a result
  byte-identical to a flat-medium control. The tiering was correct. The AI
  Watcher's `pickSkills` had a hardcoded preference list that had never
  included DISPATCH since the skill was built, so the mechanic had never
  fired in any game, ever. A parameter you can trace as "wired through" is
  a different claim from "invoked by the code path under test", and only the
  second one makes a measurement mean anything. The control run is what
  caught it — without it, "the lever is weak, same as the other four" was
  a completely plausible and completely wrong thing to report.

## New Tensions

**T27 opened 🟡** — see housekeeping below: the Brain pre-commit gate's
keyword matcher false-positived five times in one commit on ordinary English,
and the cost isn't the false positive, it's that reflexive acknowledgement is
how a gate stops gating.

**T25 closed ✅** after five levers across four milestones:
capture-exposure re-tuning (inverted the meaning), prisoner-AI caution
tiers (~3pt), stopping-discipline (moved the wrong way), bluff-gullibility
(~3pt, and exposed that bluffing was literally inert), and finally DISPATCH
(9–17pt per tier, both roles monotonic). The through-line: **every lever
that changed how the AI *reasons* was worth ~3 points; the one that added a
new *rule* was worth five times that.** Capture outcome here is dominated by
map and tempo, not by opponent cleverness.

## New Exploration

None as a separate track. `sandbox/t25-role-direction.mjs` did the
experimental work inline, as it exists to.

## Graduation Candidates

- **E32 generalises well past games.** "Run the unchanged control, and treat
  an identical result as a wiring question before a magnitude question"
  applies to any tuning change measured through an agent — prompt weights,
  retrieval parameters, scheduler heuristics. Strong candidate if a second
  project hits it.
- **The asymmetric-vs-symmetric routing distinction** (a knob only one side
  can touch is safe to invert bluntly; a knob that governs both sides needs
  a neutral baseline) is a general difficulty-design principle, already
  half-captured in the `orthogonal-mechanic-as-difficulty-lever` kernel.

---

## Milestone housekeeping

- **A claim that outran the code, caught this time.** M4 recorded shipping
  how-to-play text describing a round limit that didn't exist. This
  milestone wrote "throwing a Distraction pulls them to the noise instead of
  you" — then checked, and it was false: two sounds made in the same turn
  both sit at `NOISE_TTL`, so "freshest noise in quadrant" silently
  degenerated to array order, i.e. the prisoner's own footsteps. Fixed with
  a monotonic `seq` stamp. Writing the doc is what found the bug; the doc
  was written before shipping this time, which is the whole difference.
- **The Brain pre-commit gate false-positived five times** in one commit
  (T3/T11/T17/T21/T26) on ordinary English words — *promise*, *without*,
  *survives*, *genuine*, *reads*, *automated*, *logic*, *negative*. Each was
  verified against the tension's real content before acknowledging. The
  matcher's precision is poor enough on prose-heavy commit messages that
  acknowledging is becoming routine, which is exactly how a gate stops
  working. Filed as **T27** rather than silently worked around.
- **Stubs:** `appearance: "default"` on prisoner state is still a
  cosmetic-only hook with no rendering variants.
