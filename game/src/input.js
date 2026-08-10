// PAD_SLOT_COUNT — the range LT/RT cycle over for both item slots
// (Prisoner, max ITEM_CAP=2) and skill slots (Watcher, one per SKILLS
// entry). Must be >= SKILLS' count in rules.js, or a skill past this range
// is simply unreachable via gamepad — this bit Dispatch specifically: the
// cursor used to wrap at 4 while SKILLS had grown to 5 entries, so no
// amount of LT presses could ever land on it. Cycling past an item's own
// (smaller) count is harmless — armItemSlot() no-ops on an empty slot.
const PAD_SLOT_COUNT = 5;

// input.js — Unified input: keyboard, on-screen touch buttons, gamepad.
// All dispatch is by `mode` ('intro' | 'menu' | 'game') so the same devices
// drive whichever screen is up. Tracks the active scheme so the UI can show
// device-appropriate hints (Brain: device-adaptive-ui / show-the-active-scheme).
// Gamepad is polled every frame and its gate is independent of audio's
// (Brain dog#E47): a gamepad button press is what reveals the pad in Chrome.

export class Input {
  constructor(onIntent, opts = {}) {
    this.onIntent = onIntent;
    this.onScheme = opts.onScheme || (() => {});
    this.mode = "game";
    this.keys = new Set();
    this.padPrev = [];
    this.padPressed = []; // current-frame gamepad button state, for hold checks
    this.activePadIndex = null;
    this.activePadKey = null;
    this._stickHeld = false;
    this.slotCursor = 0; // gamepad item/skill slot selection (LT cycles, RT fires)
    this.activeScheme = "keyboard";
    this.menuHandlers = null; // { navX(dir), navY(dir), select(), back() }
    this.passHandler = null; // () => void — hotseat "pass the device" gate
    this._bindKeyboard();
    window.addEventListener("gamepadconnected", () => this._setScheme("gamepad"));
  }

  setScheme(s) { this._setScheme(s); }
  _setScheme(s) {
    if (this.activeScheme === s) return;
    this.activeScheme = s;
    this.onScheme(s);
  }

  setMenuHandlers(navX, navY, select, back) { this.menuHandlers = { navX, navY, select, back }; }
  setPassHandler(fn) { this.passHandler = fn; }
  // Raw held-state (not edge-triggered) — for press-and-hold confirms, where
  // an intent callback per keydown isn't enough.
  isHeld(code) { return this.keys.has(code); }
  isPadHeld(i) { return !!(this.padPressed && this.padPressed[i]); }

  _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (this.keys.has(e.code)) return; // ignore auto-repeat
      this.keys.add(e.code);
      this._setScheme("keyboard");
      this._handleKey(e);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  _handleKey(e) {
    // Function keys (F1-F12, incl. F11 fullscreen) are never game controls —
    // let the browser handle them natively in every mode, rather than
    // swallowing the event via a mode branch's blanket preventDefault()
    // below (intro/pass previously ate every key unconditionally).
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) return;
    // Intro: requires a HOLD (Space), read directly via isHeld() and polled
    // in main.js's loop() — a single keydown must not dismiss it, so this
    // just swallows the event without dispatching anything.
    if (this.mode === "intro") {
      e.preventDefault();
      return;
    }
    // Hotseat pass-the-device gate: any key reveals the next player's turn.
    if (this.mode === "pass") {
      if (this.passHandler) this.passHandler();
      e.preventDefault();
      return;
    }
    // Menu: arrows/WASD move focus on their own axis only, Enter/Space
    // confirms (or holds, for the final stage — see main.js), Backspace/Esc
    // goes back a stage. Holding Enter/Space is read directly via isHeld()
    // for the hold-to-start stage, so no dedicated keydown case is needed
    // beyond the normal confirm dispatch below.
    if ((this.mode === "menu" || this.mode === "overlay") && this.menuHandlers) {
      const { navX, navY, select, back } = this.menuHandlers;
      const m = {
        ArrowUp: () => navY(-1), KeyW: () => navY(-1),
        ArrowDown: () => navY(1), KeyS: () => navY(1),
        ArrowLeft: () => navX(-1), KeyA: () => navX(-1),
        ArrowRight: () => navX(1), KeyD: () => navX(1),
        Enter: () => select(), Space: () => select(),
        Backspace: () => back(), Escape: () => back(),
      };
      if (m[e.code]) { e.preventDefault(); m[e.code](); }
      return;
    }
    // Game. Shift+direction breaks a window that direction instead of moving
    // — a deliberate modifier so breaking is always an explicit choice, never
    // accidental fallout of just trying to walk somewhere.
    const moveOrBreak = (dir) => () => this.onIntent(e.shiftKey ? "break" : "move", dir);
    const map = {
      ArrowUp: moveOrBreak(0), KeyW: moveOrBreak(0),
      ArrowRight: moveOrBreak(1), KeyD: moveOrBreak(1),
      ArrowDown: moveOrBreak(2), KeyS: moveOrBreak(2),
      ArrowLeft: moveOrBreak(3), KeyA: moveOrBreak(3),
      Space: () => this.onIntent("endTurn"), Enter: () => this.onIntent("endTurn"),
      KeyQ: () => this.onIntent("rotate", -1), KeyE: () => this.onIntent("rotate", 1),
      // 1-4 are overloaded by side, which never collides: only one role's
      // intents are recognized per turn (see main.js's
      // handlePrisonerIntent / handleWatcherIntent split), so on the
      // Prisoner's turn these select an inventory slot, and on the
      // Watcher's they declare a bluff direction.
      Digit1: () => { this.onIntent("item", 0); this.onIntent("bluff", 0); },
      Digit2: () => { this.onIntent("item", 1); this.onIntent("bluff", 1); },
      Digit3: () => this.onIntent("bluff", 2), Digit4: () => this.onIntent("bluff", 3),
      // 5-9: Watcher skills. Prisoner-turn presses are ignored by
      // handlePrisonerIntent, same one-role-per-turn split as 1-4 above.
      Digit5: () => this.onIntent("skill", "doubleBluff"),
      Digit6: () => this.onIntent("skill", "wideScan"),
      Digit7: () => this.onIntent("skill", "echo"),
      Digit8: () => this.onIntent("skill", "lock"),
      Digit9: () => this.onIntent("skill", "dispatch"),
      Tab: () => this.onIntent("cycleView"), KeyV: () => this.onIntent("cycleView"),
      // Fight the cuffs. Only meaningful in custody, and ignored otherwise —
      // its own key rather than an overload of Space, because ending your turn
      // and spending your turn trying to get out are different decisions and
      // you only get three of them.
      KeyF: () => this.onIntent("struggle"),
      KeyR: () => this.onIntent("restart"),
    };
    if (map[e.code]) {
      if (e.code === "Tab" || e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
      map[e.code]();
    }
  }

