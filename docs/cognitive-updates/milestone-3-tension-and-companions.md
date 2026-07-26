# Cognitive Update — Milestone 3: tension design pass + AI companion prisoners

*Produced per the standing milestone rule in `Brain/orchestration.md`.*

**Milestone:** User play-test feedback drove a design pass on how the
Watcher's presence is communicated (text log → diegetic vignette/heartbeat),
fixed a genuine information-leak bug the feedback surfaced along the way,
then shipped a run of user-directed features: hotseat privacy gating,
hold-to-confirm input (intro + menu Start) across keyboard/gamepad/touch, a
glass/window redesign from floor-hazard to strategic breakable wall shortcut,
and AI companion prisoners (group-of-3 in single-player). beta-0.12.0 through
beta-0.16.0, all live at https://pappydapimp69.github.io/Opticon/ .

**Date:** 2026-07-26 · **Branch:** `claude/opticon-3d-browser-game-3lxa2y`

---

## New Ideas
- **Cosmetics-only monetization, applied concretely.** User proposed
  purchasable prisoner abilities alongside cosmetics; disagreed on the
  ability half (pay-for-power breaks competitive integrity in an asymmetric
  PvP game) while agreeing on the default-hooks architecture — every
  prisoner gets a default animation/appearance hook, purchases only ever
  swap what renders on that hook, never what it does. `appearance: "default"`
  stub field landed on prisoner state as the data hook; no purchasable
  ability layer was built.

## New Memory
Three proposals written to `.brain/memory/incoming/` and synced to shared canon:

- **E8 — GitHub Pages: deploy reports success but the live URL 404s; a
  second `workflow_dispatch` always clears it.** Recurred on every deploy
  this milestone (beta-0.12.0 through beta-0.16.0). Treat as expected
  propagation lag, not a failure signal — verify live, and if 404, retrigger
  once before investigating further.
- **E9 — Gating one presentation surface doesn't gate the data.** The HUD's
  Watcher-facing readout was correctly hidden from the Prisoner, but the
  text log rendered the same underlying state unfiltered — a second consumer
  of the same fact, unaudited. Fixed with a `watcherOnly` flag on log entries
  filtered at render time. General rule: when a fact is hidden-information by
  design, enumerate every surface that reads it, not just the one you were
  looking at when you added the gate.
- **E10 — A role check must become instance-aware at every handoff, not just
  the obvious input gate.** Scaling from 1 prisoner to a group of 3 turned
  `humanControlsPrisoner()` from a role question ("is the human the
  Prisoner?") into an instance question ("is the human controlling *this*
  prisoner, right now?"). The input gate was the obvious place to fix; two
  more turn-handoff points (`scheduleAiWatcher`'s tail, `scheduleAiPrisoner`'s
  tail) made the same singular assumption and would have silently stalled
  the turn chain waiting for input from a companion or an all-AI roster.
  General rule: when an entity goes from singular to plural, audit every
  handoff in the turn state machine, not just where input is read.

## New Tensions
Opened in the `Tension` repo's ledger (contributor-append, `Updates:` log):

- **T25 · Difficulty semantics: surveillance-strength vs. opponent-skill-
  relative-to-role → 🟡 open, leaning kept.** Raised while discussing
  population scaling with the user; current design ties difficulty to
  Watcher surveillance strength (bluff rate, exit bias, noise weight), not to
  a role-relative skill curve. Leaning is to keep the current model as-is —
  flagged for user review, not auto-resolved.

## New Exploration
None this milestone — the vignette/heartbeat design (replacing the ignored
text-log tension cue) was scoped and shipped directly from user play-test
feedback rather than run as a separate exploration/synthesis track.

## Graduation Candidates
- **E9's "gate the data, not just one surface" pattern** is a general
  hidden-information-game lesson with no Opticon-specific dependency — a
  candidate for promotion to cross-project canon if a second linked project
  with asymmetric/hidden-info mechanics hits the same shape of bug.
- **E10's "singular→plural forces every handoff to become instance-aware"**
  is a general turn-state-machine lesson, likely to recur in any project that
  scales an entity count after the state machine was written for one.

---

## Milestone housekeeping
- **Stubs:** `appearance: "default"` on prisoner state — data hook only, no
  cosmetic rendering variants built yet. Awaiting monetization scope
  decision before further build-out.
- **Stale leans:** none new. T25 is a fresh open lean, not stale.
- **Deferred, awaiting user design input:** items system (confirmed present
  in source material, no design details given — not built), full cutscene
  camera-flythrough (agreed in principle, not started beyond the
  `appearance` stub).
