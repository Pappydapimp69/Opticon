// ui.js — DOM HUD, menu, overlays, log. Presentation only; main.js drives it.

import { DIRS } from "./map.js";

export class UI {
  constructor(root) {
    this.root = root;
    this.el = {
      menu: document.getElementById("menu"),
      hud: document.getElementById("hud"),
      turn: document.getElementById("turnLabel"),
      role: document.getElementById("roleLabel"),
      facing: document.getElementById("facingLabel"),
      mp: document.getElementById("mpLabel"),
      round: document.getElementById("roundLabel"),
      view: document.getElementById("viewLabel"),
      log: document.getElementById("log"),
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
  updateHud(game, viewMode, humanRole, showWatcherInfo) {
    const p = game.prisoners[game.activePrisoner] || game.prisoners[0];
    this.el.turn.textContent = game.turn;
    this.el.turn.className = "val " + (game.turn === "Watcher" ? "watcher" : "prisoner");
    this.el.facing.textContent = showWatcherInfo
      ? DIRS[game.watcher.facing] + (game.watcher.bluff != null ? `  (claims ${DIRS[game.watcher.bluff]})` : "")
      : "?";
    this.el.mp.textContent = "●".repeat(Math.max(0, p.mp)) + "○".repeat(Math.max(0, p.mpMax ? p.mpMax - p.mp : 3 - p.mp));
    this.el.round.textContent = game.round;
    this.el.view.textContent = viewMode;
    this.el.role.textContent = humanRole;

    const prisonerTurn = game.turn === "Prisoner";
    this.el.prisonerControls.classList.toggle("active", prisonerTurn);
    this.el.watcherControls.classList.toggle("active", !prisonerTurn);
  }

  renderLog(game) {
    const html = game.log
      .slice(0, 8)
      .map((l) => `<div class="logline"><span class="lr">R${l.round}</span> ${escapeHtml(l.msg)}</div>`)
      .join("");
    this.el.log.innerHTML = html;
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

  gameOver(game) {
    const won = game.winner === "Prisoner";
    this.el.overlay.classList.remove("hidden");
    this.el.overlayTitle.textContent = won ? "ESCAPED" : "CAPTURED";
    this.el.overlayTitle.className = won ? "escaped" : "captured";
    this.el.overlayText.textContent = won
      ? "You slipped past the eye and reached the gate. Freedom."
      : "The Watcher's gaze found you. The panopticon holds.";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
