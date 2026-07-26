# Cognitive Update — Milestone 4: game verbs, reachability of controls, and tuning by measurement

*Produced per the standing milestone rule in `Brain/orchestration.md`.*

**Milestone:** The game gained its two missing verb systems — prisoner items
and Watcher skills — plus the control/UI reachability work to make every
verb usable on every device, and a real round limit. The through-line of
this batch is **measurement over intuition**: three separate decisions
(item detour radius, round cap, difficulty impact of skills) were settled
by running the balance simulator rather than by reasoning about them.
beta-0.17.0 through beta-0.27.0, live at
https://pappydapimp69.github.io/Opticon/ .

**Date:** 2026-07-26 · **Branch:** `claude/opticon-3d-browser-game-3lxa2y`

---

## New Ideas
- **Content that depends on procedural world features must declare its
  dependency.** Items name the object they act on (`requires`), and the
  eligible pool is computed from the *finished* map. This generalises past
  items to any generated-world content (quests, hints, tutorials).
- **"Recharged" and "has a valid target" are two different questions.**
  Modelling them as separate predicates, both consumed by UI *and* AI,
  keeps the affordance honest and stops an AI wasting resources.

## New Memory
Filed to `.brain/memory/incoming/` and promoted by the auto-steward:

- **E14 — A global "any input skips this" interceptor can silently eat an
  existing test's first post-transition action.** Adding the skippable
  cutscene broke one of eight headless tests; the other seven passed *by
  coincidence*, because a swallowed action only fails a test that asserts
  on that specific action's effect. A green suite is not proof the
  interceptor was harmless.
- **E15 — Validate content against the finished world, not the plan.**
  Doors/windows are placed probabilistically, so "the map has doors" is a
  per-seed fact. Auditing the proposed item list against the *real*
  generator before building also killed a proposed grapple item outright —
  the moat it targeted only rings the tower and is never crossed.
- **E16 — A cooldown ability needs two gates, and a refused use must be
  free.** Assigning the cooldown before the preconditions run makes
  "did nothing but went on cooldown anyway" almost inevitable.
- **E17 — Tempo is usually the scarce resource; A/B the detour, including
  the zero case.** Teaching the AI to detour for pickups made it *worse*
  (41/34/13% → 38/32/10%). Setting the radius to 0 restored the baseline
  exactly, isolating the detour rather than the items as the entire cost.
  Shipped radius 1 (40/35/13%) with the measurement recorded beside the
  constant so it can't be silently "tidied" back.

## New Tensions
None opened. **T25** (difficulty semantics: surveillance-strength vs.
opponent-skill-relative-to-role) remains 🟡 open and was surfaced to the
user again this milestone; the current design still reads difficulty as
surveillance strength, now including a per-difficulty `skillUse` weight.

## New Exploration
None as a separate track — the balance simulator did the experimental work
inline (three A/B runs for the detour radius, a distribution study for the
round cap), which is what that harness exists for.

## Graduation Candidates
- **E17's tempo/detour lesson** is a general turn-based-AI principle with
  no Opticon dependency — a strong candidate for cross-project canon if a
  second project with a turn clock hits it.
- **E16's two-gate ability model** likewise generalises to any
  cooldown/charge system with targeting preconditions.

---

## Milestone housekeeping
- **A claim that outran the code:** the how-to-play text written in
  beta-0.21.0 described a round limit that did not exist. Caught while
  auditing the docs against `checkEndConditions`, and fixed in beta-0.27.0
  by *building* the limit rather than deleting the sentence — worth noting
  as a failure mode of writing player-facing docs ahead of the rules.
- **Stubs:** `appearance: "default"` on prisoner state is still a
  cosmetic-only data hook with no rendering variants, awaiting a
  monetization scope decision.
- **Deferred:** ability differentiation between prisoner avatars (would
  need the free-vs-earned question answered; explicitly not purchasable).
