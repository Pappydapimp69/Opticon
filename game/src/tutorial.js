// tutorial.js — the guided lessons. Pure: no DOM, no game mutation.
//
// One table says both what a step TELLS the player and what PASSES it. Brain
// demo-disc#E51: a tutorial whose arrow was mapped separately from its pass
// test pointed at the wrong verb forever while every state test stayed green.
// Here a step's `text`, the control it names (`key`) and its `on`/`test` sit
// side by side, and key names come from the player's CURRENT control scheme
// (Brain seven#E18), so "press Space" is never shown to someone on a gamepad.
//
// Steps pass only on events main.js emits from the human's own actions
// (Brain the-game-prologue#E15: pin triggers, or ordinary play — here, an AI
// turn — satisfies steps by accident).
//
// A step's `setup` is DATA that main.js acts on when the step begins: put the
// player next to a door, hand them an item, cuff them, send guards. Keeping it
// declarative keeps this module pure and testable in Node.

// What to call each control, per scheme. Words, not glyphs, so nobody presses
// blind; touch names match the on-screen button labels.
export const KEYS = Object.freeze({
  keyboard: {
    move: "WASD or the arrow keys", commit: "Space", end: "Space", view: "V", skip: "Esc",
    brk: "Shift + the direction", item: "1", struggle: "F",
    rotate: "Q or E", bluff: "a number key 1-4 (N, E, S, W)", scan: "Space",
    double: "5", wide: "6", echo: "7", lock: "8", dispatch: "9",
  },
  gamepad: {
    move: "the stick or D-pad", commit: "A", end: "A", view: "Start", skip: "Back",
    brk: "RB + the direction", item: "RT (LT picks the slot)", struggle: "X",
    rotate: "LB or RB", bluff: "the D-pad", scan: "A",
    double: "RT on the 🎭 slot (LT picks)", wide: "RT on the 🔦 slot (LT picks)", echo: "RT on the 📡 slot (LT picks)",
    lock: "RT on the 🔒 slot (LT picks)", dispatch: "RT on the 🚨 slot (LT picks)",
  },
  touch: {
    move: "the arrow pad", commit: "Commit", end: "End", view: "View", skip: "Skip",
    brk: "💥 then a direction", item: "the item's chip", struggle: "Struggle",
    rotate: "⟲ or ⟳", bluff: "N, E, S or W", scan: "Scan",
    double: "the 🎭 button", wide: "the 🔦 button", echo: "the 📡 button", lock: "the 🔒 button", dispatch: "the 🚨 button",
  },
});

