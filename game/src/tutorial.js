// tutorial.js — the guided first game. Pure: no DOM, no game mutation.
//
// One table says both what a step TELLS the player and what PASSES it. Brain
// demo-disc#E51: a tutorial whose arrow was mapped separately from its pass
// test pointed at the wrong verb forever while every state test stayed green.
// Here a step's `text` and its `on`/`test` sit side by side, and the key names
// in `text` come from the player's CURRENT control scheme (Brain seven#E18),
// so "press Space" is never shown to someone holding a gamepad.
//
// Steps pass only on events main.js emits from the human prisoner's own
// actions (Brain the-game-prologue#E15: pin triggers, or ordinary play — here,
// an AI turn — satisfies steps by accident).

// What to call each control, per scheme. Words, not glyphs, so nobody presses
// blind; touch names match the on-screen button labels.
export const KEYS = Object.freeze({
  keyboard: { move: "WASD or the arrow keys", commit: "Space", end: "Space", view: "V", skip: "Esc" },
  gamepad: { move: "the stick or D-pad", commit: "A", end: "A", view: "Start", skip: "Back" },
  touch: { move: "the arrow pad", commit: "Commit", end: "End", view: "View", skip: "Skip" },
});

export const STEPS = Object.freeze([
  {
    id: "plan",
    title: "Plan a move",
    text: (k) => `The figure the camera follows is you. Press ${k.move} to plan a step. Nothing moves until you commit it.`,
    on: "planned",
  },
  {
    id: "commit",
    title: "Commit it",
    text: (k) => `The marked path is only a plan — press the opposite direction to take a step back. Press ${k.commit} to walk it for real.`,
    on: "committed",
  },
  {
    id: "end",
    title: "End your turn",
    text: (k) => `You get up to 3 tiles a turn (the Move dots in the top bar). With nothing planned, press ${k.end} to end your turn. Then the Watcher in the tower takes its turn.`,
    on: "turnEnded",
  },
  {
    id: "noise",
    title: "Noise",
    text: (k) => `One tile a turn is silent. Move 2 or more in one turn and you leave a red noise mark where you started, and the Watcher sees it. Try it: plan 2 or 3 tiles, press ${k.commit}, then ${k.end} to end the turn.`,
    on: "turnEnded",
    test: (e) => e.noisy,
  },
  {
    id: "shadow",
    title: "Light and shadow",
    text: (k) => `Lit tiles give you away. If the eye's TRUE gaze covers you while you are lit or noisy, you are caught — a red screen edge and a heartbeat mean that is true right now. Finish a turn standing in shadow, then press ${k.end}.`,
    on: "turnEnded",
    test: (e) => !e.lit,
  },
  {
    id: "view",
    title: "Look around",
    text: (k) => `Press ${k.view} to change the camera. Drag to orbit; scroll or pinch to zoom. Up always means the top of the screen, whichever way you turn it.`,
    on: "view",
  },
  {
    id: "gate",
    title: "Escape",
    text: () => `The eye is awake now — it can catch you from here on. Reach the green gate on the outer ring to win. Gaze shows "?": the tower only says where it CLAIMS to look, and it may be bluffing.`,
    on: "escaped",
  },
]);

// Steps before this one are taught with the eye asleep (no captures, no
// guards). Reaching it wakes the eye: the last lesson is the real game.
export const WAKE_STEP = STEPS.findIndex((s) => s.id === "gate");

export class Tutorial {
  constructor(onChange = () => {}) {
    this.index = 0;
    this.onChange = onChange;
  }

  get step() { return STEPS[this.index] || null; }
  get done() { return this.index >= STEPS.length; }
  // True while the eye must not catch anyone: a lesson is still being taught.
  get calm() { return this.index < WAKE_STEP; }

  // Feed a human action in. Returns true if it passed the current step.
  emit(event, detail = {}) {
    const s = this.step;
    if (!s || s.on !== event) return false;
    if (s.test && !s.test(detail)) return false;
    this.index++;
    this.onChange(this);
    return true;
  }

  // Leave the lessons and play on as a normal game. The escape hatch every
  // step needs (Brain demo-disc#E51): nothing here may strand the player.
  skip() {
    if (this.done) return;
    this.index = STEPS.length;
    this.onChange(this);
  }

  view(scheme = "keyboard") {
    const s = this.step;
    if (!s) return null;
    const k = KEYS[scheme] || KEYS.keyboard;
    return { id: s.id, n: this.index + 1, total: STEPS.length, title: s.title, text: s.text(k), skip: k.skip };
  }
}
