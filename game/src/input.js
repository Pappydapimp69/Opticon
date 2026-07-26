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
    this._stickHeld = false;
    this.activeScheme = "keyboard";
    this.menuHandlers = null; // { navX(dir), navY(dir), select(), back() }
    this.introHandler = null; // () => void
    this.passHandler = null; // () => void — hotseat "pass the device" gate
    this._bindKeyboard();
    // The very first gamepad press (which unlocks the API) should also dismiss
    // the intro, so a controller-only player never gets stuck on the splash.
    window.addEventListener("gamepadconnected", () => {
      this._setScheme("gamepad");
      if (this.mode === "intro" && this.introHandler) this.introHandler();
    });
  }

  setScheme(s) { this._setScheme(s); }
  _setScheme(s) {
    if (this.activeScheme === s) return;
    this.activeScheme = s;
    this.onScheme(s);
  }

  setMenuHandlers(navX, navY, select, back) { this.menuHandlers = { navX, navY, select, back }; }
  setIntroHandler(fn) { this.introHandler = fn; }
  setPassHandler(fn) { this.passHandler = fn; }
  // Raw held-state (not edge-triggered) — for press-and-hold confirms, where
  // an intent callback per keydown isn't enough.
  isHeld(code) { return this.keys.has(code); }

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
    // Intro: any key begins.
    if (this.mode === "intro") {
      if (this.introHandler) this.introHandler();
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
    if (this.mode === "menu" && this.menuHandlers) {
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
    // Game.
    const map = {
      ArrowUp: () => this.onIntent("move", 0), KeyW: () => this.onIntent("move", 0),
      ArrowRight: () => this.onIntent("move", 1), KeyD: () => this.onIntent("move", 1),
      ArrowDown: () => this.onIntent("move", 2), KeyS: () => this.onIntent("move", 2),
      ArrowLeft: () => this.onIntent("move", 3), KeyA: () => this.onIntent("move", 3),
      Space: () => this.onIntent("endTurn"), Enter: () => this.onIntent("endTurn"),
      KeyQ: () => this.onIntent("rotate", -1), KeyE: () => this.onIntent("rotate", 1),
      Digit1: () => this.onIntent("bluff", 0), Digit2: () => this.onIntent("bluff", 1),
      Digit3: () => this.onIntent("bluff", 2), Digit4: () => this.onIntent("bluff", 3),
      Tab: () => this.onIntent("cycleView"), KeyV: () => this.onIntent("cycleView"),
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
    const pad = pads && pads[0];
    if (!pad) return;
    const pressed = pad.buttons.map((b) => b.pressed);
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
      if (anyEdge) this.introHandler && this.introHandler();
      this.padPrev = pressed;
      return;
    }

    if (this.mode === "pass") {
      if (anyEdge) this.passHandler && this.passHandler();
      this.padPrev = pressed;
      return;
    }

    if (this.mode === "menu" && this.menuHandlers) {
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

    // Game.
    if (edge(12)) this.onIntent("move", 0);
    if (edge(15)) this.onIntent("move", 1);
    if (edge(13)) this.onIntent("move", 2);
    if (edge(14)) this.onIntent("move", 3);
    if (stickDir != null) this.onIntent("move", stickDir);
    if (edge(0)) this.onIntent("endTurn");   // A
    if (edge(4)) this.onIntent("rotate", -1); // LB
    if (edge(5)) this.onIntent("rotate", 1);  // RB
    if (edge(3)) this.onIntent("bluff", 0);   // Y
    if (edge(1)) this.onIntent("bluff", 1);   // B
    if (edge(2)) this.onIntent("bluff", 3);   // X
    if (edge(9)) this.onIntent("cycleView");  // Start
    this.padPrev = pressed;
  }
}

function touchDist(e) {
  const a = e.touches[0], b = e.touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
