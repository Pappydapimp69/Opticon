// ui.js — DOM HUD, menu, overlays, log. Presentation only; main.js drives it.

import { DIRS } from "./map.js";
import { ROUND_LIMIT } from "./rules.js";

export class UI {
  constructor(root) {
    this.root = root;
    this.el = {
      menu: document.getElementById("menu"),
      hud: document.getElementById("hud"),
      turn: document.getElementById("turnLabel"),
      role: document.getElementById("roleLabel"),
      roster: document.getElementById("rosterLabel"),
      facing: document.getElementById("facingLabel"),
      mp: document.getElementById("mpLabel"),
      mpStat: document.getElementById("mpStat"),
      gazeStat: document.getElementById("gazeStat"),
      round: document.getElementById("roundLabel"),
      view: document.getElementById("viewLabel"),
      overlay: document.getElementById("overlay"),
      overlayTitle: document.getElementById("overlayTitle"),
      overlayText: document.getElementById("overlayText"),
      banner: document.getElementById("banner"),
      watcherControls: document.getElementById("watcherControls"),
      prisonerControls: document.getElementById("prisonerControls"),
      hint: document.getElementById("hint"),
    };
    this._bannerTimer = null;
  }

  showMenu() {
    this.el.menu.classList.remove("hidden");
    this.el.hud.classList.add("hidden");
    this.el.overlay.classList.add("hidden");
  }

  showHud() {
    this.el.menu.classList.add("hidden");
    this.el.hud.classList.remove("hidden");
    this.el.overlay.classList.add("hidden");
  }

  // `showWatcherInfo`: only true for whoever is legitimately "being" the
  // Watcher right now. The prisoner must never learn the true gaze this way
  // either — that's the entire point of the asymmetry.
  // `humanControlsTurn`: a DIFFERENT question — is the human the one acting
  // RIGHT NOW (vs an AI opponent, or an AI companion's own turn within a
  // human-Prisoner group)? Gates which touch panel shows: the old code
  // toggled purely on game.turn, so a human Watcher saw the Prisoner's full
  // movement D-pad (and its on-screen hint text) appear during the AI's own
  // turn — controls that would silently no-op if tapped, since input
  // handling is already correctly gated elsewhere, but confusing to see.
  // `previewFacing`: the gaze the player is currently AIMING (a staged, not
  // yet committed rotation), or undefined when there is nothing staged. Shown
  // with a marker so a preview can never be mistaken for the real facing —
  // the whole point of staging is to decide before spending the turn's one
  // rotation, which needs the preview to be visibly provisional.
  // `revealGaze`: a Golden Feather was spent this round, so the TRUE facing
  // is shown to a Prisoner who would normally see "?". Narrower than
  // showWatcherInfo on purpose — it unlocks the facing and nothing else.
  updateHud(game, viewMode, humanRole, showWatcherInfo, humanControlsTurn, previewFacing, revealGaze) {
    const p = game.prisoners[game.activePrisoner] || game.prisoners[0];
    // With AI companions in play, name which one is acting — otherwise a
    // group of 3 reads identically to a lone prisoner on the Turn stat.
    this.el.turn.textContent =
      game.turn === "Prisoner" && game.prisoners.length > 1
        ? `Prisoner ${game.activePrisoner + 1}/${game.prisoners.length}`
        : game.turn;
    this.el.turn.className = "val " + (game.turn === "Watcher" ? "watcher" : "prisoner");
    const staged = previewFacing != null && previewFacing !== game.watcher.facing;
    this.el.facing.textContent = showWatcherInfo
      ? (staged ? `${DIRS[previewFacing]} ?` : DIRS[game.watcher.facing]) +
        (game.watcher.bluff != null ? `  (claims ${DIRS[game.watcher.bluff]})` : "")
      : revealGaze
        ? `${DIRS[game.watcher.facing]} 🪶`
        : "?";
    this.el.facing.classList.toggle("staged", !!staged && !!showWatcherInfo);
    this.el.facing.classList.toggle("revealed", !showWatcherInfo && !!revealGaze);
    // The Gaze slot is hidden for a Prisoner (it is a permanent "?"), but a
    // spent feather is exactly the moment it has something to say.
    if (this.el.gazeStat) this.el.gazeStat.classList.toggle("hidden", !showWatcherInfo && !revealGaze);
    this.el.mp.textContent = "●".repeat(Math.max(0, p.mp)) + "○".repeat(Math.max(0, p.mpMax ? p.mpMax - p.mp : 3 - p.mp));
    // Move is the Prisoner's resource; Gaze is the Watcher's. Showing both to
    // both roles meant a Watcher read a movement meter that was never theirs
    // and a Prisoner read a permanent "?" — two dead slots on a rail that has
    // to fit one line on a phone.
    const humanIsWatcher = humanRole === "Watcher";
    if (this.el.mpStat) this.el.mpStat.classList.toggle("hidden", humanIsWatcher);
    // Show the cap, and warn once it's genuinely close — a limit nobody can
    // see isn't pressure, it's an ambush.
    this.el.round.textContent = `${game.round}/${ROUND_LIMIT}`;
    const left = ROUND_LIMIT - game.round;
    this.el.round.classList.toggle("urgent", left <= 10);
    this.el.view.textContent = viewMode;
    this.el.role.textContent = humanRole;
    this.renderRoster(game);

    const prisonerTurn = game.turn === "Prisoner";
    this.el.prisonerControls.classList.toggle("active", prisonerTurn && humanControlsTurn);
    this.el.watcherControls.classList.toggle("active", !prisonerTurn && humanControlsTurn);
  }

