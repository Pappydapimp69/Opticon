# ADR 0001 — MIRAGE is a separate game in this repo, not an Opticon mode

**Status:** accepted · 2026-07-30 · applies to `mirage/`

## Context

The brief: a 3D game where the player leads a party of five NPCs exploring an
area, each NPC carrying an invisible meter that counts down; at zero that NPC
begins to hallucinate — and so does the player.

Opticon already exists in this repo: a turn-based, grid-based, asymmetric game
about surveillance, with its own rules engine, renderer, AI and test suite. The
new brief shares almost nothing with it mechanically — real-time movement instead
of turns, a cooperative party instead of an adversary, and hidden state whose
whole point is that it corrupts the presentation rather than being displayed.

## Decision

Build it as a **separate game** under `mirage/`, with its own `index.html`, `src/`,
`css/`, and `tests/`. No Opticon module is imported and no Opticon module is
modified. The only shared file is the vendored third-party library (below).

### Consequences

- Opticon's behaviour is untouched; its test suite still passes unchanged.
- The two games can be developed and versioned independently.
- Some structural ideas are re-implemented rather than shared (grid BFS, a
  seeded RNG, a headless test harness). That duplication is accepted: the
  alternative is a shared "engine" layer extracted from one game to serve a
  second with different requirements, which would couple both to a design that
  neither actually wants. If a third game appears, revisit.

## Sub-decision: Three.js is a re-export shim, not a second copy

`mirage/lib/three.module.js` is one line:

```js
export * from "../../game/lib/three.module.js";
```

Three's ESM build is 1.3 MB. Copying it would double that in the repo for no
benefit and would directly worsen the open tension **T12** (*vendoring Three.js
(repo bloat) vs a build step / CDN*). Routing every MIRAGE import through one shim
file keeps the coupling to a single line that is trivially swapped for the real
file when `mirage/` needs to be deployed standalone.

**Cost, stated plainly:** the dev server must be run from the repo root, and the
existing Pages workflow — which publishes `game/` as the site root — cannot serve
MIRAGE without either a workflow change or that `cp`. Neither is done here,
because publishing was not part of the brief.

## Sub-decision: perception is a separate module from state

`state.js` holds the truth. `percept.js` is the only module permitted to distort
it. `render.js` and `hud.js` read perception and never the sim.

The alternative — special-casing "am I hallucinating?" inside the renderer and the
HUD — would scatter the lie across the presentation layer, where it could not be
tested without a browser and where every new UI element would need to remember to
lie. With the split, a phantom marker arrives in the same list as the real ones,
the renderer needs no special case at all, and the deceit is asserted in pure
Node: *a hallucinating lead is shown a marker the basin does not contain, and the
sim's own record stays clean.*

## Sub-decision: the meter is never rendered

No bar, no number, no hover, at any lucidity. The roster shows the lead's
qualitative read ("lagging", "breaking off", "shaking"), which degrades to "you
can't tell" when the lead is the unreliable one. The real values appear exactly
once, in the post-run debrief.

This is the game, so it is enforced rather than merely intended: a test asserts
that the roster read-out contains no digits, and the smoke test asserts that the
live HUD renders nothing that looks like a meter.
