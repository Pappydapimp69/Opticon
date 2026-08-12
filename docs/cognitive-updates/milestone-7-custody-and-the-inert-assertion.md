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

**E7 · experiment · a mutation audit as a lens on where coverage actually is · live**

Deliberately break one rule, run the whole suite, record whether anything
noticed. Prompted by finding, one at a time, that `smoke` asserted nothing
about its own subject and `fair-information` accepted `positionMoved ||
beliefMoved` as proof that bluffing "reaches" a tier. Finding holes
individually is not a method; breaking things on purpose is.

Run twice against the same repo with different targets, because the first
score is a claim about the targets, not about the suite:

  * Round 1 — custody, guards, post-release grace: code written that week,
    alongside tests written in the same sitting by the same hand. **1 survivor
    of 12.**
  * Round 2 — noise decay, field of view, lamp line-of-sight, door cost, gaze
    geometry, exposure tiers, belt capacity, decoy range, the round limit:
    the systems written earliest and touched least. **5 of 16.**

Same suite, same day, five-fold difference. Coverage tracks recency, not
importance.

Three ways the exercise lied about itself, all worth designing against: a
harness whose uncaught timeout crashed and was *scored* as "the mutation was
caught"; a mutation silently skipped because its search string did not match,
whose output line reads almost identically to a caught one; and assertions
written against the constant they check (`ap === MAX - COST` holds for every
COST including zero), which is what let the round-1 survivor through.

Cost property worth keeping: with a runner that exits on first failure, a
caught mutation costs seconds and only survivors pay the full runtime, so the
bill is proportional to how bad the news is. The obstacle is that 16 mutations
is still ~1h wall-clock, which is why it is not routine. Next step, not built:
a fast pass over the node-only tests (which caught most of these in seconds)
with the browser harnesses held back for survivors only.

The refutation it produced is worth more than the fixes: **a surviving
mutation is not automatically a coverage hole.** One survivor guarded a
deadlock that a later change had already made impossible; the honest response
was to document it as dead rather than write a test around it, since pinning a
constant that provably does nothing converts dead code into frozen dead code.

*Recorded here rather than in the Brain exploration store on purpose.* The
`brain` CLI has `_push_local_ideas` and `_push_local_tension` but no
`_push_local_exploration` — `ideas/exploration.md` is registered in
`LOCAL_SEED` as a canon **mirror**, so `_local_proposal_files` skips it and
nothing ever pushes from it. An exploration block dropped in as a standalone
file is held instead, because the ideas pusher requires a `## [DOMAIN / ...]`
header that a `### ` block does not have. `.brain/` is also gitignored, so an
entry left there survives neither `sync` nor the container. The write-back
table in `orchestration.md` routes experiment/synthesis to `exploration`; the
tool currently has no path for it, so the durable home is this file. The
transferable content is not lost either way — the method and the refutation
are in the memory entry, and the unresolved cost problem is in T30.

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
