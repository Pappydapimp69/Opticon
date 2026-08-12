#!/usr/bin/env bash
# Mutation audit — does the suite actually notice when a rule is broken?
#
# Deliberately breaks one rule at a time, runs the whole suite, and records
# whether anything failed. A mutation that SURVIVES is a hole: behaviour the
# suite claims to cover and does not.
#
# NOT part of run-all.sh — it runs the full suite once per mutation and takes
# tens of minutes. Run it by hand after adding rules, or when a green suite
# starts feeling like weak evidence:
#     bash game/tests/mutation-audit.sh
#
# Written after finding, one at a time and mostly by playing the game, that
# `smoke` asserted nothing about its own subject and `fair-information`
# accepted `positionMoved || beliefMoved` as proof a bluff "reached" a tier.
# Finding holes individually is not a method. The first run of this script
# scored 1 survivor out of 12: guard captures costing zero action points,
# because both assertions about the cost were written as
# `ap === GUARD_ACTION_POINTS - GUARD_CAPTURE_COST` — the same constant on
# both sides of the equals sign, true for any value including zero. Assertions
# written against a constant cannot test that constant. Use literals.
#
# run-all.sh is `set -e`, so a caught mutation exits early and costs seconds;
# only survivors pay the full runtime. Good property for this.
cd /home/user/Opticon

declare -a NAMES FILES FROM TO

add() { NAMES+=("$1"); FILES+=("$2"); FROM+=("$3"); TO+=("$4"); }

add "custody clock 3 -> 5 turns" \
    "game/src/rules.js" \
    "export const CUSTODY_TURNS = 3;" \
    "export const CUSTODY_TURNS = 5;"

add "gaze ignores post-release grace" \
    "game/src/rules.js" \
    "    if (p.graceTurns > 0) continue;" \
    "    if (false) continue;"

add "guard capture is free (cost 3 -> 0)" \
    "game/src/rules.js" \
    "export const GUARD_CAPTURE_COST = 3;" \
    "export const GUARD_CAPTURE_COST = 0;"

add "screen->world direction inverted 180" \
    "game/src/render.js" \
    "    return best;" \
    "    return (best + 2) % 4;"

add "held prisoners can walk" \
    "game/src/rules.js" \
    '  if (p.custody) return { ok: false, reason: "held" }; // cuffed to the spot' \
    "  // mutation: gate removed"

add "release does not give the turn back" \
    "game/src/rules.js" \
    "    p.mp = MP_PER_TURN;
    // Movement noise is measured from where the turn started, and for a held" \
    "    // mutation: mp not restored
    // Movement noise is measured from where the turn started, and for a held"

