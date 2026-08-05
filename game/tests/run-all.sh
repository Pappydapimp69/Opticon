#!/usr/bin/env bash
# Run the full Opticon 3D test suite. Exits non-zero on any failure.
set -e
cd "$(dirname "$0")/.."
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
echo "== fair information (neither AI sees what its human counterpart cannot) =="
node tests/fair-information.mjs
echo
echo "== golden feather (one round of true sight, facing only, expires) =="
node tests/feather.mjs
echo
echo "== hud layout (nothing overlaps, overflows, or is clipped at 5 viewports) =="
node tests/hud-layout.mjs
echo
echo "== turn-authority hud (hint/panel track who's really acting, not just game.turn) =="
node tests/turn-authority-hud.mjs
echo
echo "ALL TESTS PASSED"
