// percept.js — the only module in MIRAGE that is allowed to lie.
//
// state.js keeps an honest record of the basin. This file answers a different
// question: what does the LEAD believe is in front of them right now? While the
// player is lucid the two agree exactly. Once the player's meter hits zero, the
// perceived world diverges from the real one — and because the renderer and HUD
// draw from HERE and never from the sim directly, the screen itself becomes an
// unreliable narrator.
//
// Keeping the deceit in one pure module is what makes it testable: a test can
// assert "a hallucinating lead is shown a marker the sim does not contain"
// without booting a browser.

import { HALLUCINATION, BAND, bandOf } from "./state.js";

const PHANTOM_NAMES = ["the Sixth Stone", "the Watching Slab", "the Other Cairn", "the Hollow Tooth"];
const PHANTOM_COMPANIONS = ["ODEN", "MARIS", "THE SEVENTH"];

export function createPercept() {
  return {
    active: false, // is the LEAD hallucinating
    kind: null,
    since: 0,
    intensity: 0, // 0..1, ramps in and out so the shift is felt, not flicked
    phantomMonoliths: [],
    phantomCompanions: [],
    phantomPylons: [],
    deadPylonsLookLive: new Set(),
    compassOffset: 0,
    swayPhase: 0,
    whisper: null,
  };
}

// Build the specific lie once, at onset, so it is stable while it lasts. A
// hallucination that re-randomises every frame reads as a graphics bug; one that
// holds still reads as a place.
function seedHallucination(percept, sim) {
  const rng = sim.rng;
  percept.phantomMonoliths = [];
  percept.phantomCompanions = [];
  percept.phantomPylons = [];
  percept.deadPylonsLookLive = new Set();
  percept.compassOffset = 0;

  switch (percept.kind) {
    case HALLUCINATION.PHANTOM_MARKER: {
      // One or two monoliths that do not exist, placed just off the lead's path
      // so they are found the way a real one would be.
      const n = rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        const a = rng.float(0, Math.PI * 2);
        const r = rng.float(14, 30);
        percept.phantomMonoliths.push({
          id: `ph-m${i}`,
          name: rng.pick(PHANTOM_NAMES),
          x: sim.player.x + Math.cos(a) * r,
          z: sim.player.z + Math.sin(a) * r,
          phantom: true,
        });
      }
      break;
    }
    case HALLUCINATION.DOUBLED_PARTY: {
      // A companion you do not have, walking the formation slot nobody filled.
      percept.phantomCompanions.push({
        id: "ph-c0",
        name: rng.pick(PHANTOM_COMPANIONS),
        role: "—",
        x: sim.player.x - 3,
        z: sim.player.z - 3,
        phantom: true,
        slot: rng.float(0, Math.PI * 2),
      });
      break;
    }
    case HALLUCINATION.FALSE_ANCHOR: {
      // A pylon that isn't, and every spent pylon reading as full. This one is
      // cruel: relief is exactly what you are looking for by the time it lands.
      const a = rng.float(0, Math.PI * 2);
      percept.phantomPylons.push({
        id: "ph-p0",
        x: sim.player.x + Math.cos(a) * rng.float(12, 24),
        z: sim.player.z + Math.sin(a) * rng.float(12, 24),
        phantom: true,
        charge: 100,
      });
      for (const p of sim.pylons) if (p.charge <= 0) percept.deadPylonsLookLive.add(p.id);
      break;
    }
    case HALLUCINATION.WRONG_WAY:
      percept.compassOffset = rng.pick([-1, 1]) * rng.float(1.1, 2.4); // radians
      break;
    case HALLUCINATION.CHORUS:
      percept.whisper = "agreement";
      break;
    default:
      break;
  }
}

/** Advance the perceived world. Call once per tick, after state.tick. */
export function updatePercept(percept, sim, dt) {
  const p = sim.player;
  if (p.hallucinating && !percept.active) {
    percept.active = true;
    percept.kind = p.hallucination;
    percept.since = sim.time;
    seedHallucination(percept, sim);
  } else if (!p.hallucinating && percept.active) {
    percept.active = false;
    percept.kind = null;
    percept.whisper = null;
  }

  const target = percept.active ? 1 : 0;
  // Ramp in over ~2.5s, out over ~1.2s.
  const rate = target > percept.intensity ? 0.4 : 0.85;
  percept.intensity += Math.sign(target - percept.intensity) * Math.min(Math.abs(target - percept.intensity), rate * dt);
  percept.swayPhase += dt * (0.6 + percept.intensity * 1.8);

  // A doubled companion keeps station like a real one, which is why it works.
  for (const ph of percept.phantomCompanions) {
    ph.slot += dt * 0.15;
    const tx = p.x + Math.sin(ph.slot) * 5.2;
    const tz = p.z + Math.cos(ph.slot) * 5.2;
    ph.x += (tx - ph.x) * Math.min(1, dt * 1.4);
    ph.z += (tz - ph.z) * Math.min(1, dt * 1.4);
  }
  return percept;
}

