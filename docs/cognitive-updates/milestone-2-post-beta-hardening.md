# Cognitive Update — Milestone 2: post-beta hardening + autonomous improvement pass

*Produced per the standing milestone rule in `Brain/orchestration.md`.*

**Milestone:** Fixed a critical menu regression (Menu button was restarting
the current game), resolved the prisoner-AI-stall tension (T24) with two
distinct root-cause bugs found and fixed, then continued autonomously per
standing user approval: shipped four more tested, deployed beta increments
(audio volume controls + settings persistence, game-over stats, watcher AI
difficulty depth, a capture visual cue) — beta-0.7.0 through beta-0.11.0, all
live at https://pappydapimp69.github.io/Opticon/ .

**Date:** 2026-07-24 to 2026-07-26 · **Branch:** `claude/opticon-3d-browser-game-3lxa2y`

---

## New Ideas
Kernel filed to `ideas/incoming/` and promoted:

- **A sibling tuning field that's defined but never read is evidence of an
  unfinished feature, not dead code.** Found via `watcherAI.js`'s
  `DIFFICULTY.memory` field sitting unused next to `bluffChance`/`exitBias`/
  `noiseWeight`, all of which fed the AI's decision score. General rule: when
  auditing a difficulty/config ladder, grep each field's own name against the
  module meant to consume it.

## New Memory
Three proposals written to `.brain/memory/incoming/` and synced to shared canon:

- **E5 — Interact-in-place tiles need excluding from EVERY passability check,
  not just the move resolver.** A switch tile toggles in place (never
  relocates the mover); the move resolver knew this, but pathfinding and the
  map generator's own connectivity guarantee didn't — BFS routed the prisoner
  AI through tiles it could never actually cross, a 500+-round stall
  invisible until a whole-run simulator with a generous budget caught it.
- **E6 — A stall/no-progress detector must gate its reset on best-ever, not
  turn-over-turn.** The original stall counter reset on any single-turn
  improvement, so a slow oscillation (advance/retreat) never tripped it.
  Fixed by tracking `bestDistToExit` (monotonic) instead of a previous-turn
  delta — immune to oscillation by construction.
- **E7 — A branch with an earlier squash-merged PR still carries its
  pre-squash commits and will conflict on the next PR from it.** GitHub
  reported a REAL (not phantom) merge conflict opening a second PR from the
  same long-lived branch, because the branch's ancestry still included
  commits whose content was already merged under a different SHA. Fix: reset
  the branch onto the base's current tip and cherry-pick/rebase only the
  genuinely new commits before every subsequent PR, not just once. Applied
  successfully to every PR after this was found (beta-0.9.0 through
  beta-0.11.0 all merged clean on the first attempt).

## New Tensions
Resolved in the `Tension` repo's ledger (contributor-append, `Updates:` log):

- **T24 · Cautious prisoner AI can stalemate a human Watcher → 🟢 resolved
  (evidence).** Two distinct bugs, not one (see E5, E6 above). Balance sim
  timeout rate: ~10-22% → 0% across 900 simulated games.

No new tensions opened this milestone.

## New Exploration
None — the standing exploration entry from milestone 1 (E1,
tier-capture-exposure-by-difficulty) was implemented and closed as part of
resolving OPT-1/T23 before this milestone's work began.

## Graduation Candidates
- **E7's squash-merge-branch-reuse gotcha** is a pure git/process lesson with
  no gamedev dependency — a plausible candidate for promotion to a
  cross-project "process" canon entry if it recurs in another linked project
  using the same long-lived-branch-plus-repeated-PR workflow.

---

## Milestone housekeeping
- **Stubs:** none pending.
- **Stale leans:** none — T24 was the only open lean touching this project's
  work, and it's now resolved with evidence.
- **Process note:** found and fixed the `ideas` repo write-back path had two
  stray `incoming/` files left over from earlier in the session
  (`difficulty-exposure-oracle.md`, `surveillance-fairness-rails.md`),
  committed on this project's feature branch but never merged to `ideas`
  main. Both turned out to already be promoted into canon via a different
  path (confirmed by diffing against `origin/main` before assuming either
  needed re-filing) — the branch had just drifted stale, the same class of
  issue as E7. No content was lost; nothing needed re-doing.