// `calm: true` steps are taught with the eye asleep (no scans, no AI guards).
// A lesson's first non-calm step wakes it for good.
export const LESSONS = Object.freeze([
  {
    id: "basics",
    title: "Basics",
    role: "Prisoner",
    steps: [
      { id: "plan", title: "Plan a move", key: "move", on: "planned", calm: true,
        text: (k) => `The figure the camera follows is you. Press ${k.move} to plan a step. Nothing moves until you commit it.` },
      { id: "commit", title: "Commit it", key: "commit", on: "committed", calm: true,
        text: (k) => `The marked path is only a plan — press the opposite direction to take a step back. Press ${k.commit} to walk it for real.` },
      { id: "end", title: "End your turn", key: "end", on: "turnEnded", calm: true,
        text: (k) => `You get up to 3 tiles a turn (the Move dots in the top bar). With nothing planned, press ${k.end} to end your turn. Then the Watcher in the tower takes its turn.` },
      { id: "noise", title: "Noise", key: "end", on: "turnEnded", test: (e) => e.noisy, calm: true,
        text: (k) => `One tile a turn is silent. Move 2 or more in one turn and you leave a red noise mark where you started, and the Watcher sees it. Try it: plan 2 or 3 tiles, press ${k.commit}, then ${k.end} to end the turn.` },
      { id: "shadow", title: "Light and shadow", key: "end", on: "turnEnded", test: (e) => !e.lit, calm: true,
        text: (k) => `Lit tiles give you away. If the eye's TRUE gaze covers you while you are lit or noisy, you are caught — a red screen edge and a heartbeat mean that is true right now. Finish a turn standing in shadow, then press ${k.end}.` },
      { id: "view", title: "Look around", key: "view", on: "view", calm: true,
        text: (k) => `Press ${k.view} to change the camera. Drag to orbit; scroll or pinch to zoom. Up always means the top of the screen, whichever way you turn it.` },
      { id: "gate", title: "Escape", key: null, on: "won",
        text: () => `The eye is awake now — it can catch you from here on. Reach the green gate on the outer ring to win. Gaze shows "?": the tower only says where it CLAIMS to look, and it may be bluffing.` },
    ],
  },
  {
    id: "yard",
    title: "Doors, lights and windows",
    role: "Prisoner",
    steps: [
      { id: "door", title: "Doors", key: "move", on: "world", test: (e) => e.event === "door-open", calm: true, setup: { place: "door" },
        text: (k) => `You are next to a closed door. Press ${k.move} toward it to open it — silent, and it costs 1 move. An open door also lets light and sight through.` },
      { id: "switch", title: "Switches", key: "move", on: "world", test: (e) => e.event === "switch", calm: true, setup: { place: "switch" },
        text: (k) => `This is a light switch. Press ${k.move} toward it to flip it — silent, 1 move. It turns a whole bank of lights on or off. The gaze can only take you on a lit (or noisy) tile, so dark is safe.` },
      { id: "window", title: "Windows", key: "brk", on: "break", calm: true, setup: { place: "glass" },
        text: (k) => `That pane in the wall is glass. Press ${k.brk} to smash it: a new shortcut, but LOUD — it drops noise the Watcher sees. Noise away from you can also pull the eye off you.` },
      { id: "pickup", title: "Items", key: "move", on: "world", test: (e) => e.event === "item-pickup", calm: true, setup: { place: "item" },
        text: (k) => `The glowing shape next to you is an item. Press ${k.move} to step onto it and pick it up. You carry 2 at most; the caption under your item chips says what each one does.` },
      { id: "clock", title: "The clock", key: "end", on: "turnEnded", calm: true,
        text: (k) => `Round in the top bar counts up to 90 — if nobody escapes by then, the Watcher wins (it turns red near the end). Crew shows who is still out: in a real game you run with 2 AI companions, but only YOUR escape wins. Press ${k.end} to end the turn.` },
    ],
  },
  {
    id: "items",
    title: "Using items",
    role: "Prisoner",
    steps: [
      { id: "distract", title: "🔔 Distraction", key: "item", on: "item", test: (e) => e.kind === "distract", calm: true, setup: { give: ["distract"], place: "open" },
        text: (k) => `Press ${k.item} to arm the Distraction, then press a direction to throw it. It makes a fake noise 2+ tiles away for the Watcher (and guards) to chase. Costs 1 move.` },
      { id: "muffle", title: "🧣 Muffle", key: "item", on: "item", test: (e) => e.kind === "muffle", calm: true, setup: { give: ["muffle"] },
        text: (k) => `Press ${k.item} to use the Muffle. It works at once: this turn you can run the full 3 tiles and leave no noise behind.` },
      { id: "lockpick", title: "🗝️ Lockpick", key: "item", on: "item", test: (e) => e.kind === "lockpick", calm: true, setup: { give: ["lockpick"], place: "door" },
        text: (k) => `You are next to a door. Press ${k.item} to arm the Lockpick, then press the door's direction. It opens for free instead of costing a move.` },
      { id: "cutters", title: "✂️ Cutters", key: "item", on: "item", test: (e) => e.kind === "cutters", calm: true, setup: { give: ["cutters"], place: "switch" },
        text: (k) => `You are next to a switch. Press ${k.item} to arm the Cutters, then press the switch's direction. That bank of lights dies for good — nobody can turn it back on.` },
      { id: "feather", title: "🪶 Golden Feather", key: "item", on: "item", test: (e) => e.kind === "feather", calm: true, setup: { give: ["feather"] },
        text: (k) => `Press ${k.item} to spend the Golden Feather. For this round your Gaze readout shows where the eye is REALLY looking instead of "?". It is rare, so save it for when you still have moves to use the answer.` },
      { id: "flare", title: "🔥 Flare", key: "item", on: "item", test: (e) => e.kind === "flare", calm: true, setup: { give: ["flare"], place: "open" },
        text: (k) => `Press ${k.item} to arm the Flare, then a direction to throw it. Every guard in the quadrant it lands in runs to the light and loses its next move. It is thrown, so it works even from a cell.` },
    ],
  },
  {
    id: "caught",
    title: "Getting caught",
    role: "Prisoner",
    steps: [
      { id: "held", title: "Seized", key: "struggle", on: "struggle", calm: true, setup: { custody: true },
        text: (k) => `You have been seized. Being caught is not over: Held in the top bar counts the 3 turns before you are processed for good. Press ${k.struggle} to fight the cuffs — free, but a long shot, and hopeless while a guard stands next to you.` },
      { id: "transfer", title: "📋 Forged Transfer", key: "item", on: "item", test: (e) => e.kind === "transfer", calm: true, setup: { custody: true, give: ["transfer"] },
        text: (k) => `Press ${k.item} to use the Forged Transfer. It does not free you — it resets your clock to 3 turns, buying time for a friend or a flare.` },
      { id: "shim", title: "🧷 Shim", key: "item", on: "item", test: (e) => e.kind === "shim", calm: true, setup: { custody: true, give: ["shim"] },
        text: (k) => `Press ${k.item} to use the Shim. It slips the cuffs at once, even with a guard on you. Shim and Transfer sit dim in your belt until you are caught.` },
      { id: "loose", title: "Loose", key: "end", on: "turnEnded", calm: true,
        text: (k) => `You are Loose: you get the rest of this turn, and the eye cannot take you on this turn or the next (guards still can). Use it to cross open ground. In a real game, a companion ending their turn next to your cell also frees you. Move, then press ${k.end}.` },
    ],
  },
  {
    id: "guards",
    title: "Guards",
    role: "Prisoner",
    steps: [
      { id: "zone", title: "Your zone", key: "end", on: "turnEnded", test: (e) => !e.held, calm: true, setup: { guards: "here" },
        text: (k) => `The Watcher can dispatch 2 guards into a quadrant — they are in yours now. Zone in the top bar names your quadrant and turns orange when guards sweep it. A guard sees only 1 square around it, diagonals too. Stay 2 squares clear, move, and press ${k.end}.` },
      { id: "bar", title: "The action bar", key: "item", on: "item", test: (e) => e.kind === "distract", calm: true, setup: { give: ["distract"] },
        text: (k) => `Each guard has a 7-point bar: for 2 turns it sprints 3 squares per point, then walks 1 square per point. Grabbing you costs 3. At zero it is recalled — its glow dims as the bar runs down. Guards chase the freshest noise: press ${k.item} and a direction to throw a Distraction away from you.` },
      { id: "flare", title: "Flare the squad", key: "item", on: "item", test: (e) => e.kind === "flare", calm: true, setup: { give: ["flare"], guards: "here" },
        text: (k) => `Press ${k.item}, then a direction, to throw a Flare into your own quadrant. The guards there run to it and lose a move. It is the answer to a guard posted over your cell.` },
    ],
  },
  {
    id: "watcher",
    title: "Playing the Watcher",
    role: "Watcher",
    steps: [
      { id: "aim", title: "Aim the eye", key: "rotate", on: "aimed", calm: true, setup: { respawn: true },
        text: (k) => `Now you are the Watcher. You never see prisoners — only noise and light. Press ${k.rotate} to aim your 90° gaze. It is only a preview until you confirm.` },
      { id: "rotate", title: "Confirm it", key: "commit", on: "rotated", calm: true,
        text: (k) => `Press ${k.commit} to lock the new facing in. You get one rotation a turn, 90° at most.` },
      { id: "bluff", title: "Bluff", key: "bluff", on: "bluffed", calm: true,
        text: (k) => `Press ${k.bluff} to claim you are watching another way. Prisoners see your claim, never your real facing — make them doubt.` },
      { id: "scan", title: "Scan", key: "scan", on: "scanned", calm: true, setup: { respawn: true },
        text: (k) => `Press ${k.scan} to scan and end your turn. Anyone in your TRUE wedge who is lit or noisy is seized. (The eye is still asleep in this lesson, so nobody is caught yet.)` },
      { id: "noise", title: "Read the noise", key: "scan", on: "scanned", calm: true, setup: { respawn: true },
        text: (k) => `Red pulses are noise: where a prisoner started a 2+ tile move, a smashed window, or a thrown decoy. They fade over a few turns. The bars on the right show where the evidence points. Aim at it and press ${k.scan} again.` },
      { id: "double", title: "🎭 Double bluff", key: "double", on: "skill", test: (e) => e.skill === "doubleBluff", calm: true, setup: { ready: "doubleBluff", respawn: true },
        text: (k) => `Skills sit in your skill bar with cooldowns. Bluff a direction first, then press ${k.double} and pick a SECOND direction to claim.` },
      { id: "wide", title: "🔦 Wide scan", key: "wide", on: "skill", test: (e) => e.skill === "wideScan", calm: true, setup: { ready: "wideScan" },
        text: (k) => `Press ${k.wide}: your next scan sweeps 180° instead of 90°, but you cannot bluff that turn.` },
      { id: "echo", title: "📡 Echo memory", key: "echo", on: "skill", test: (e) => e.skill === "echo", calm: true, setup: { ready: "echo", noise: true },
        text: (k) => `Press ${k.echo} to make every noise trace on the map fresh again, so old clues stop fading.` },
      { id: "lock", title: "🔒 Remote lock", key: "lock", on: "skill", test: (e) => e.skill === "lock", calm: true, setup: { ready: "lock", openDoor: true },
        text: (k) => `Press ${k.lock} to slam the nearest open door shut. Prisoners must spend a move (or a Lockpick) to open it again.` },
      { id: "dispatch", title: "🚨 Dispatch guards", key: "dispatch", on: "skill", test: (e) => e.skill === "dispatch", calm: true, setup: { ready: "dispatch", respawn: true },
        text: (k) => `Press ${k.dispatch}, then a direction, to send 2 guards hunting that quadrant. They are physical: they catch what they can see, lit or not.` },
      { id: "hunt", title: "Hunt", key: null, on: "won", setup: { respawn: true },
        text: () => `The eye is awake. Catch the prisoner to finish — the Watcher wins only when every prisoner is caught (3 in a real game). In 2P Hotseat, two players trade this seat on one device.` },
    ],
  },
]);

