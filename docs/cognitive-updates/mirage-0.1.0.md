# Cognitive Update — MIRAGE 0.1.0 (a second game in the repo)

Standing rule from `orchestration.md`: produce this at each milestone, unprompted.
Scope: the build of MIRAGE, a separate 3D game under `mirage/` — the player leads a
party of five NPCs through a fogged basin; every character including the player
carries an invisible meter that counts down, and at zero that mind hallucinates.

## Retrieval performed first

Per-sub-problem, not just at session start:

| query | what it changed |
| --- | --- |
| `hallucination` | 0 results — nothing on the core mechanic; built from scratch |
| `shader`, `perception` | surfaced the SwiftShader hazard pair and 🔴 **T11** (automated 3D verification has a ceiling) |
| `vendoring`, `three` | surfaced 🟡 **T12** — decided the Three.js question against it (see ADR 0001) |
| `reachability` | *"global connectivity needs its own explicit fixup pass, not a byproduct of local satisfaction"* → `world.js` runs an explicit repair pass and `validate()` re-derives reachability independently |
| — | `dog#E2` / `test#E7` (headless rAF runs under real time; "it loaded" is a false green) → shaped the entire test strategy |

A 0-result query on `hallucination` was treated as "nothing here yet", not "Brain is
empty" — the neighbouring queries all returned.

## New Memory (3 proposals, pushed to main for the steward)

1. **A camera-relative movement sign error passes every displacement test.** `W`
   walked backwards and 58 tests plus a smoke test stayed green, because every
   assertion was a magnitude ("did the player move?" — it did, in the wrong
   direction). The same wrong basis put the follow formation in front of the camera.
   Caught by looking at one rendered frame. Fix: assert the SIGN of the delta
   projected onto the camera's forward basis.
2. **"Empty" is not "uncomputed" in a path cache.** `!path.length` treated a
   legitimate empty result as a cache miss, so five NPCs ran a full BFS every tick —
   measured 6× whole-simulation slowdown (1220ms → 205ms per 2000 ticks) with zero
   visible symptom. Written independently at two call sites, which suggests the
   phrasing is the attractor. Also: never set a rate-limit timer to `0` as "retry
   soon".
3. **A headless 3D screenshot timeout is usually SLOW, not HUNG** — and this entry
   records a *wrong* first hypothesis of mine (an animated CSS `filter`), which
   survived a round of plausible reasoning and did not survive measurement. Captures
   measured ~5s vs ~0.6s under SwiftShader. Prove liveness with an rAF counter and
   `renderer.info.render.calls` before hunting a runaway loop.

## New Ideas (2, in the local store pending promotion)

- `[SYSTEM / unreliable-presentation / perception-as-a-module-between-truth-and-view / the-renderer-needs-no-special-case-for-the-lie]`
- `[GAME-DESIGN / status-display / behavioural-tells-instead-of-a-meter / degrade-the-observer-s-read-never-the-underlying-truth]`

Deliberately **not** filed: an explicit-connectivity-repair kernel. Dedup by kernel
found it already covered by `completability-by-construction-or-repair` and
`spanning-tree-plus-key-before-lock-bfs`.

## Evidence for an existing tension: 🔴 T11 (automated 3D verification has a ceiling)

Not a new tension — a concrete demonstration of the one already open, and the
sharpest evidence this repo has for it. The camera-relative movement basis had two
sign errors, so `W` walked **backwards** and the follow formation rendered **in
front of** the lead. Passing at that moment: 58 pure-logic assertions, a whole-run
balance harness, and a real-browser smoke test that checked draw calls, triangle
counts, drain, recovery, and every verb. Nothing was red. The defect was found by
opening one screenshot and looking at it.