/**
 * How badly the presentation should be distorted, 0..1. Drives fog colour, camera
 * sway, and the audio bed. Below zero-lucidity there is a small pre-echo so the
 * lead gets *some* warning about themselves — the player's own tells.
 */
export function distortion(percept, sim) {
  const l = sim.player.lucidity;
  const pre = l <= 0 ? 0 : l < 14 ? 0.3 : l < 36 ? 0.15 : l < 62 ? 0.05 : 0;
  return Math.max(pre, percept.intensity);
}

/** Markers as the lead sees them: the real ones, plus any that aren't. */
export function perceivedMonoliths(percept, sim) {
  const real = sim.monoliths.map((m) => ({ ...m, phantom: false }));
  return percept.active ? [...real, ...percept.phantomMonoliths] : real;
}

/** Pylons as the lead sees them — including spent ones reading as charged. */
export function perceivedPylons(percept, sim) {
  const real = sim.pylons.map((p) => ({
    ...p,
    phantom: false,
    looksLive: p.charge > 0 || (percept.active && percept.deadPylonsLookLive.has(p.id)),
  }));
  return percept.active ? [...real, ...percept.phantomPylons.map((p) => ({ ...p, looksLive: true }))] : real;
}

/** Companions as the lead sees them, phantoms included. */
export function perceivedCompanions(percept, sim) {
  const real = sim.companions.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    x: c.x,
    z: c.z,
    hallucinating: c.hallucinating,
    goalKind: c.goalKind,
    phantom: false,
  }));
  return percept.active ? [...real, ...percept.phantomCompanions] : real;
}

/** The heading the lead thinks they are facing. */
export function perceivedYaw(percept, sim) {
  return sim.player.yaw + (percept.active ? percept.compassOffset : 0);
}

/**
 * Filter a check-in through the LISTENER's state. The speaker already shaded it
 * in state.checkIn; this is the second filter, and the reason a report is never
 * evidence on its own.
 */
export function filterReport(percept, sim, report) {
  if (!report) return null;
  if (!percept.active) return report;
  const rng = sim.rng;
  if (percept.kind === HALLUCINATION.CHORUS) {
    // Everyone agrees with you. Everyone is fine. Nothing needs doing.
    return { ...report, claim: BAND.STEADY, text: "…fine. We're all fine. Keep going.", filtered: true };
  }
  if (rng.chance(0.6)) {
    const bands = [BAND.STEADY, BAND.UNSETTLED, BAND.FRAYING, BAND.BRITTLE];
    return { ...report, claim: rng.pick(bands), text: garble(report.text, rng), filtered: true };
  }
  return { ...report, filtered: true };
}

function garble(text, rng) {
  const words = text.split(" ");
  if (words.length < 3) return text;
  const i = rng.int(0, words.length - 2);
  return words.slice(0, i).concat(["—"], words.slice(i + 1)).join(" ");
}

/**
 * What the roster should show for a companion. Deliberately NOT a number: a
 * qualitative read the lead has formed from behaviour, degraded by the lead's
 * own state. The literal `lucidity` value never reaches the HUD.
 */
export function rosterRead(percept, sim, companion) {
  // "unknown" rather than a literal "?" so it is a usable CSS class and a
  // greppable value; the player-facing text is the note.
  if (percept.active) return { tag: "unknown", note: "you can't tell", uncertain: true };
  const band = bandOf(companion.lucidity);
  const lagging = Math.hypot(companion.x - sim.player.x, companion.z - sim.player.z) > 9;
  if (companion.hallucinating) return { tag: "gone", note: "not with us", uncertain: false };
  if (companion.goalKind === "pylon") return { tag: "breaking off", note: "heading for a pylon", uncertain: false };
  if (band === BAND.BRITTLE) return { tag: "bad", note: "shaking", uncertain: false };
  if (lagging) return { tag: "lagging", note: "falling behind", uncertain: false };
  if (band === BAND.FRAYING) return { tag: "off", note: "talking to the ridge", uncertain: false };
  if (band === BAND.UNSETTLED) return { tag: "quiet", note: "quieter than usual", uncertain: false };
  return { tag: "ok", note: "steady", uncertain: false };
}
