// hud.js — the DOM overlay. Reads PERCEPTION, never the sim's hidden numbers.
//
// There is no lucidity bar, and that is a design rule rather than an omission:
// the roster shows the lead's own qualitative read of each companion ("lagging",
// "breaking off", "shaking"), which degrades to "you can't tell" when the lead is
// the one hallucinating. The only place a real number is ever printed is the
// debrief, after the run is over.

import { perceivedYaw, rosterRead, distortion, filterReport } from "./percept.js";
import { LOG_RADIUS, TIME_LIMIT, discoveredCount } from "./state.js";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function createHud(sim, percept) {
  const el = {
    roster: document.getElementById("roster"),
    survey: document.getElementById("surveyCount"),
    found: document.getElementById("foundCount"),
    doses: document.getElementById("doseCount"),
    compass: document.getElementById("compass"),
    clock: document.getElementById("clock"),
    subtitles: document.getElementById("subtitles"),
    prompt: document.getElementById("actionPrompt"),
    vignette: document.getElementById("vignette"),
    hints: document.getElementById("hints"),
    selection: document.getElementById("selectionLabel"),
  };

  // Build the roster once; only the read-out text changes per frame.
  const rows = new Map();
  el.roster.innerHTML = "";
  for (const c of sim.companions) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML =
      `<span class="r-key">${c.index}</span>` +
      `<span class="r-name">${c.name}</span>` +
      `<span class="r-role">${c.role}</span>` +
      `<span class="r-read"></span>`;
    el.roster.appendChild(row);
    rows.set(c.id, { row, read: row.querySelector(".r-read") });
  }

  const lines = [];
  function say(text, cls = "") {
    lines.push({ text, cls, t: sim.time });
    if (lines.length > 4) lines.shift();
    el.subtitles.innerHTML = lines
      .map((l, i) => `<div class="sub ${l.cls}" style="opacity:${0.35 + (i / lines.length) * 0.65}">${l.text}</div>`)
      .join("");
  }

  /** Drain the sim's event queue into subtitles. Called once per frame. */
  function pumpEvents() {
    for (const ev of sim.events) {
      if (ev.kind === "chatter" || ev.kind === "report") say(ev.text, ev.gone ? "gone" : "");
      else if (ev.kind === "break") say(ev.text, "warn");
      else if (ev.kind === "hallucinate") say(ev.text, "gone");
      else if (ev.kind === "recover") say(ev.text, "good");
      else if (ev.kind === "log") say(ev.text, "good");
      else if (ev.kind === "logFalse") say(ev.text, "gone");
      else if (ev.kind === "dose") say(ev.text, "good");
      else if (ev.kind === "end") say(ev.text, "warn");
    }
  }

  /** A check-in the player asked for, passed through the lead's own filter. */
  function showReport(report) {
    const filtered = filterReport(percept, sim, report);
    if (!filtered) return;
    say(`${filtered.name}: ${filtered.text}`, filtered.claim === "gone" ? "gone" : "");
  }

  function nearestUnloggedName() {
    let best = null, bestD = Infinity;
    for (const m of sim.monoliths) {
      if (m.logged) continue;
      const d = Math.hypot(m.x - sim.player.x, m.z - sim.player.z);
      if (d < bestD) { bestD = d; best = m; }
    }
    // Phantoms count for the prompt — the whole point is that the lead cannot
    // tell the difference from where they are standing.
    for (const ph of percept.active ? percept.phantomMonoliths : []) {
      const d = Math.hypot(ph.x - sim.player.x, ph.z - sim.player.z);
      if (d < bestD) { bestD = d; best = ph; }
    }
    return bestD <= LOG_RADIUS ? best : null;
  }

  function update(view, selected) {
    pumpEvents();

    for (const c of sim.companions) {
      const { row, read } = rows.get(c.id);
      const r = rosterRead(percept, sim, c);
      read.textContent = r.note;
      row.className = `roster-row tag-${r.tag.replace(/\s+/g, "-")}` +
        (r.uncertain ? " uncertain" : "") +
        (sim.companions[selected] === c ? " selected" : "");
    }
    if (el.selection) el.selection.textContent = sim.companions[selected]?.name || "";

    const logged = sim.monoliths.filter((m) => m.logged).length;
    // The counter shows the LOG's length, not the truth — a false entry looks
    // exactly like a real one until the debrief.
    el.survey.textContent = `${sim.logEntries.length} / ${sim.monoliths.length}`;
    el.survey.classList.toggle("complete", logged >= sim.monoliths.length);
    if (el.found) el.found.textContent = `${discoveredCount(sim)} / ${sim.monoliths.length}`;
    el.doses.textContent = String(sim.doses);

    const yaw = perceivedYaw(percept, sim);
    const oct = ((Math.round((-yaw / (Math.PI * 2)) * 8) % 8) + 8) % 8;
    el.compass.textContent = COMPASS[oct];

    const left = Math.max(0, TIME_LIMIT - sim.time);
    el.clock.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
    el.clock.classList.toggle("low", left < 120);

    const dis = distortion(percept, sim);
    el.vignette.style.opacity = String(Math.min(0.92, dis * 0.9));
    el.vignette.classList.toggle("lost", percept.active);

    const near = nearestUnloggedName();
    if (near && sim.status === "playing") {
      el.prompt.textContent = `Survey ${near.name}`;
      el.prompt.classList.add("show");
    } else {
      el.prompt.classList.remove("show");
    }
  }

  function setHints(scheme) {
    const text = {
      keyboard: "WASD move · Shift run · E survey · 1–5 check in · Shift+1–5 dose · Esc pause",
      gamepad: "Stick move · A survey · X check in · Y dose · LB/RB select · Start pause",
      touch: "Left half steers · right half looks · buttons bottom-right",
    }[scheme] || "";
    if (el.hints) el.hints.textContent = text;
  }

  return { update, say, showReport, setHints, el };
}

/** The debrief screen — the one and only place hidden state is revealed. */
export function renderDebrief(container, report) {
  const verdict =
    report.status === "won"
      ? "SURVEY COMPLETE"
      : report.ending === "dissolved"
        ? "THE PARTY DISSOLVED"
        : "DARK";
  const falseNote = report.falseLogs
    ? `<p class="debrief-warn">${report.falseLogs} entr${report.falseLogs === 1 ? "y was" : "ies were"} written at nothing.</p>`
    : "";
  container.innerHTML = `
    <div class="debrief-card">
      <h2>${verdict}</h2>
      <p class="debrief-sub">${report.logged} of ${report.total} markers really surveyed · ${Math.floor(report.time / 60)}m ${report.time % 60}s</p>
      ${falseNote}
      <table class="debrief-table">
        <tr><th>Who</th><th>Lucidity</th><th>State</th><th>Scars</th><th>Lost to it</th></tr>
        ${report.party
          .map(
            (p) => `<tr class="${p.hallucinating ? "row-gone" : ""}">
          <td>${p.name}</td><td>${p.lucidity}</td>
          <td>${p.hallucinating ? "hallucinating" : p.band}</td>
          <td>${p.scars}</td><td>${p.goneSeconds}s</td></tr>`,
          )
          .join("")}
      </table>
      <p class="debrief-foot">Doses used ${report.doseUses} · recoveries ${report.recoveries}</p>
      <button id="againBtn" class="big-btn">New basin</button>
    </div>`;
}