  // `showWatcherInfo`: same gate as updateHud — only true for whoever is
  // legitimately "being" the Watcher right now. A `watcherOnly` log entry
  // (the real rotation) is dropped entirely for anyone else, not just
  // hidden in the HUD — a text log the Prisoner could read was leaking the
  // Watcher's true facing on every rotation.
  // The scrolling event log was removed from the HUD: it competed with the
  // 3D scene for attention and players reported never reading it. The
  // banner + exposure vignette + noise pings carry the same information
  // diegetically. game.log is still maintained in rules.js (it's the
  // authoritative event record the tests assert against, and the
  // `watcherOnly` filtering below is the leak guard), it just isn't drawn.
  renderLog(game, showWatcherInfo) {
    return game.log.filter((l) => !l.watcherOnly || showWatcherInfo);
  }

  // One pip per prisoner: filled = still running, struck = caught, ringed =
  // already out through the gate. Replaces the removed log as the way you
  // learn a companion went down. Hidden entirely for a lone prisoner, where
  // it would just restate the Move stat.
  renderRoster(game) {
    const el = this.el.roster;
    if (!el) return;
    if (game.prisoners.length < 2) {
      el.textContent = "";
      el.parentElement.classList.add("hidden");
      return;
    }
    el.parentElement.classList.remove("hidden");
    el.innerHTML = game.prisoners
      .map((p, i) => {
        const state = p.escaped ? "out" : !p.alive ? "down" : "run";
        const active = game.turn === "Prisoner" && game.activePrisoner === i ? " act" : "";
        const glyph = p.escaped ? "◎" : !p.alive ? "✕" : "●";
        return `<span class="pip ${state}${active}" title="Prisoner ${i + 1}">${glyph}</span>`;
      })
      .join("");
  }

  banner(text, cls = "") {
    const b = this.el.banner;
    b.textContent = text;
    b.className = "banner show " + cls;
    if (this._bannerTimer) clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => (b.className = "banner"), 1600);
  }

  hint(text) {
    if (this.el.hint) this.el.hint.textContent = text || "";
  }

  gameOver(game, meta = {}) {
    const won = game.winner === "Prisoner";
    this.el.overlay.classList.remove("hidden");
    this.el.overlayTitle.textContent = won ? "ESCAPED" : game.timedOut ? "TIME UP" : "CAPTURED";
    this.el.overlayTitle.className = won ? "escaped" : "captured";
    const flavor = won
      ? "You slipped past the eye and reached the gate. Freedom."
      : game.timedOut
        ? "Time ran out. Nobody reached the gate — the panopticon holds."
        : "The Watcher's gaze found you. The panopticon holds.";
    const roundWord = game.round === 1 ? "round" : "rounds";
    const stats = `${flavor} (${game.round} ${roundWord}${meta.difficulty ? `, ${meta.difficulty}` : ""})`;
    // The running record is the reason to press Play again, so it belongs on
    // the screen that offers that button — not only back on the menu.
    this.el.overlayText.textContent = meta.record ? `${stats}\n${meta.record}` : stats;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
