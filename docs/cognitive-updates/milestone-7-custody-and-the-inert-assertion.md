# Milestone 7 — Custody, camera-relative control, and the assertions that could not fail

Covers `beta-0.50.0` → `beta-0.54.0`. Overdue: the standing rule in
`orchestration.md` is one of these per milestone, and five builds shipped
without one.

Two threads run through this stretch. The first is player-facing: the game
stopped deleting you on capture and stopped pretending "up" was North. The
second is about the harness, and it only surfaced because the project owner
asked why problems were being left unsolved — a question that turned out to
have a mechanical answer and four concrete instances behind it.

## What shipped

**Guards became pawns (`0.50.0`).** One square of sight in every direction,
diagonals included, and a 7-point action bar instead of a lifespan timer: a
2-turn burst of 3 squares for a point, then a square a point, a capture costing
three, and recall the turn after the bar empties. Tier scaling moved onto the
bar (5/7/9). This resolved the T28 fork in favour of the premise — capture
attribution flipped from gaze 60/25/17% to **82/55/46%** across easy/medium/hard
without flattening the tiers.

**Your win became your own (`0.51.0`).** `checkEndConditions` ended the game on
`prisoners.some(p => p.escaped)`, so an AI companion touching the gate handed
the human a full ESCAPED screen from across the map. The rules layer had no
concept of *which prisoner is the player*; it has one now (`humanPrisoner`).

**Items explain themselves (`0.51.0`).** `blurb`, `use`, and `targeted` are
required fields of the item definition, rendered as a caption under the chips.
Pickup is automatic, so there was no inspect step where the rule could be read.

**Capture became custody (`0.52.0`–`0.53.0`).** Seized on the tile you were
taken on, three of your own turns before processing, four ways out — a Shim, a
Flare thrown from inside the cell to drag the posted guard off you, a companion
ending their turn adjacent, or bare hands at 15% a turn. Breaking free returns
the rest of that turn and two turns clear of the gaze. Guards ignore that
grace, which is the counterplay.

**Movement follows the camera (`0.52.0`).** Every prisoner direction is spatial
and now resolves through the live camera, from the prisoner's own tile.

## New Memory

- Scaling one actor to N silently reinterprets every predicate that quantified
  over it. `some()` and `every()` are identical at N=1 and opposite at N=3, and
  nothing in the type system, the compiler, or the suite says a word.
- A resource bar demotes a mechanic without flattening it, where a nerf dial
  cannot: it keeps a shape and a counterplay instead of just a smaller number.
- **Compounded odds, not per-attempt odds.** 0.3 a turn over a 3-turn window is
  a 66% escape, not "poor odds". Stated backwards in a code comment, shipped,
  and only caught by measuring escape rates (66/52/29% → 81/61/40%).
- **When a transform has an identity case, that is where all the fixtures
  live.** The camera-relative fix was invisible to the whole suite because at
  the default camera pose the correct mapping and the hardcoded up=North one
  are the same function.
- Explanatory copy becomes testable by making it a required FIELD of the
  definition. "We forgot to document it" turns into a schema violation.

## New Tensions

- **T28 · resolved** by the project owner picking the pole: the eye must be the
  primary threat. Recorded rather than decided silently, since it reversed T25.
- **T29 · open** — bluffing is a lever on people, and the AI-vs-AI sim keeps
  being asked to score it. Re-measured at `0.53.0`: `trustClaim` swung 0pt / 0pt
  / −1pt. On easy it is structurally inert (0/120 games differ) because
  `riskAversion: 0` and `caution: 1.01` both sever belief from routing; its
  `trustClaim: 0.9`, the highest of the three tiers, did nothing. Third time
  this lever has measured ~3pt and third time it was treated as tuning.

## New Exploration

A **mutation audit** of the suite: deliberately break a rule, run everything,
record whether anything noticed. Prompted by finding, one at a time, that
`smoke` asserted nothing about its own subject and `fair-information` accepted
`positionMoved || beliefMoved` as proof that bluffing "reaches" a tier. Finding
holes individually is not a method; breaking things on purpose is.

## Graduation candidates

- The **belief-vs-behaviour split** in assertions. A test that accepts an
  internal value moving as evidence of an effect will stay green while the
  effect is structurally impossible. Count them separately and assert on the
  outer one. This generalises well past this game.
- **Attribute outcomes before iterating on a lever.** Five successive fixes to
  gaze-based caution each measured inert because the gaze decided 17% of games.
  One cheap attribution pass over the outcome log — "what is actually killing
  them?" — broke a deadlock that five correct implementations had not.

## The honest part

Four defects in this stretch were found by *playing the game* or by being
asked a pointed question, not by the suite:

1. `wincheck` was flaky for three separate reasons and got blamed on load
   twice before being diagnosed. The deepest one — a teleporting harness
   resolving directions against a camera still eased onto the old position —
   had already been seen in `record.mjs` and dismissed in a single line as "a
   test artifact".
2. `smoke` drove 5–7 keypresses and asserted only "no console errors"; a run
   showing the prisoner sitting on its spawn at round 1 was looked at and
   passed over because the test was green.
3. The HUD's custody counter sat a turn stale, because it refreshes on player
   input and custody begins on turns that are not the player's.
4. Pressing a Shim armed it instead of firing it — a hardcoded
   `MUFFLE || FEATHER` check that broke the moment a third untargeted item
   existed.

The common mechanism: a stopping condition of "the suite is green and the
requested thing works" rather than "there are no open problems". A flaky test
is exactly the shape that survives it, because it stops being a signal the
moment a re-run passes.