  bindTouchButtons(root) {
    root.querySelectorAll("[data-intent]").forEach((btn) => {
      const fire = (ev) => {
        ev.preventDefault();
        this._setScheme("touch");
        const intent = btn.getAttribute("data-intent");
        const arg = btn.getAttribute("data-arg");
        this.onIntent(intent, arg != null ? Number(arg) : undefined);
      };
      btn.addEventListener("touchstart", fire, { passive: false });
      btn.addEventListener("mousedown", fire);
    });
  }

  bindCanvasOrbit(canvas, onOrbit, onZoom) {
    const start = (x, y) => { this.orbitDrag = true; this.lastX = x; this.lastY = y; };
    const move = (x, y) => {
      if (!this.orbitDrag) return;
      onOrbit((x - this.lastX) * 0.008, (y - this.lastY) * 0.006);
      this.lastX = x; this.lastY = y;
    };
    const end = () => (this.orbitDrag = false);
    canvas.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    window.addEventListener("mouseup", end);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); onZoom(Math.sign(e.deltaY) * 1.2); }, { passive: false });
    let pinch = 0;
    canvas.addEventListener("touchstart", (e) => {
      this._setScheme("touch");
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) pinch = touchDist(e);
    }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) { const d = touchDist(e); onZoom((pinch - d) * 0.03); pinch = d; }
    }, { passive: true });
    canvas.addEventListener("touchend", end);
  }

  // Called every frame. Reads the pad once, marks the scheme on any activity,
  // and dispatches by mode.
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const available = Array.from(pads || []).filter((p) => p && p.connected !== false);
    if (!available.length) {
      this.activePadIndex = null;
      this.activePadKey = null;
      this.padPrev = [];
      this.padPressed = [];
      return;
    }

    // Gamepad slots are stable only for the lifetime of one connection. A
    // reconnect, Steam Input, or another virtual controller can leave slot 0
    // empty/idle while the controller the player is pressing lives at 1-3.
    // Prefer whichever pad has live activity, otherwise keep the last active
    // pad, then fall back to the first connected one.
    const hasActivity = (p) =>
      Array.from(p.buttons || []).some((b) => b.pressed) ||
      Array.from(p.axes || []).some((v) => Math.abs(v || 0) > 0.5);
    const pad = available.find(hasActivity) ||
      available.find((p) => p.index === this.activePadIndex) || available[0];
    const padKey = `${pad.index}:${pad.id || "gamepad"}`;
    if (padKey !== this.activePadKey) {
      this.activePadIndex = pad.index;
      this.activePadKey = padKey;
      this.padPrev = [];
      this._stickHeld = false;
    }

    const pressed = Array.from(pad.buttons || [], (b) => !!b.pressed);
    this.padPressed = pressed; // for isPadHeld(), regardless of mode below
    const prev = this.padPrev;
    const edge = (i) => pressed[i] && !prev[i];
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    const mag = Math.max(Math.abs(ax), Math.abs(ay));
    const anyEdge = pressed.some((p, i) => p && !prev[i]);
    if (anyEdge || mag > 0.5) this._setScheme("gamepad");

    // Debounced stick → a single directional pulse.
    let stickDir = null; // 0 up,1 right,2 down,3 left
    if (mag > 0.6 && !this._stickHeld) {
      this._stickHeld = true;
      stickDir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 1 : 3) : (ay > 0 ? 2 : 0);
    } else if (mag < 0.35) {
      this._stickHeld = false;
    }

    if (this.mode === "intro") {
      // Requires a hold on a standard confirm button — read via isPadHeld()
      // and polled in
      // main.js's loop(), not dispatched from here on an edge.
      this.padPrev = pressed;
      return;
    }

    if (this.mode === "pass") {
      if (anyEdge) this.passHandler && this.passHandler();
      this.padPrev = pressed;
      return;
    }

    if ((this.mode === "menu" || this.mode === "overlay") && this.menuHandlers) {
      // Up/down and left/right are kept on SEPARATE axes end-to-end (this was
      // the root cause of "any button skips to the game": up/down/left/right
      // used to share one flat list, so any direction could wander onto a
      // play button, and A/Start confirmed it instantly).
      const { navX, navY, select, back } = this.menuHandlers;
      if (edge(12)) navY(-1); // dpad up
      if (edge(13)) navY(1);  // dpad down
      if (edge(14)) navX(-1); // dpad left
      if (edge(15)) navX(1);  // dpad right
      if (stickDir === 0) navY(-1);
      if (stickDir === 2) navY(1);
      if (stickDir === 3) navX(-1);
      if (stickDir === 1) navX(1);
      if (edge(0) || edge(9)) select(); // A / Start — menuSelect() itself
      if (edge(1)) back();               // B — go back a stage
      this.padPrev = pressed;
      return;
    }

    // Game. RB held = break-window modifier for the prisoner's move
    // direction, mirroring keyboard's Shift+direction (RB's edge-triggered
    // "rotate" below only ever matters on the Watcher's turn, so the two
    // uses never actually conflict in practice — only one role's intents
    // are recognized per turn, see handlePrisonerIntent/handleWatcherIntent).
    const breakMod = pressed[5];
    // D-pad also dual-dispatches "bluff" with the SAME direction index, same
    // one-role-per-turn convention as keyboard 1/2 (item + bluff): only one
    // role's handler is listening per turn, so this never conflicts. Added
    // because the face buttons below can only reach 3 of 4 directions (Y/B/X
    // — A is taken by endTurn), so South had NO gamepad route at all for
    // bluff or DISPATCH's quadrant pick until now.
    // The direction sent alongside the move is "bluffScreen", not "bluff":
    // a d-pad/stick push is SPATIAL — up means the top of the screen — so
    // main.js resolves it against the live camera. The labelled N/E/S/W
    // touch buttons and the number keys stay on absolute "bluff", because
    // those name a compass bearing outright and must not be re-aimed.
    if (edge(12)) { this.onIntent(breakMod ? "break" : "move", 0); this.onIntent("bluffScreen", 0); }
    if (edge(15)) { this.onIntent(breakMod ? "break" : "move", 1); this.onIntent("bluffScreen", 1); }
    if (edge(13)) { this.onIntent(breakMod ? "break" : "move", 2); this.onIntent("bluffScreen", 2); }
    if (edge(14)) { this.onIntent(breakMod ? "break" : "move", 3); this.onIntent("bluffScreen", 3); }
    if (stickDir != null) { this.onIntent(breakMod ? "break" : "move", stickDir); this.onIntent("bluffScreen", stickDir); }
    if (edge(0)) this.onIntent("endTurn");   // A
    if (edge(4)) this.onIntent("rotate", -1); // LB
    if (edge(5)) this.onIntent("rotate", 1);  // RB
    if (edge(3)) this.onIntent("bluff", 0);   // Y (kept for muscle memory)
    if (edge(1)) this.onIntent("bluff", 1);   // B (kept for muscle memory)
    if (edge(2)) this.onIntent("bluff", 3);   // X (kept for muscle memory)
    // X doubles as Struggle on the Prisoner's turn — the one-role-per-turn
    // split in main.js means the bluff above and this never both land.
    if (edge(2)) this.onIntent("struggle");
    if (edge(9)) this.onIntent("cycleView");  // Start
    // Items + skills had NO gamepad route at all — they were keyboard
    // (1-8) and touch-chip only, so a pad player simply could not use half
    // the verbs the game now has. LT (6) cycles which slot is selected and
    // RT (7) fires it, rather than claiming four more face buttons that are
    // already spoken for by bluff/rotate/endTurn. Which LIST the slot
    // indexes into is decided by whose turn it is, the same one-role-per-
    // turn split every other shared binding here relies on.
    if (edge(6)) {
      this.slotCursor = (this.slotCursor + 1) % PAD_SLOT_COUNT;
      this.onIntent("slotCursor", this.slotCursor);
    }
    if (edge(7)) this.onIntent("useSlot", this.slotCursor);
    this.padPrev = pressed;
  }
}

function touchDist(e) {
  const a = e.touches[0], b = e.touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
