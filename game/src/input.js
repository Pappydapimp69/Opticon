// input.js — Unified input: keyboard, on-screen touch buttons, gamepad.
// Emits high-level intents via a callback so main.js stays device-agnostic.

export class Input {
  constructor(onIntent) {
    this.onIntent = onIntent;
    this.keys = new Set();
    this.padPrev = [];
    this.orbit = { dragging: false, lastX: 0, lastY: 0, onOrbit: null, onZoom: null };
    this._bindKeyboard();
  }

  _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (this.keys.has(e.code)) return; // ignore auto-repeat for intents
      this.keys.add(e.code);
      this._handleKey(e);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  _handleKey(e) {
    const map = {
      ArrowUp: () => this.onIntent("move", 0),
      KeyW: () => this.onIntent("move", 0),
      ArrowRight: () => this.onIntent("move", 1),
      KeyD: () => this.onIntent("move", 1),
      ArrowDown: () => this.onIntent("move", 2),
      KeyS: () => this.onIntent("move", 2),
      ArrowLeft: () => this.onIntent("move", 3),
      KeyA: () => this.onIntent("move", 3),
      Space: () => this.onIntent("endTurn"),
      Enter: () => this.onIntent("endTurn"),
      KeyQ: () => this.onIntent("rotate", -1),
      KeyE: () => this.onIntent("rotate", 1),
      Digit1: () => this.onIntent("bluff", 0),
      Digit2: () => this.onIntent("bluff", 1),
      Digit3: () => this.onIntent("bluff", 2),
      Digit4: () => this.onIntent("bluff", 3),
      Tab: () => this.onIntent("cycleView"),
      KeyV: () => this.onIntent("cycleView"),
      KeyR: () => this.onIntent("restart"),
    };
    if (map[e.code]) {
      if (e.code === "Tab" || e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
      map[e.code]();
    }
  }

  // Touch buttons: call with a container element holding [data-intent] buttons.
  bindTouchButtons(root) {
    root.querySelectorAll("[data-intent]").forEach((btn) => {
      const fire = (ev) => {
        ev.preventDefault();
        const intent = btn.getAttribute("data-intent");
        const arg = btn.getAttribute("data-arg");
        this.onIntent(intent, arg != null ? Number(arg) : undefined);
      };
      btn.addEventListener("touchstart", fire, { passive: false });
      btn.addEventListener("mousedown", fire);
    });
  }

  // Orbit/zoom drag on the canvas.
  bindCanvasOrbit(canvas, onOrbit, onZoom) {
    this.orbit.onOrbit = onOrbit;
    this.orbit.onZoom = onZoom;
    const start = (x, y) => {
      this.orbit.dragging = true;
      this.orbit.lastX = x;
      this.orbit.lastY = y;
    };
    const move = (x, y) => {
      if (!this.orbit.dragging) return;
      const dx = x - this.orbit.lastX;
      const dy = y - this.orbit.lastY;
      this.orbit.lastX = x;
      this.orbit.lastY = y;
      onOrbit(dx * 0.008, dy * 0.006);
    };
    const end = () => (this.orbit.dragging = false);

    canvas.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    window.addEventListener("mouseup", end);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      onZoom(Math.sign(e.deltaY) * 1.2);
    }, { passive: false });

    // Touch: single finger orbit, pinch zoom.
    let pinchDist = 0;
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) pinchDist = touchDist(e);
    }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) {
        const d = touchDist(e);
        onZoom((pinchDist - d) * 0.03);
        pinchDist = d;
      }
    }, { passive: true });
    canvas.addEventListener("touchend", end);
  }

  // Poll gamepad each frame; translate edges to intents.
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && pads[0];
    if (!pad) return;
    const pressed = pad.buttons.map((b) => b.pressed);
    const prev = this.padPrev;
    const edge = (i) => pressed[i] && !prev[i];

    // D-pad / face buttons.
    if (edge(12)) this.onIntent("move", 0); // up
    if (edge(15)) this.onIntent("move", 1); // right
    if (edge(13)) this.onIntent("move", 2); // down
    if (edge(14)) this.onIntent("move", 3); // left
    // Left stick edges.
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const stickKey = "stick";
    const now = this._stickLatch || 0;
    const mag = Math.max(Math.abs(ax), Math.abs(ay));
    if (mag > 0.6 && !this._stickHeld) {
      this._stickHeld = true;
      if (Math.abs(ax) > Math.abs(ay)) this.onIntent("move", ax > 0 ? 1 : 3);
      else this.onIntent("move", ay > 0 ? 2 : 0);
    } else if (mag < 0.35) {
      this._stickHeld = false;
    }

    if (edge(0)) this.onIntent("endTurn"); // A
    if (edge(4)) this.onIntent("rotate", -1); // LB
    if (edge(5)) this.onIntent("rotate", 1); // RB
    if (edge(3)) this.onIntent("bluff", 0); // Y (north)
    if (edge(1)) this.onIntent("bluff", 1); // B (east)
    if (edge(2)) this.onIntent("bluff", 3); // X (west)
    if (edge(9)) this.onIntent("cycleView"); // Start
    this.padPrev = pressed;
  }
}

function touchDist(e) {
  const a = e.touches[0];
  const b = e.touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
