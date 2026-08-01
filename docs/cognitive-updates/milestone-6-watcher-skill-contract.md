# Milestone 6 — Watcher skills that say what they do

Covers `beta-0.42.0` → `beta-0.43.0`.

The Watcher skill rules were present and individually tested, but their
player-facing interaction was not one coherent system. Double Bluff's key and
chip called the rule without the direction it requires, Dispatch used a private
two-step gesture, three situational skills failed with only a blocked sound, and
the HUD still advertised four keys for five skills. Wide Scan also cleared an
existing bluff without preventing the player from adding a replacement before
the scan, bypassing its stated cost.

## What shipped

- Double Bluff and Dispatch now share one explicit `arm → choose direction`
  interaction across keyboard, on-screen controls, and gamepad.
- A bad same-direction Double Bluff target stays armed and explains how to
  recover instead of forcing the player to start the gesture over.
- Echo Memory, Remote Lock, Double Bluff, and cooling skills explain why they
  are unavailable; successful skills report the state they changed.
- Wide Scan now remains bluff-free until its scan is committed.
- Watcher hints advertise keys `5–9` and describe targeted-skill controls for
  the active input device.
- The focused browser suite now drives all five skills through the real game UI,
  checks blocked-state feedback, covers clickable controls and gamepad Dispatch,
  and polls actual hold transitions instead of assuming a fixed frame rate.
- Gamepad discovery now follows the connected pad with live activity instead of
  assuming the browser assigned the player's controller to slot 0. The intro
  accepts A, X, or Start, and the menu's Start button now honors a sustained
  Start-button hold as well as A.

## New Memory

- **Advertised controls are a separate contract from rules correctness.** A
  direct unit test proved that `useSkill(doubleBluff, direction)` worked while
  the real key/chip always supplied `null`. Browser coverage must activate every
  advertised verb from the surface a player actually uses, not merely prove
  that one representative action reaches the rules layer.
- **A staged action needs one explicit pending-action state.** Dispatch and
  Double Bluff both consume the next direction. Representing that as one
  `armedSkill` slot makes cancellation, turn cleanup, highlighting, and target
  routing mutually consistent instead of growing one boolean per skill.
- **Controller identity and button semantics are end-to-end contracts.** A
  browser can leave slot 0 empty after reconnecting a pad, and accepting Start
  as a menu-confirm edge is incomplete if the subsequent hold detector only
  watches A. Tests now place the fake pad in slot 2 and carry Start through the
  entire hold-to-launch gesture.

## New Tensions

None.

## New Exploration

None.

## Graduation Candidates

- The advertised-control contract generalizes to any game with parallel input
  surfaces: test each verb through its real orchestration path, because a green
  rules API does not prove the UI supplied the required arguments.
