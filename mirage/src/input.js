// input.js — keyboard, mouse-look, touch, and gamepad, normalised into one
// small intent object the game loop reads. No game logic lives here.
//
// ONE persistent instance drives the whole app — title screen, pause, debrief,
// AND gameplay — dispatching by `mode` ('menu' | 'game'), the same shape Opticon
// uses (Brain: a flat single-axis focus list over visually distinct groups lets
// any direction leak into the wrong group; model real rows/columns/groups,
// scoped per screen — see menuNavX/menuNavY in main.js). A per-run instance
// would mean the title/pause/debrief screens have no gamepad support at all,
// which was the actual gap: gameplay already read a pad, but nothing let a
// controller-only player so much as press Start.
//
// Gamepad is POLLED every frame regardless of mode (Chrome hides `getGamepads()`
// data until the first button press on that pad — `gamepadconnected` alone is
// not enough — Brain: dog#E27/test#E3), and the active scheme is tracked live so
// the UI can reshape itself around whichever device is actually in the player's
// hands (Brain: device-adaptive-ui / show-the-active-scheme) — see
// `refreshSchemeUI` in main.js for the on-screen side of that.
//
// Function keys are deliberately NOT captured (F11 fullscreen, F12 devtools):
// swallowing them breaks the browser for no gain.

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
    queue: [], // discrete actions, drained each frame
  };

  const HELD = new Set();
  let mode = "menu"; // 'menu' (title/pause/debrief) | 'game' (in-run)
  let scheme = "keyboard"; // keyboard | touch | gamepad — drives the on-screen legend
  let menuHandlers = null; // { navX(dir), navY(dir), confirm(), cancel() }

  const onScheme = opts.onScheme || (() => {});
  function setScheme(s) {
    if (scheme === s) return;
    scheme = s;
    onScheme(s);
  }

  const push = (action, arg) => state.queue.push({ action, arg });

  function setMode(m) { mode = m; }
  function setMenuHandlers(navX, navY, confirm, cancel) {
    menuHandlers = { navX, navY, confirm, cancel };
  }

  // ---- keyboard ------------------------------------------------------------
  const DIGIT = /^Digit([1-5])$/;
  function onKeyDown(e) {
    if (/^F\d{1,2}$/.test(e.key)) return; // leave the browser's own keys alone

    // A text field (the seed input) must behave like a text field. Without this
    // guard, adding menu navigation on WASD/arrows would make it impossible to
    // type a seed containing those letters — the same global listener that
    // steers the menu would eat every keystroke aimed at the input.
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (e.code === "Escape") e.target.blur();
      return;
    }

    HELD.add(e.code);
    setScheme("keyboard");

    if (mode === "menu") {
      switch (e.code) {
        case "ArrowUp": case "KeyW": menuHandlers && menuHandlers.navY(-1); break;
        case "ArrowDown": case "KeyS": menuHandlers && menuHandlers.navY(1); break;
        case "ArrowLeft": case "KeyA": menuHandlers && menuHandlers.navX(-1); break;
        case "ArrowRight": case "KeyD": menuHandlers && menuHandlers.navX(1); break;
        case "Enter": case "Space": menuHandlers && menuHandlers.confirm(); break;
        case "Escape": case "Backspace": menuHandlers && menuHandlers.cancel(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }

    const digit = DIGIT.exec(e.code);
    if (digit) {
      // A digit picks a companion directly, regardless of whatever Q/R had
      // selected — the explicit index is passed through as `arg`.
      push(e.shiftKey ? ACTIONS.DOSE : ACTIONS.CHECK_IN, Number(digit[1]) - 1);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case "KeyE": push(ACTIONS.SURVEY); break;
      // F/G act on whichever companion Q/R/gamepad most recently selected —
      // no arg here, so handleAction falls through to that shared selection.
      case "KeyF": push(ACTIONS.CHECK_IN); break;
      case "KeyG": push(ACTIONS.DOSE); break;
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

  // ---- pointer scheme detection (anywhere on the page, not just the canvas) -
  // Menus live in ordinary DOM elements outside the canvas, so scheme detection
  // has to hear about clicks/taps there too, not only in-canvas gestures.
  function onPointerDown(e) {
    setScheme(e.pointerType === "touch" || e.pointerType === "pen" ? "touch" : "keyboard");
  }

  // ---- mouse look (in-run only) ---------------------------------------------
  function onMouseMove(e) {
    if (!state.pointerLocked) return;
    state.look.dx += e.movementX;
    state.look.dy += e.movementY;
  }
  function onPointerLockChange() {
    state.pointerLocked = document.pointerLockElement === canvas;
    if (state.pointerLocked) setScheme("keyboard");
  }
  function requestLock() {
    if (canvas.requestPointerLock) canvas.requestPointerLock();
  }
  function onCanvasDown(e) {
    if (mode !== "game") return; // the canvas sits behind menu overlays too
    if (scheme === "touch") return;
    if (!state.pointerLocked) requestLock();
    else if (e.button === 0) push(ACTIONS.SURVEY);
  }

  // ---- touch (in-run steering) -----------------------------------------------
  // Left half of the screen steers, right half looks. Buttons live in the DOM.
  const touches = new Map();
  function onTouchStart(e) {
    setScheme("touch");
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

  // ---- gamepad ---------------------------------------------------------------
  // Xbox-style mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 9 Start,
  // 10 L3, 12-15 dpad up/down/left/right, axes 0/1 left stick, 2/3 right stick.
  let padPrev = []; // previous frame's button.pressed[], for edge detection
  let stickHeldMenu = false; // debounces the left stick into discrete menu pulses

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && [...pads].find((p) => p && p.connected);
    if (!pad) {
      padPrev = [];
      stickHeldMenu = false;
      return null;
    }

    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const lx = dead(pad.axes[0] || 0), ly = dead(pad.axes[1] || 0);
    const rx = dead(pad.axes[2] || 0), ry = dead(pad.axes[3] || 0);
    const pressedNow = pad.buttons.map((b) => !!(b && b.pressed));
    if (lx || ly || rx || ry || pressedNow.some(Boolean)) setScheme("gamepad");

    const edges = pressedNow.map((p, i) => p && !padPrev[i]);
    padPrev = pressedNow;

    if (mode === "menu") {
      // Both D-pad (edge-triggered) and stick (debounced into single pulses)
      // drive the same grid nav — Brain: menus need to be navigable by both,
      // not just one, since players reach for whichever their thumb is on.
      const mag = Math.max(Math.abs(lx), Math.abs(ly));
      let stickDir = null;
      if (mag > 0.6 && !stickHeldMenu) {
        stickHeldMenu = true;
        stickDir = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? "right" : "left") : (ly > 0 ? "down" : "up");
      } else if (mag < 0.35) {
        stickHeldMenu = false;
      }
      if (menuHandlers) {
        if (edges[12] || stickDir === "up") menuHandlers.navY(-1);
        if (edges[13] || stickDir === "down") menuHandlers.navY(1);
        if (edges[14] || stickDir === "left") menuHandlers.navX(-1);
        if (edges[15] || stickDir === "right") menuHandlers.navX(1);
        if (edges[0] || edges[9]) menuHandlers.confirm(); // A or Start
        if (edges[1]) menuHandlers.cancel(); // B
      }
      return null;
    }

    // mode === "game"
    if (edges[0]) push(ACTIONS.SURVEY); // A
    if (edges[2]) push(ACTIONS.CHECK_IN); // X — no arg, acts on the shared selection
    if (edges[3]) push(ACTIONS.DOSE); // Y
    if (edges[4]) push(ACTIONS.PREV_TARGET); // LB
    if (edges[5]) push(ACTIONS.NEXT_TARGET); // RB
    if (edges[9]) push(ACTIONS.PAUSE); // Start
    state.look.dx += rx * 13;
    state.look.dy += ry * 9;
    return { x: lx, z: ly, run: pressedNow[10] || pressedNow[6] };
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("mousedown", onCanvasDown);
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);
  window.addEventListener("blur", () => HELD.clear());

  /**
   * Read-and-clear the frame's intent. Call every frame regardless of screen —
   * in 'menu' mode this only has side effects (scheme tracking, dispatching to
   * menuHandlers) and returns null; in 'game' mode it also returns the movement
   * intent the sim step needs.
   */
  function poll(dt) {
    const padMove = pollGamepad();
    if (mode === "menu") return null;

    let x = 0, z = 0;
    if (HELD.has("KeyW") || HELD.has("ArrowUp")) z -= 1;
    if (HELD.has("KeyS") || HELD.has("ArrowDown")) z += 1;
    if (HELD.has("KeyA") || HELD.has("ArrowLeft")) x -= 1;
    if (HELD.has("KeyD") || HELD.has("ArrowRight")) x += 1;
    let run = HELD.has("ShiftLeft") || HELD.has("ShiftRight");
    if (!x && !z && padMove) { x = padMove.x; z = padMove.z; run = run || padMove.run; }
    const touch = touchMove();
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
    return { move: { x, z }, run, yaw: state.yaw, pitch: state.pitch, queue, scheme, dt };
  }

  function destroy() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
  }

  return {
    setMode,
    setMenuHandlers,
    poll,
    requestLock,
    destroy,
    get activeScheme() { return scheme; },
  };
}
