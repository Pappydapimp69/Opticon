# Cognitive Update — Milestone 1: Opticon 3D public beta

*Produced per the standing milestone rule in `Brain/orchestration.md`. Brain is
linked read-only, so canonical routing is to this project's local store
(`.brain/`); this document is the human-readable milestone record kept in the
build repo. In full mode these would sync up to the shared nodes.*

**Milestone:** Remade Opticon as a 3D browser game (Three.js, no build step,
library vendored), shipped a playable beta (single-player vs AI + hotseat),
verified both win conditions in-browser, and deployed it live to GitHub Pages
at https://pappydapimp69.github.io/Opticon/ .

**Date:** 2026-07-24 · **Branch:** `claude/opticon-3d-browser-game-3lxa2y`

---

## New Ideas
Kernels added to `ideas/idea-repository.md`:

- **Fairness rails for hidden-information "surveillance" asymmetry.** For a
  Panopticon/hunter-vs-hunted game to feel fair *and* tense, deny the powerful
  side direct sight of the hidden actor (hide the avatar for that role, and on
  that role's turn in hotseat), feed it only inferred signals (noise, light,
  objective-proximity), and give the hidden side an on-ramp (first-turn capture
  grace + spawn-in-a-safe-state). Portable to any bluff/deduction game with a
  seeker.

## New Memory
Proposals written and promoted to local canon this milestone
(`.brain/memory/projects/pappydapimp69__opticon.md`):

- **E1 — Reachability is a distinct test axis from step-correctness.** 203
  passing per-action tests still let the objective be 0% reachable across 900
  simulated games. Fix: BFS pathfinding + a whole-run outcome simulator that
  asserts both outcomes occur. *Rule: simulate whole runs to a terminal state,
  separate from correctness tests of the steps.*
- **E2 — Three.js `Fog(near,far)` silently blanks wide cameras.** The overview
  camera rendered pure background (no error) because the world was larger than
  the fog `far`. Fix: make fog per-view. *Rule: a blank render only at certain
  camera distances is usually fog/clip planes, not the scene graph.*
- **E3 — GitHub Pages via Actions deploys only from the default branch.** The
  deploy job failed at setup (0 steps, 404 log) from a feature branch;
  `configure-pages(enablement:true)` still enabled Pages from within the run,
  and the Pages REST path was blocked by the agent proxy. Fix: merge to default,
  deploy from there, and curl the served URL to confirm. *Rule: plan to deploy
  Pages from the default branch; drive enablement from inside the workflow.*

## New Tensions
Logged to `.brain/tension/tension-ledger.md`:

- **OPT-1 · methodology · Is an AI-vs-AI sim a valid balance oracle for a
  human-facing threat model?** The balance simulator shows all difficulty tiers
  with near-identical escape/capture rates, yet the difficulty knob is *bluff
  frequency* — doubt that only bites a human reading the tower eye. 🟡 Lean: use
  the sim for reachability + gross balance, treat human-facing difficulty as
  unverified until playtested.
- **OPT-2 · design · Cautious prisoner AI can stalemate a human Watcher.** The
  BFS prisoner AI times out ~12% of sim games by refusing dangerous tiles; with
  no round cap a human Watcher game could stall. 🟡 Lean: acceptable for beta
  (the Watcher usually catches first); revisit if playtests show stalls.

Pre-existing tensions touched:
- **T12 (vendoring Three.js vs build/CDN)** — decided *vendor*, for offline play
  and zero build. This is a deliberate committed choice on one side of the lean,
  not a blind one. (Surfaced late — I did not consult it before deciding.)
- **T11 (3D verification ceiling — logic, not looks)** — new evidence: headless
  Chromium screenshots + a whole-run balance simulator caught two gameplay/visual
  defects that logic tests passed (E1 reachability, E2 fog). Pushes T11 toward
  "verification can reach looks, via headless capture + outcome simulation."

## New Exploration
Logged to `.brain/ideas/exploration.md`:

- **experiment · Tier the capture-exposure rule by difficulty so the sim can
  measure it.** Today difficulty only changes bluff frequency (invisible to an
  AI-vs-AI sim). Proposal: easy = caught only if lit; medium = lit OR on a fresh
  noise tile; hard = lit OR noise within 1 tile. This makes difficulty a
  *mechanical* lever the simulator can score, resolving OPT-1's measurability
  sub-question. Not yet run.

## Graduation Candidates
- **"Goal-reachability needs its own whole-run test, separate from local/step
  correctness."** This milestone's E1 echoes pre-existing shared canon from
  other projects (procgen local-constraint vs global-connectivity; metroidvania
  BFS softlock audit). Recurrence across ≥3 projects → candidate **portable
  law**, not just a per-project lesson. Recommend Brain promote a cross-project
  entry.

---

## Milestone housekeeping
- **Stubs:** none pending (`incoming/stubs.md` empty) — no curation debt.
- **Stale leans:** T12 re-examined (decided this milestone); T11 advanced with
  evidence. No 🟡⏰ flags outstanding for this project's touched set.
- **Process note (carried into CLAUDE.md):** the session under-used Brain
  mid-problem — opening queries used long phrases and returned 0, which was
  mis-read as "empty system." Shared canon actually anticipated E1 and E3.
  Corrective guidance added to `CLAUDE.md`.