export class Tutorial {
  constructor(lesson = 0, onChange = () => {}) {
    this.lessonIndex = Math.max(0, Math.min(LESSONS.length - 1, lesson | 0));
    this.index = 0;
    this.onChange = onChange;
  }

  get lesson() { return LESSONS[this.lessonIndex]; }
  get steps() { return this.lesson.steps; }
  get step() { return this.steps[this.index] || null; }
  get done() { return this.index >= this.steps.length; }
  // True while the eye must not catch anyone: a calm lesson is being taught.
  get calm() { return !!this.step?.calm; }
  get isLast() { return this.lessonIndex === LESSONS.length - 1; }

  // Feed a human action in. Returns true if it passed the current step.
  emit(event, detail = {}) {
    const s = this.step;
    if (!s || s.on !== event) return false;
    if (s.test && !s.test(detail)) return false;
    this.advance();
    return true;
  }

  // Move past the current step: it passed, or main.js could not stage it on
  // this map (no door to stand next to, say) and must not strand the player.
  advance() {
    if (this.done) return;
    this.index++;
    this.onChange(this);
  }

  // Leave the lesson and play on as a normal game. The escape hatch every
  // step needs (Brain demo-disc#E51): nothing here may strand the player.
  skip() {
    if (this.done) return;
    this.index = this.steps.length;
    this.skipped = true;
    this.onChange(this);
  }

  view(scheme = "keyboard") {
    const s = this.step;
    if (!s) return null;
    const k = KEYS[scheme] || KEYS.keyboard;
    return {
      id: s.id, n: this.index + 1, total: this.steps.length, title: s.title, text: s.text(k), skip: k.skip,
      lesson: this.lessonIndex + 1, lessons: LESSONS.length, lessonTitle: this.lesson.title,
    };
  }
}