add "any escape wins, not your own" \
    "game/src/rules.js" \
    "  if (human) {
    if (human.escaped) {" \
    "  if (false) {
    if (human.escaped) {"

add "guards never stand watch over a cell" \
    "game/src/rules.js" \
    "    if (watching) {
      guard.ap -= 1;" \
    "    if (false) {
      guard.ap -= 1;"

add "struggling always works" \
    "game/src/rules.js" \
    "export const STRUGGLE_CHANCE = 0.15;" \
    "export const STRUGGLE_CHANCE = 1;"

add "companions can never rescue" \
    "game/src/rules.js" \
    "  resolveRescues(game, p);" \
    "  // mutation: rescues disabled"

add "guard sight 1 -> 3 squares" \
    "game/src/rules.js" \
    "export const GUARD_SIGHT = 1;         // squares seen in EVERY direction" \
    "export const GUARD_SIGHT = 3;"

add "held-only items usable while free" \
    "game/src/rules.js" \
    '  if (heldOnly && !p.custody) return { ok: false, reason: "only-in-custody" };' \
    "  // mutation: heldOnly gate removed"

# ---- Round 2: the OLD core ------------------------------------------------
# Round 1 above mutated custody, guards and grace — code written in the same
# week as its own tests, by the same hand. It scored 1/12, which flattered the
# suite. These target the systems written earliest and touched least, and they
# scored 5 SURVIVORS out of 16. Coverage tracks how recently something was
# written, not how important it is.
# --- Core resources -------------------------------------------------------
add "move points 3 -> 5" "game/src/rules.js" \
  "export const MP_PER_TURN = 3;" "export const MP_PER_TURN = 5;"

add "belt capacity 2 -> 4" "game/src/rules.js" \
  "export const ITEM_CAP = 2; // carried at once — forces a real \"which do I keep\" choice" \
  "export const ITEM_CAP = 4;"

add "noise lingers 2 -> 6 turns" "game/src/rules.js" \
  "export const NOISE_TTL = 2; // turns a noise marker persists for the Watcher" \
  "export const NOISE_TTL = 6;"

add "prisoner sight 5 -> 2 tiles" "game/src/rules.js" \
  "export const FOV_RANGE = 5; // prisoner cardinal sight range (tiles)" \
  "export const FOV_RANGE = 2;"

add "decoy range 6 -> 1" "game/src/rules.js" \
  "export const DISTRACT_RANGE = 6;" "export const DISTRACT_RANGE = 1;"

add "round limit 90 -> 12" "game/src/rules.js" \
  "export const ROUND_LIMIT = 90;" "export const ROUND_LIMIT = 12;"

# --- Gaze geometry --------------------------------------------------------
add "north gaze wedge inverted" "game/src/rules.js" \
  "      return dy < 0 && Math.abs(dx) <= -dy; // North" \
  "      return dy > 0 && Math.abs(dx) <= dy; // North (mutated)"

add "gaze wedge 90deg -> whole halfplane" "game/src/rules.js" \
  "      return dx > 0 && Math.abs(dy) <= dx; // East" \
  "      return dx > 0; // East (mutated: no wedge)"

# --- Light and line of sight ----------------------------------------------
add "light ignores its own radius" "game/src/rules.js" \
  "    if (d <= l.radius && lightReaches(game, l, x, y)) return true;" \
  "    if (lightReaches(game, l, x, y)) return true;"

add "light shines through walls" "game/src/rules.js" \
  "    if (d <= l.radius && lightReaches(game, l, x, y)) return true;" \
  "    if (d <= l.radius) return true;"

add "switched-off lights still light" "game/src/rules.js" \
  "    if (!game.lightState[l.group]) continue;" \
  "    if (false) continue;"

# --- Exposure -------------------------------------------------------------
add "everything is exposed" "game/src/rules.js" \
  "export function isExposed(game, x, y, difficulty) {
  if (isLit(game, x, y)) return true;" \
  "export function isExposed(game, x, y, difficulty) {
  return true;
  if (isLit(game, x, y)) return true;"

add "easy tier now punishes noise like medium" "game/src/rules.js" \
  '  if (difficulty === "easy") return false;' \
  "  // mutation: easy no longer forgives noise"

# --- Movement / world -----------------------------------------------------
add "closed doors cost nothing to open" "game/src/rules.js" \
  "    p.mp -= 1;
    logMsg(game, \`Prisoner picks the lock — door opens.\`);" \
  "    logMsg(game, \`Prisoner picks the lock — door opens.\`);"

add "a plain move costs nothing" "game/src/rules.js" \
  "  p.x = nx;
  p.y = ny;
  p.mp -= 1;" \
  "  p.x = nx;
  p.y = ny;"

# --- Prisoner AI ----------------------------------------------------------
add "AI never commits (stall limit disabled)" "game/src/prisonerAI.js" \
  "const STALL_LIMIT = 3;" "const STALL_LIMIT = 99999;"

echo "MUTATION AUDIT — $(date -u +%H:%M:%S)"
echo
survivors=0
for i in "${!NAMES[@]}"; do
  f="${FILES[$i]}"
  cp "$f" /tmp/mut-backup.js
  python3 - "$f" "${FROM[$i]}" "${TO[$i]}" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if frm not in s:
    print("!! PATTERN NOT FOUND"); sys.exit(3)
open(path, "w").write(s.replace(frm, to, 1))
PY
  if [ $? -ne 0 ]; then
    echo "SKIP   ${NAMES[$i]} (pattern not found)"
    cp /tmp/mut-backup.js "$f"
    continue
  fi
  if bash game/tests/run-all.sh >/tmp/mut-out.txt 2>&1; then
    echo "SURVIVED  ${NAMES[$i]}"
    survivors=$((survivors+1))
  else
    caught=$(grep -E "^==" /tmp/mut-out.txt | tail -1 | sed 's/== //;s/ ==//' | cut -c1-46)
    echo "caught    ${NAMES[$i]}   <- $caught"
  fi
  cp /tmp/mut-backup.js "$f"
done
echo
echo "SURVIVORS: $survivors / ${#NAMES[@]}"
git -C /home/user/Opticon diff --stat | tail -2
