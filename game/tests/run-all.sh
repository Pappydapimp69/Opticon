#!/usr/bin/env bash
# Run the full Opticon 3D test suite. Exits non-zero on any failure.
set -e
cd "$(dirname "$0")/.."
echo "== runner coverage (every test file is wired in here) =="
node tests/runner-coverage.mjs
echo
echo "== no conflict markers / duplicate asset tags =="
node tests/no-conflict-markers.mjs
echo
echo "== logic =="
node tests/logic.test.mjs
echo
echo "== balance =="
node tests/balance.mjs 200
echo
echo "== smoke: prisoner =="
node tests/smoke.mjs prisoner
echo
echo "== smoke: watcher =="
node tests/smoke.mjs watcher
echo
echo "== smoke: hotseat =="
node tests/smoke.mjs hotseat
echo
echo "== wincheck (escape end-screen) =="
node tests/wincheck.mjs
echo
echo "== own escape (your win is YOUR escape, not a companion's) =="
node tests/own-escape.mjs
echo
echo "== core invariants (noise decay, sight range, light through walls, door cost, T24) =="
node tests/core-invariants.mjs
echo
echo "== screen-relative movement (up is the top of the screen, not North) =="
node tests/screen-relative-move.mjs
echo
echo "== custody (3 turns to get out of a cell; items, a friend, or luck) =="
node tests/custody.mjs
echo
echo "== zone hud (quadrant readout + watcher position-leak gate) =="
node tests/zone-hud.mjs
echo
echo "== record (per-role W/L: counted once, right role/tier, persisted) =="
node tests/record.mjs
echo
echo "== end-of-turn game over (a game that ends on YOUR turn still shows a result) =="
node tests/end-of-turn-over.mjs
echo
echo "== watcher aim/commit (screen-relative d-pad + staged rotation) =="
node tests/watcher-aim-commit.mjs
echo
echo "== risk routing (risk is a cost, not a wall; caution changes behaviour and costs tempo) =="
node tests/risk-routing.mjs
echo
echo "== fair information (neither AI sees what its human counterpart cannot) =="
node tests/fair-information.mjs
echo
echo "== golden feather (one round of true sight, facing only, expires) =="
node tests/feather.mjs
echo
echo "== item legibility (every item says what it does and what to press next) =="
node tests/item-legibility.mjs
echo
echo "== hud layout (nothing overlaps, overflows, or is clipped at 5 viewports) =="
node tests/hud-layout.mjs
echo
echo "== turn-authority hud (hint/panel track who's really acting, not just game.turn) =="
node tests/turn-authority-hud.mjs
echo
echo "== ai prisoners (companions route, hide, and escape on their own) =="
node tests/ai-prisoners.mjs
echo
echo "== audio settings (volume/mute persist and apply) =="
node tests/audio-settings.mjs
echo
echo "== exposure cue (danger vignette + no rotation leak to the prisoner) =="
node tests/exposure-cue.mjs
echo
echo "== f-key passthrough (browser F-keys are not swallowed) =="
node tests/fkey-passthrough.mjs
echo
echo "== gamepad menu nav =="
node tests/gamepad-menu-nav.mjs
echo
echo "== hold to confirm =="
node tests/hold-to-confirm.mjs
echo
echo "== intro cutscene =="
node tests/intro-cutscene.mjs
echo
echo "== items =="
node tests/items.mjs
echo
echo "== overlay gamepad =="
node tests/overlay-gamepad.mjs
echo
echo "== pass device (hotseat hand-off hides the other side) =="
node tests/pass-device.mjs
echo
echo "== skills =="
node tests/skills.mjs
echo
echo "== views (every camera mode renders without errors) =="
node tests/views.mjs
echo
echo "== window break =="
node tests/window-break.mjs
echo
echo "== tutorial (a robot pressing only what the card says finishes it; the eye sleeps until the last lesson) =="
node tests/tutorial.mjs
echo
echo "== menu resume (the menu is not a one-way door: Resume / Esc / B return to the same game) =="
node tests/menu-resume.mjs
echo
echo "ALL TESTS PASSED"
