# Opticon 3D

A browser remake of **Opticon** — an asymmetric game of surveillance and doubt,
inspired by Bentham's Panopticon. One side is the all-seeing **Watcher** in the
central tower; the other is a **Prisoner** sneaking through concentric rings
toward the escape gate. The Watcher never sees prisoners directly — only their
noise and the tiles the light betrays.

> Status: **public beta (`beta-0.x`)**. Single-player vs. AI and 2-player
> hotseat are playable end to end.

## Play

Open `game/index.html` from any static web server (ES modules require `http://`,
not `file://`). Three.js is vendored locally in `game/lib/`, so the game runs
fully offline with no build step and no CDN.

```bash
# from the repo root
cd game && python3 -m http.server 8000
# then open http://localhost:8000/
```

### Modes
- **Prisoner (vs AI Watcher)** — reach the green gate without being caught.
- **Watcher (vs AI Prisoner)** — you never see the prisoner; hunt by inference.
- **2P Hotseat** — pass the device; the prisoner's position is hidden on the
  Watcher's turn.

### Controls
| | Prisoner | Watcher |
|---|---|---|
| Move / act | `WASD` / arrows (≤3 tiles/turn) | — |
| Rotate gaze 90° | — | `Q` / `E` |
| Bluff a direction | — | `1` `2` `3` `4` (N/E/S/W) |
| End turn (Watcher scans) | `Space` / `Enter` | `Space` / `Enter` |
| Cycle camera | `V` / `Tab` | `V` / `Tab` |
| Restart | `R` | `R` |
| Orbit / zoom | drag / scroll / pinch | drag / scroll / pinch |

Touch buttons and gamepads (D-pad/stick, A, LB/RB, face buttons) also work.

## Rules in brief
- A **single step is quiet**. Moving **2+ tiles** in a turn drops a *noise
  marker* on the tile you started from. **Glass** always makes noise.
- The Watcher can only **rotate 90°/turn** and may **bluff** a second direction
  to spread paranoia. On scanning, a prisoner inside the *true* 90° gaze wedge
  who is **lit or making noise** is **captured**.
- **Doors** open silently (1 move). **Switches** toggle nearby **lights**
  (dark = safe, lit = exposed). Reach the **gate** in the outer ring to escape.
- Fairness rails: the Watcher never sees prisoners directly; the first round is a
  grace period; you spawn in shadow.

## Architecture
Pure logic is isolated from rendering so it can be tested in Node and reused by
both AIs.

```
game/
  index.html            shell: menu, HUD, touch controls, overlays
  css/style.css
  lib/three.module.js   vendored Three.js r160 (offline, no CDN)
  src/
    map.js              procedural panopticon (tower/moat/rings/props), seedable
    rules.js            pure game state: movement, noise, FoV, gaze capture, win/lose
    pathfind.js         BFS navigation shared by the AIs
    watcherAI.js        Watcher opponent — reasons from public signals only
    prisonerAI.js       Prisoner opponent — BFS toward gate, avoids lit gaze
    render.js           Three.js scene, instanced tiles, cameras, wedges, FoV
    input.js            keyboard + touch + gamepad → intents
    audio.js            WebAudio SFX + ambient drone
    ui.js               DOM HUD / menu / overlays
    main.js             orchestration + game loop
  tests/                Node logic + headless Chromium checks
```

## Tests
```bash
node game/tests/logic.test.mjs     # pure-logic assertions
node game/tests/balance.mjs 300    # simulate games: both outcomes reachable
node game/tests/smoke.mjs prisoner # headless boot + play, console-error check
node game/tests/wincheck.mjs       # escape end-screen in a real browser
```

`tests/run-all.sh` runs everything. Headless tests use the pre-installed
Chromium via Playwright.

## Roadmap beyond beta
- Online multiplayer (the co-op/save-schema question is tracked in Brain T3).
- Multiple prisoners; richer light/shadow; ranked difficulty tuning.
- Level themes and a short campaign.
