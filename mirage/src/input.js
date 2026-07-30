// input.js — keyboard + mouse-look, touch, and gamepad, normalised into one
// small intent object the game loop reads. No game logic lives here.
//
// Function keys are deliberately NOT captured (F11 fullscreen, F12 devtools):
// swallowing them breaks the browser for no gain.

const HELD = new Set();

export const ACTIONS = Object.freeze({
  SURVEY: "survey",
  CHECK_IN: "checkIn",
  DOSE: "dose",
  NEXT_TARGET: "nextTarget",
  PREV_TARGET: "prevTarget",
  PAUSE: "pause",
});

export function createInput(canvas, opts = {}) {
  const state = {
    move: { x: 0, z: 0 }, // raw, in screen space; the loop rotates it by yaw
    run: false,
    look: { dx: 0, dy: 0 },
    yaw: 0,
    pitch: 0,
    pointerLocked: false,
    scheme: "keyboard", // keyboard | touch | gamepad — drives which hints show
    selected: 0, // index into the companion list, for check-ins and doses
    queue: [], // discrete actions, drained each frame
  };

  const push = (action, arg) => state.queue.push({ action, arg });

  // ---- keyboard ------------------------------------------------------------
  const DIGIT = /^Digit([1-5])$/;
  function onKeyDown(e) {
    if (/^F\d{1,2}$/.test(e.key)) return; // leave the browser's own keys alone
    HELD.add(e.code);
    state.scheme = "keyboard";
    const digit = DIGIT.exec(e.code);
    if (digit) {
      state.selected = Number(digit[1]) - 1;
      push(e.shiftKey ? ACTIONS.DOSE : ACTIONS.CHECK_IN, state.selected);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case "KeyE": push(ACTIONS.SURVEY); break;
      case "KeyF": push(ACTIONS.CHECK_IN, state.selected); break;
      case "KeyG": push(ACTIONS.DOSE, state.selected); break;
      case "KeyQ": push(ACTIONS.PREV_TARGET); break;
      case "KeyR": push(ACTIONS.NEXT_TARGET); break;
      case "Escape": push(ACTIONS.PAUSE); break;
      case "Space": e.preventDefault(); break;
      default: return;
    }
    e.preventDefault();
  }
  function onKeyUp(e) {
    HELD.delete(e.code);
  }

  // ---- mouse look ----------------------------------------------------------
  function onMouseMove(e) {
    if (!state.pointerLocked) return;
    state.look.dx += e.movementX;
    state.look.dy += e.movementY;
  }
  function onPointerLockChange() {
    state.pointerLocked = document.pointerLockElement === canvas;
    if (state.pointerLocked) state.scheme = "keyboard";
  }
  function requestLock() {
    if (canvas.requestPointerLock) canvas.requestPointerLock();
  }
  function onCanvasDown(e) {
    if (state.scheme === "touch") return;
    if (!state.pointerLocked) requestLock();
    else if (e.button === 0) push(ACTIONS.SURVEY);
  }

  // ---- touch ---------------------------------------------------------------
  // Left half of the screen steers, right half looks. Buttons live in the DOM.
  const touches = new Map();
  function onTouchStart(e) {
    state.scheme = "touch";
    for (const t of e.changedTouches) {
      touches.set(t.identifier, { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, left: t.clientX < window.innerWidth / 2 });
    }
  }
  function onTouchMove(e) {
    for (const t of e.changedTouches) {
      const rec = touches.get(t.identifier);
      if (!rec) continue;
      if (!rec.left) {
        state.look.dx += (t.clientX - rec.x) * 1.6;
        state.look.dy += (t.clientY - rec.y) * 1.6;
      }
      rec.x = t.clientX;
      rec.y = t.clientY;
    }
    if (e.cancelable) e.preventDefault();
  }
  function onTouchEnd(e) {
    for (const t of e.changedTouches) touches.delete(t.identifier);
  }
  function touchMove() {
    for (const rec of touches.values()) {
      if (!rec.left) continue;
      const dx = rec.x - rec.x0;
      const dy = rec.y - rec.y0;
      const mag = Math.min(1, Math.hypot(dx, dy) / 70);
      if (mag < 0.12) return { x: 0, z: 0, run: false };
      const len = Math.hypot(dx, dy) || 1;
      return { x: (dx / len) * mag, z: (dy / len) * mag, run: mag > 0.85 };
    }
    return { x: 0, z: 0, run: false };
  }

  // ---- gamepad -------------------------------------------------------------
  const padPrev = new Map();
  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return null;
    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const lx = dead(pad.axes[0] || 0);
    const ly = dead(pad.axes[1] || 0);
    const rx = dead(pad.axes[2] || 0);
    const ry = dead(pad.axes[3] || 0);
    if (lx || ly || rx || ry) state.scheme = "gamepad";
    state.look.dx += rx * 13;
    state.look.dy += ry * 9;
    const pressed = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const edge = (i, action, arg) => {
      const was = padPrev.get(i) || false;
      const now = pressed(i);
      padPrev.set(i, now);
      if (now && !was) {
        push(action, arg);
        state.scheme = "gamepad";
      }
    };
    edge(0, ACTIONS.SURVEY); // A
    edge(2, ACTIONS.CHECK_IN, state.selected); // X
    edge(3, ACTIONS.DOSE, state.selected); // Y
    edge(4, ACTIONS.PREV_TARGET); // LB
    edge(5, ACTIONS.NEXT_TARGET); // RB
    edge(9, ACTIONS.PAUSE); // Start
    return { x: lx, z: ly, run: pressed(10) || pressed(6) };
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("mousedown", onCanvasDown);
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);
  window.addEventListener("blur", () => HELD.clear());

  /** Read-and-clear the frame's intent. */
  function sample(dt) {
    const pad = pollPad();
    const touch = touchMove();
    let x = 0, z = 0;
    if (HELD.has("KeyW") || HELD.has("ArrowUp")) z -= 1;
    if (HELD.has("KeyS") || HELD.has("ArrowDown")) z += 1;
    if (HELD.has("KeyA") || HELD.has("ArrowLeft")) x -= 1;
    if (HELD.has("KeyD") || HELD.has("ArrowRight")) x += 1;
    let run = HELD.has("ShiftLeft") || HELD.has("ShiftRight");
    if (!x && !z && pad) { x = pad.x; z = pad.z; run = run || pad.run; }
    if (!x && !z && (touch.x || touch.z)) { x = touch.x; z = touch.z; run = run || touch.run; }

    const sens = (opts.sensitivity ?? 1) * 0.0022;
    state.yaw -= state.look.dx * sens;
    state.pitch = Math.max(-1.15, Math.min(1.15, state.pitch - state.look.dy * sens));
    state.look.dx = 0;
    state.look.dy = 0;

    const queue = state.queue;
    state.queue = [];
    state.move.x = x;
    state.move.z = z;
    state.run = run;
    return { move: { x, z }, run, yaw: state.yaw, pitch: state.pitch, queue, scheme: state.scheme, dt };
  }

  function destroy() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
  }

  return { state, sample, destroy, requestLock, push, ACTIONS };
}
