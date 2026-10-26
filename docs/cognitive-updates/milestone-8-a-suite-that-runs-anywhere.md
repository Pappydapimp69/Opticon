# Milestone 8 — A suite that runs anywhere, all of it, every push

Covers the audit after `beta-0.56.0`. No gameplay changes.

The suite looked healthy from inside the sessions that wrote it. On a fresh
container it was red at the first browser test, a third of it never ran, and
one test could not fail.

## What shipped

**One browser resolver.** 24 tests inlined `/opt/pw-browsers/chromium-1194/...`
and the global Playwright path. The image moved to a newer Chromium, so every
headless test died at launch. `tests/browser.mjs` resolves both (env override →
pre-installed build, newest first → Playwright's own), and every test imports it.

**run-all runs everything.** 13 test files were never listed in `run-all.sh`,
though the README said it ran everything. All wired in, and
`runner-coverage.mjs` now fails the suite if a test file is added but not run.

**Tests that can fail.** `views.mjs` exited 0 whatever happened. `exposure-cue`
waited on the AI to rotate before checking the rotation never leaks to the
Prisoner; the AI can hold, or a capture can end play first (~1 in 5 failed).
It now drives one real `rotateWatcher` call.

**CI.** `.github/workflows/tests.yml` runs `run-all.sh` on every push and PR.
Its first two runs went red on races a fast local machine never lost:
hotseat smoke's `KeyV` landing on the pass-the-device gate, intro-cutscene
pressing a key before the human held the turn, and overlay-gamepad carrying
a private copy of the escape setup that missed all three fixes wincheck had
already received. Both escape tests now share `tests/escape.mjs`. The suite
was then re-run with every core pinned by busy loops: still green.

## Cognitive update

- **New Ideas:** none filed — the resolver pattern is captured as a memory rule.
- **New Memory:** two proposals, both promoted on `brain sync`:
  inlined versioned host paths + hand-listed runners; a test precondition
  that waits on an AI's free choice.
- **New Tensions:** none.
- **Open tension touched:** T11 (automated 3D verification has a ceiling) —
  CI now runs the headless checks, but they still verify logic and DOM, not
  looks. This work does not move T11.
- **New Exploration:** none.
- **Graduation candidates:** the "create the precondition through the real
  API" rule, if it recurs in another project.