That locates the ceiling precisely rather than restating that it exists: the
assertions were all **scalar** (did it move? how far? how many triangles?), and a
basis error is a property of *direction and arrangement*, which no scalar in the
suite named. The cheap partial fix is now in the code (assert the SIGN of the delta
projected on the camera's forward vector), and the residue is real — "the party is
standing in the camera" is not a number. Rendered-frame review stays a required
step, not a nicety, which is exactly T11's claim.

## New Tensions (2)

- **T26 · tradeoff** — one vendored Three.js shimmed into the second game (no added
  bloat, sits under T12) **vs** a duplicate copy per game (standalone deployability).
  🟡 leaning shim; the escape hatch is one `cp`, documented. Revisit when MIRAGE
  ships as its own Pages site.
- **T27 · open-question** — what oracle can verify difficulty that exists only in
  the presentation layer? Independent evidence for T23's shape from a different game
  and mechanism: MIRAGE's entire difficulty is that the screen lies, and the scripted
  bot reads the sim's truth, so it wins 100% of standard seeds in ~100s. 🔴 open,
  held deliberately — the harness now states in its own output that it is a
  completability oracle and asserts only completability and non-walkover.

**Open tension surfaced to the user, as required:** 🟡 T12 (vendoring Three.js)
directly governed the library decision here; the resolution and its unpaid cost are
recorded in `docs/adr/0001-mirage-separate-game.md`.

## New Exploration

None filed. The candidate — a bot that routes off `percept.js` instead of the sim,
so it can be deceived by its own phantoms and the deception becomes mechanically
measurable — is recorded inside T27 as the concrete next step rather than as a
speculation, because it has a specific implementation and a specific known
limitation (it would measure a bot's credulity, not a human's).

## Measurement that changed the design

Not taste — the balance harness moved two numbers:

- **Daylight 600s → 780s.** At 600s, careful play lost 67% of runs to darkness *with
  5.7 of 6 markers already logged*: the clock was deciding runs the design wants the
  party to decide.
- **A whole policy was deleted as a negative result.** An earlier "cautious" policy
  (detour whenever anyone drops below fraying, rest until nearly full) lost 100% of
  runs — but that measured the policy, not the game: in a party of six somebody is
  always below that line, so it spent its entire day resting. Recorded in the
  harness as a negative result rather than kept.

**Both measurements above predate the movement-basis fix, and the fix moved them.**
Correcting the record rather than quoting the convenient number: with the formation
finally forming up *behind* the lead, the party stays cohesive, which changes both
isolation drain and marker sighting (companions are the extra pairs of eyes). Final
numbers, 8 seeds per arm:

| arm | won | ended dark | dissolved | markers logged |
| --- | --- | --- | --- | --- |
| gentle / careful | 100% | 0 | 0 | 6.0 / 6 |
| standard / careful | 88% | 1 | 0 | 6.0 / 6 |
| standard / reckless | 75% | 1 | 1 | 6.0 / 6 |
| bleak / careful | 13% | 7 | 0 | 5.6 / 6 |
| bleak / reckless | 75% | 0 | 2 | 6.0 / 6 |

So the 780s daylight is now *slack* at standard rather than the binding constraint it
was tuned against — the change is still right for the reason it was made, but the
evidence for it no longer reproduces on this code. Two things stand out and are left
open rather than tuned away: careful play collapses on **bleak** (13%) purely because
the rest trigger fires constantly at that drain rate, which is the same policy
artifact the deleted "cautious" arm died of; and **dissolution** now occurs (3 runs)
where before it never did, so the total-collapse ending is reachable rather than
theoretical.

## Graduation candidates

- **Perception-as-a-module** is the strongest: it is small, pure, testable without a
  browser, and applies to fog of war, spoofed telemetry, unreliable narrators, and
  deliberately-lying dashboards — not only to hallucination.
- **The completability-vs-difficulty oracle distinction** (T23 + T27) now has
  evidence from two different games with two different mechanisms. That pattern —
  *a scripted agent validates that a game can be finished, never how hard it is,
  whenever the difficulty lives in what the player is shown* — looks ready to
  graduate out of a per-project tension into a general principle.
