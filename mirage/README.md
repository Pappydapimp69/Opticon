# MIRAGE

**A separate 3D game in this repo.** Not a mode of Opticon, not a reskin: its own
world, rules, renderer, HUD, audio and test suite, under `mirage/`. Opticon is a
turn-based asymmetric grid game about being watched. MIRAGE is a real-time
first-person game about a party of six whose minds run out.

> Status: **0.1.0**, playable end to end — title, run, debrief.

## The idea

You lead a survey party of six into a fogged basin: yourself and five companions.
Each of you carries a hidden **lucidity** meter. It only counts down. When one
hits zero, that mind begins to **hallucinate** — and that includes yours.

**The meters are never shown.** Not as a bar, not as a number, not on a hover.
The whole game is reading your party without instrumentation:

| What you see | What it means |
| --- | --- |
| someone lags behind | fraying |
| someone goes quiet who is normally chatty | fraying, and hiding it |
| "the ridge moved, I watched it move" | fraying, and not hiding it |
| someone breaks formation and walks off | brittle, heading for a pylon |
| someone tells you a marker is right here, and it isn't | gone |

You can **check in** on any companion. A fraying one shades it optimistic (the
stoic ones most of all). One who is gone will tell you they are fine, with
complete conviction. So a check-in is evidence, never proof.

And when **your** meter hits zero, the screen stops being a witness:

- markers appear where there is nothing
- a sixth companion joins the formation and keeps station
- spent pylons glow like full ones, and a pylon appears that was never built
- north stops being north
- every companion agrees with you about everything

Logging a marker while gone, with nobody lucid at your shoulder, writes a
**false entry**. It looks exactly like a real one in the log. It counts for
nothing at extraction.

## Goal

Find and survey all **six** markers, then get back to **camp** with at least two
companions still walking with you. Markers are not on a map — the party has to
sight them through the fog, so anyone still with you is another pair of eyes.

Relief comes from **pylons**: stand inside one and everyone in range comes back
up. They spend charge while in use and recharge while left alone, so you cannot
camp in one. Three **lumen doses** exist, for six people, and you have to pick
who gets one without being able to see who needs it most.

You lose to **darkness** (the light runs out) or to **dissolution** (all six of
you hallucinating at once, long enough that nobody is left to notice).

## Play

Static site, no build step:

```bash
# from the repo root — NOT from mirage/, see "Three.js" below
python3 -m http.server 8000
# then open http://localhost:8000/mirage/
```

### Controls

| | |
| --- | --- |
| move / run | `WASD` · `Shift` |
| look | mouse (click to capture) |
| survey a marker | `E` |
| check in | `1`–`5`, or `F` on the selected companion |
| lumen dose | `Shift`+`1`–`5`, or `G` on the selected |
| select companion | `Q` / `R` |
| pause | `Esc` |

Gamepad: stick to move, right stick to look, `A` survey, `X` check in, `Y` dose,
`LB`/`RB` select, `Start` pause. Touch: left half steers, right half looks,
buttons bottom-right.

## Structure

```
mirage/
  index.html          title / HUD / pause / debrief shells
  css/style.css       overlay styling (contains no meter — by design)
  lib/three.module.js re-export shim, see below
  src/
    rng.js            seeded determinism: a seed describes a whole run
    world.js          basin generation + the connectivity repair pass
    state.js          THE SIM — lucidity, hallucination, pylons, endings
    party.js          the five companions: follow, break, wander, talk
    percept.js        the ONLY module allowed to lie
    render.js         Three.js scene, drawn from perception
    hud.js            DOM overlay, drawn from perception
    input.js          keyboard/mouse/touch/gamepad -> one intent object
    audio.js          synthesised ambience; no assets
    main.js           wiring + frame loop
  tests/
    logic.test.mjs    58 pure-logic assertions, no browser
    balance.mjs       whole runs to a terminal state; completability oracle
    smoke.mjs         real Chromium: draws, drains, hallucinates, recovers
    run-all.sh
```

### The one architectural rule

`state.js` keeps an honest record. `percept.js` is the only place that may
distort it. `render.js` and `hud.js` read **perception**, never the sim.

That is what makes the hallucination testable: a phantom marker arrives in the
same list as the real ones, so the renderer needs no special case, and a test can
assert "a hallucinating lead is shown a marker the basin does not contain"
without booting a browser. The corresponding invariant — perception never mutates
the sim — is asserted in the test suite.

The one real number in the game is revealed exactly once, in the **debrief**,
after the run is over.

### Three.js

`mirage/lib/three.module.js` is a **one-line re-export** of Opticon's vendored
copy at `game/lib/three.module.js`, not a second 1.3 MB checkout. That is why the
dev server must run from the repo root. To make `mirage/` standalone-deployable,
replace that shim with the real file:

```bash
cp game/lib/three.module.js mirage/lib/three.module.js
```

Nothing else changes. See `docs/adr/0001-mirage-separate-game.md` for why it is a
shim, and the open tension **T12** (vendoring vs a build step) that it sits under.

## Tests

```bash
mirage/tests/run-all.sh          # everything
node mirage/tests/logic.test.mjs # pure logic, fast
node mirage/tests/balance.mjs 20 # whole-run simulations
node mirage/tests/smoke.mjs      # real browser (needs Playwright + Chromium)
```

Two things the suite is built around, both learned the hard way elsewhere in this
repo:

- **No assertion is phrased in wall-clock seconds.** Headless rAF runs at a
  fraction of real time (measured at 8–10 fps under software GL here), so
  "wait 3s, expect 3s of drain" is a flake. Tests drive the sim's own clock
  through `window.__mirage.advance(seconds)` and assert on `sim.time`.
- **"It loaded and nothing threw" is a false green for 3D.** Software GL will
  happily load a scene that draws nothing, so the smoke test asserts on Three's
  own draw-call and triangle counters — and reports SKIP, not PASS, when the
  environment has no WebGL at all.

`balance.mjs` is a **completability** oracle, not a difficulty oracle. The bot
reads the sim's truth directly, so the hallucination layer — the entire
difficulty for a human being shown things that are not there — costs it almost
nothing. Its win rates say the basin can be surveyed and returned from; they say
nothing about how hard that is to do.
