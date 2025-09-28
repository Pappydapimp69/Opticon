// Panopticon Prototype - Phaser 3 (no external assets)
// Hotseat: switch view to play as Prisoner/Watcher on a single machine.

const TILE_SIZE = 20;
const BUILD_ID = "v-20250927-0135"; // update when deploying changes
const GRID = 41; // odd for a clear center
const HALF = Math.floor(GRID / 2);

// Map layers/types
const TILE = {
  FLOOR: 0,
  WALL: 1,
  MOAT: 2,
};

// Object types that sit on FLOOR tiles
const OBJ = {
  NONE: 0,
  DOOR_LOCKED: 1,
  WALL_OBJ: 2,
  GLASS: 3,
};

const DIRS = ["North", "East", "South", "West"]; // 0..3

const state = {
  map: [],
  tiles: [], // tile sprites for rendering
  objects: [], // grid of OBJ types
  objSprites: [], // object sprites for rendering
  prisoner: { x: HALF + 6, y: HALF + 8, mp: 3, startTurnPos: null },
  watcher: { facing: 0, bluff: null },
  turn: "Prisoner", // or "Watcher"
  view: "Prisoner", // UI view
  noiseMarkers: [], // {x,y,ttl}
  ringIndex: [], // per tile ring index (1..N), 0 for non-playable, -1 for moat/tower
  ringThickness: 5,
  moatThickness: 5,
  ringCount: 0,
  debug: {
    mapMakerUnlocked: false,
    mapMakerVisible: false,
  },
};

const MAP_MAKER_SEQUENCE = "*map";
let mapMakerProgress = 0;

function normalizeKey(key) {
  if (typeof key !== "string" || key.length !== 1) return null;
  return key.toLowerCase();
}

function handleMapMakerUnlock(event) {
  const key = normalizeKey(event.key);
  if (!key) {
    mapMakerProgress = 0;
    return;
  }

  const expected = MAP_MAKER_SEQUENCE[mapMakerProgress];
  const normalizedExpected = expected ? expected.toLowerCase() : "";

  if (key === normalizedExpected) {
    mapMakerProgress += 1;
    if (mapMakerProgress === MAP_MAKER_SEQUENCE.length) {
      mapMakerProgress = 0;
      if (!state.debug.mapMakerUnlocked) {
        state.debug.mapMakerUnlocked = true;
        log("Map maker unlocked (debug mode).");
        openMapMaker();
      }
    }
    return;
  }

  // allow restart if this key matches the first sequence character
  mapMakerProgress = key === MAP_MAKER_SEQUENCE[0].toLowerCase() ? 1 : 0;
}

document.addEventListener("keydown", handleMapMakerUnlock);

function canOpenMapMaker() {
  return state.debug.mapMakerUnlocked;
}

function openMapMaker() {
  if (!canOpenMapMaker()) {
    log("Map maker locked. Enter *map to unlock.");
    return;
  }
  if (!state.debug.mapMakerVisible) {
    showMapMaker();
    log("Map maker opened.");
  }
}

// Simple WebAudio-based SFX
const sfx = {
  ctx: null,
  enabled: true,
};

function initAudio() {
  if (!sfx.ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      sfx.ctx = new AudioCtx();
    }
  }
}

function playTone(freq = 440, duration = 0.08, type = "sine", gain = 0.05) {
  if (!sfx.enabled) return;
  initAudio();
  if (!sfx.ctx) return;
  const t0 = sfx.ctx.currentTime;
  const osc = sfx.ctx.createOscillator();
  const g = sfx.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(gain, t0);
  // quick envelope to avoid clicks
  g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(sfx.ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playSfx(name) {
  switch (name) {
    case "move":
      playTone(520, 0.05, "triangle", 0.035);
      break;
    case "noise":
      playTone(220, 0.18, "sawtooth", 0.06);
      break;
    case "keys":
      // light key jiggle sequence for lockpicks
      playTone(1400, 0.03, "sine", 0.03);
      playTone(1700, 0.035, "triangle", 0.03);
      playTone(2000, 0.04, "sine", 0.028);
      break;
    case "door":
      // muted thunk + small click
      playTone(180, 0.06, "square", 0.05);
      playTone(900, 0.03, "sine", 0.025);
      break;
    case "wallhit":
      playTone(140, 0.08, "square", 0.06);
      break;
    case "glass":
      // brittle sparkle
      playTone(1200, 0.04, "triangle", 0.035);
      playTone(1600, 0.05, "sine", 0.03);
      break;
    case "rotate":
      playTone(360, 0.07, "square", 0.04);
      break;
    case "bluff":
      playTone(300, 0.06, "sine", 0.035);
      break;
    case "end_prisoner":
      playTone(660, 0.05, "triangle", 0.04);
      playTone(440, 0.08, "sine", 0.03);
      break;
    case "end_watcher":
      playTone(480, 0.05, "triangle", 0.04);
      playTone(720, 0.08, "sine", 0.03);
      break;
  }
}

const ui = {
  turnLabel: document.getElementById("turnLabel"),
  roleLabel: document.getElementById("roleLabel"),
  facingLabel: document.getElementById("facingLabel"),
  mpLabel: document.getElementById("mpLabel"),
  log: document.getElementById("log"),
  switchViewBtn: document.getElementById("switchViewBtn"),
  endTurnBtn: document.getElementById("endTurnBtn"),
  rotLeftBtn: document.getElementById("rotLeftBtn"),
  rotRightBtn: document.getElementById("rotRightBtn"),
  bluffEBtn: document.getElementById("bluffEBtn"),
  bluffNSBtn: document.getElementById("bluffNSBtn"),
  mapMakerOverlay: document.getElementById("mapMakerOverlay"),
  mapMakerCloseBtn: document.getElementById("mapMakerCloseBtn"),
};

function showMapMaker() {
  if (!ui.mapMakerOverlay) return;
  ui.mapMakerOverlay.classList.remove("hidden");
  state.debug.mapMakerVisible = true;
}

function hideMapMaker() {
  if (!ui.mapMakerOverlay) return;
  ui.mapMakerOverlay.classList.add("hidden");
  state.debug.mapMakerVisible = false;
}

if (ui.mapMakerCloseBtn) {
  ui.mapMakerCloseBtn.onclick = () => hideMapMaker();
}

function log(s) {
  const p = document.createElement("div");
  p.textContent = s;
  ui.log.prepend(p);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID && y < GRID;
}

function buildMap() {
  // Initialize to floor
  state.map = new Array(GRID)
    .fill(0)
    .map(() => new Array(GRID).fill(TILE.FLOOR));
  state.objects = new Array(GRID).fill(0).map(() => new Array(GRID).fill(OBJ.NONE));
  state.ringIndex = new Array(GRID).fill(0).map(() => new Array(GRID).fill(0));

  // Central tower (3x3)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = HALF + dx;
      const y = HALF + dy;
      state.map[y][x] = TILE.WALL;
      state.ringIndex[y][x] = -1;
    }
  }

  // Define moat and rings based on Chebyshev radius from center
  const moatT = state.moatThickness; // 5
  const ringT = state.ringThickness; // 5
  const ringBase = 1 + moatT; // last moat radius (tower radius=1)
  state.ringCount = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const r = Math.max(Math.abs(x - HALF), Math.abs(y - HALF));
      if (r === 0) continue;
      if (r <= 1 + moatT && state.ringIndex[y][x] === 0) {
        // moat band
        if (state.map[y][x] === TILE.FLOOR) state.map[y][x] = TILE.MOAT;
        state.ringIndex[y][x] = -1;
      } else if (r >= ringBase + 1) {
        const idx = Math.floor((r - (ringBase + 1)) / ringT) + 1; // 1..N
        state.ringIndex[y][x] = idx > 0 ? idx : 0;
        if (idx > state.ringCount) state.ringCount = idx;
      }
    }
  }

  // Outer walls to bound the play area
  for (let i = 0; i < GRID; i++) {
    state.map[0][i] = TILE.WALL;
    state.map[GRID - 1][i] = TILE.WALL;
    state.map[i][0] = TILE.WALL;
    state.map[i][GRID - 1] = TILE.WALL;
  }

  // Sprinkle some walls to create corridors/chokepoints in outer bands
  const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)(12345);
  for (let i = 0; i < 220; i++) {
    const x = 3 + Math.floor(rng() * (GRID - 6));
    const y = 3 + Math.floor(rng() * (GRID - 6));
    // avoid center/tower area
    if (Math.abs(x - HALF) <= 4 && Math.abs(y - HALF) <= 4) continue;
    if (state.map[y][x] === TILE.FLOOR && rng() < 0.15) {
      state.map[y][x] = TILE.WALL;
    }
  }

  // Place example sound-making objects on safe floor tiles
  function placeObj(x, y, type) {
    if (inBounds(x, y) && state.map[y][x] === TILE.FLOOR) state.objects[y][x] = type;
  }
  // Locked door near inner rings
  placeObj(HALF + 8, HALF + 2, OBJ.DOOR_LOCKED);
  // Special WALL object somewhere in mid ring
  placeObj(HALF - 9, HALF - 6, OBJ.WALL_OBJ);
  // Glass shards near outer ring
  placeObj(HALF + 12, HALF - 10, OBJ.GLASS);
}

function isWalkable(x, y) {
  if (!inBounds(x, y)) return false;
  const t = state.map[y][x];
  return t === TILE.FLOOR; // moat and wall are blocked
}

function computePrisonerFOV() {
  // returns a boolean grid of visibility, along N/E/S/W up to 5 tiles, blocked by walls/moat
  const vis = new Array(GRID).fill(0).map(() => new Array(GRID).fill(false));
  const { x, y } = state.prisoner;
  vis[y][x] = true;

  const rays = [
    { dx: 0, dy: -1 }, // N
    { dx: 1, dy: 0 }, // E
    { dx: 0, dy: 1 }, // S
    { dx: -1, dy: 0 }, // W
  ];
  for (const r of rays) {
    let cx = x;
    let cy = y;
    for (let step = 0; step < 5; step++) {
      cx += r.dx;
      cy += r.dy;
      if (!inBounds(cx, cy)) break;
      vis[cy][cx] = true;
      if (state.map[cy][cx] !== TILE.FLOOR) break; // blocked by wall or moat
    }
  }
  return vis;
}

function screenFromGrid(x, y) {
  const offsetX = 360; // leave space for UI (340px) + padding
  const offsetY = 20;
  return { sx: offsetX + x * TILE_SIZE, sy: offsetY + y * TILE_SIZE };
}

// 90-degree wedge FOV from center tower in the facing direction
function inWatcherFOV(dir, x, y) {
  const dx = x - HALF;
  const dy = y - HALF;
  switch (dir) {
    case 0: // North
      return dy < 0 && Math.abs(dx) <= -dy;
    case 1: // East
      return dx > 0 && Math.abs(dy) <= dx;
    case 2: // South
      return dy > 0 && Math.abs(dx) <= dy;
    case 3: // West
      return dx < 0 && Math.abs(dy) <= -dx;
  }
  return false;
}

function createTextures(scene) {
  // Generate small textured squares for floor, wall, and moat
  const sz = TILE_SIZE - 1;

  // Helper to make texture
  const makeTex = (key, bg, drawFn) => {
    const g = scene.add.graphics();
    g.fillStyle(bg, 1.0);
    g.fillRect(0, 0, sz, sz);
    if (drawFn) drawFn(g, sz);
    g.generateTexture(key, sz, sz);
    g.destroy();
  };

  // Floor: subtle speckle
  makeTex("tex_floor", 0x171b28, (g, s) => {
    g.fillStyle(0x20273a, 0.8);
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * s;
      const y = Math.random() * s;
      g.fillRect(x, y, 1, 1);
    }
  });

  // Wall: horizontal hatch lines
  makeTex("tex_wall", 0x2a2f45, (g, s) => {
    g.lineStyle(1, 0x3a4160, 1);
    for (let y = 2; y < s; y += 4) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(s, y);
      g.strokePath();
    }
  });

  // Moat: dark water with diagonal ripples
  makeTex("tex_moat", 0x121827, (g, s) => {
    g.lineStyle(1, 0x1e2740, 1);
    for (let i = -s; i < s; i += 6) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + s, s);
      g.strokePath();
    }
  });

  // Objects
  // Locked door: brown plank with a small lock dot
  makeTex("tex_obj_door", 0x5a3a22, (g, s) => {
    g.lineStyle(1, 0x7a5233, 1);
    for (let y = 3; y < s - 3; y += 6) {
      g.beginPath(); g.moveTo(2, y); g.lineTo(s - 2, y); g.strokePath();
    }
    g.fillStyle(0xd9b38c, 1);
    g.fillCircle(s - 6, s / 2, 2);
  });
  // WALL object: dark block with cross hatch
  makeTex("tex_obj_wall", 0x2b2f3f, (g, s) => {
    g.lineStyle(1, 0x3a425a, 1);
    for (let i = 2; i < s; i += 5) { g.beginPath(); g.moveTo(i, 0); g.lineTo(0, i); g.strokePath(); }
    for (let i = 2; i < s; i += 5) { g.beginPath(); g.moveTo(s, i); g.lineTo(i, s); g.strokePath(); }
  });
  // Glass shards: blue tint with random shard lines
  makeTex("tex_obj_glass", 0x163048, (g, s) => {
    g.lineStyle(1, 0x7fc8ff, 1);
    for (let i = 0; i < 8; i++) {
      const x1 = Math.random() * s, y1 = Math.random() * s;
      const x2 = Math.random() * s, y2 = Math.random() * s;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.strokePath();
    }
  });
}

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  create() {
    this.cameras.main.setBackgroundColor("#0e0f13");

    buildMap();
    state.prisoner.startTurnPos = { x: state.prisoner.x, y: state.prisoner.y };

    // Create procedural textures for tiles
    createTextures(this);

    // draw grid as textured sprites
    for (let y = 0; y < GRID; y++) {
      state.tiles[y] = [];
      state.objSprites[y] = [];
      for (let x = 0; x < GRID; x++) {
        const { sx, sy } = screenFromGrid(x, y);
        const t = state.map[y][x];
        const key = t === TILE.WALL ? "tex_wall" : t === TILE.MOAT ? "tex_moat" : "tex_floor";
        const img = this.add.image(sx, sy, key).setOrigin(0, 0);
        img.setDisplaySize(TILE_SIZE - 1, TILE_SIZE - 1);
        state.tiles[y][x] = img;

        // Object sprite if present
        const obj = state.objects[y][x];
        let okey = null;
        if (obj === OBJ.DOOR_LOCKED) okey = "tex_obj_door";
        else if (obj === OBJ.WALL_OBJ) okey = "tex_obj_wall";
        else if (obj === OBJ.GLASS) okey = "tex_obj_glass";
        if (okey) {
          const oimg = this.add.image(sx, sy, okey).setOrigin(0, 0);
          oimg.setDisplaySize(TILE_SIZE - 1, TILE_SIZE - 1);
          oimg.setDepth(1.5);
          state.objSprites[y][x] = oimg;
        } else {
          state.objSprites[y][x] = null;
        }
      }
    }

    // prisoner marker
    this.prisonerMarker = this.add.rectangle(0, 0, TILE_SIZE - 4, TILE_SIZE - 4, 0x5ad4e6).setOrigin(0, 0);
    this.prisonerMarker.setDepth(2);

    // watcher facing cone overlay (simple cardinal highlight)
    this.watcherOverlay = this.add.graphics();
    this.watcherOverlay.setDepth(1);

    // rings overlay for boundaries
    this.ringsOverlay = this.add.graphics();
    this.ringsOverlay.setDepth(0.9);

    // noise markers
    this.noiseLayer = this.add.graphics();
    this.noiseLayer.setDepth(3);

    // input
    this.cursors = this.input.keyboard.createCursorKeys();

    // UI events
    ui.switchViewBtn.onclick = () => {
      state.view = state.view === "Prisoner" ? "Watcher" : "Prisoner";
      updateUI();
      log(`View switched to ${state.view}`);
      this.renderAll();
    };

    ui.endTurnBtn.onclick = () => this.endTurn();
    ui.rotLeftBtn.onclick = () => this.rotateWatcher(-1);
    ui.rotRightBtn.onclick = () => this.rotateWatcher(1);
    ui.bluffEBtn.onclick = () => this.setBluff("East/West");
    ui.bluffNSBtn.onclick = () => this.setBluff("North/South");
    const soundToggle = document.getElementById("soundToggle");
    if (soundToggle) {
      sfx.enabled = soundToggle.checked;
      soundToggle.addEventListener("change", () => {
        sfx.enabled = soundToggle.checked;
        if (sfx.enabled) initAudio();
      });
    }

    updateUI();
    this.renderAll();
  }

  rotateWatcher(delta) {
    if (state.turn !== "Watcher") return;
    state.watcher.facing = (state.watcher.facing + delta + 4) % 4;
    log(`Watcher rotated to ${DIRS[state.watcher.facing]}`);
    playSfx("rotate");
    updateUI();
    this.renderAll();
  }

  setBluff(text) {
    if (state.turn !== "Watcher") return;
    state.watcher.bluff = text;
    log(`Watcher bluff declared: ${text}`);
    playSfx("bluff");
    this.renderAll();
  }

  endTurn() {
    if (state.turn === "Prisoner") {
      // noise if moved 2+ tiles
      const moved = Math.abs(state.prisoner.x - state.prisoner.startTurnPos.x) + Math.abs(state.prisoner.y - state.prisoner.startTurnPos.y);
      if (moved >= 2) {
        const { x, y } = state.prisoner.startTurnPos;
        state.noiseMarkers.push({ x, y, ttl: 4 });
        log(`Noise reported at (${x}, ${y})`);
        playSfx("noise");
      }
      state.turn = "Watcher";
      state.prisoner.mp = 0;
      log("Turn ended: Watcher");
      playSfx("end_prisoner");
    } else {
      // Watcher end turn: reset bluff optionally, then prisoner gets 3 MP
      state.turn = "Prisoner";
      state.prisoner.mp = 3;
      state.prisoner.startTurnPos = { x: state.prisoner.x, y: state.prisoner.y };
      log("Turn ended: Prisoner");
      playSfx("end_watcher");
    }
    updateUI();
    this.renderAll();
  }

  tryMove(dx, dy) {
    if (state.turn !== "Prisoner" || state.prisoner.mp <= 0) return;
    const nx = clamp(state.prisoner.x + dx, 0, GRID - 1);
    const ny = clamp(state.prisoner.y + dy, 0, GRID - 1);
    // Map collision: walls/moat
    if (!isWalkable(nx, ny)) {
      log("You hit a wall.");
      playSfx("wallhit");
      return;
    }
    // Object interaction checks
    const obj = state.objects[ny][nx];
    if (obj === OBJ.DOOR_LOCKED) {
      log("You try your lockpicks... the door is locked.");
      playSfx("keys");
      return;
    }
    if (obj === OBJ.WALL_OBJ) {
      log("You bump into a wall.");
      playSfx("wallhit");
      return;
    }

    // Move succeeds
    state.prisoner.x = nx;
    state.prisoner.y = ny;
    state.prisoner.mp -= 1;

    if (obj === OBJ.GLASS) {
      // Stepping on glass generates immediate noise and persists
      state.noiseMarkers.push({ x: nx, y: ny, ttl: 4 });
      log(`Glass shards crunch at (${nx}, ${ny})`);
      playSfx("glass");
    } else {
      playSfx("move");
    }
    updateUI();
    this.renderAll();
  }

  update(time, delta) {
    // Input handling for prisoner movement
    if (state.turn === "Prisoner") {
      if (Phaser.Input.Keyboard.JustDown(this.cursors.left)) this.tryMove(-1, 0);
      else if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) this.tryMove(1, 0);
      else if (Phaser.Input.Keyboard.JustDown(this.cursors.up)) this.tryMove(0, -1);
      else if (Phaser.Input.Keyboard.JustDown(this.cursors.down)) this.tryMove(0, 1);
    }

    // Fade noise markers
    if (state.noiseMarkers.length) {
      for (const n of state.noiseMarkers) n.ttl -= delta / 1000;
      state.noiseMarkers = state.noiseMarkers.filter(n => n.ttl > 0);
    }
  }

  renderAll() {
    // color tiles by type, then overlay FoV / watcher view
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const sprite = state.tiles[y][x];
        const t = state.map[y][x];
        const key = t === TILE.WALL ? "tex_wall" : t === TILE.MOAT ? "tex_moat" : "tex_floor";
        if (sprite.texture.key !== key) sprite.setTexture(key);
        // Keep base tiles un-tinted for clarity; ring bands will be drawn as an overlay
        sprite.clearTint();
        sprite.setTint(0xffffff);
        sprite.setAlpha(1.0);
      }
    }

    // Prisoner FoV if viewing as Prisoner
    const fov = computePrisonerFOV();
    if (state.view === "Prisoner") {
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          if (!fov[y][x]) state.tiles[y][x].alpha = 0.2; // dark outside FoV
        }
      }
    }

    // Draw watcher overlay: facing rays, FOV wedge, and bluff bands
    this.watcherOverlay.clear();
    if (state.view === "Watcher") {
      // Facing highlight
      const dir = state.watcher.facing;
      const rayColor = 0x4a8ef7;
      this.watcherOverlay.lineStyle(2, rayColor, 0.6);

      // draw a long ray in facing direction from tower center
      let cx = HALF, cy = HALF;
      const vecs = [
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
      ];
      const v = vecs[dir];
      const start = screenFromGrid(cx, cy);
      let endX = cx, endY = cy;
      for (let i = 0; i < GRID; i++) {
        endX += v.dx;
        endY += v.dy;
        if (!inBounds(endX, endY)) break;
        if (state.map[endY][endX] === TILE.WALL) break;
      }
      const end = screenFromGrid(endX + 0.5, endY + 0.5);
      this.watcherOverlay.beginPath();
      this.watcherOverlay.moveTo(start.sx + TILE_SIZE / 2, start.sy + TILE_SIZE / 2);
      this.watcherOverlay.lineTo(end.sx, end.sy);
      this.watcherOverlay.strokePath();

      // FOV wedge overlay over tiles within 90-degree facing sector
      this.watcherOverlay.fillStyle(0x4a8ef7, 0.12);
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          if (inWatcherFOV(dir, x, y)) {
            const { sx, sy } = screenFromGrid(x, y);
            this.watcherOverlay.fillRect(sx, sy, TILE_SIZE - 1, TILE_SIZE - 1);
          }
        }
      }

      // Bluff overlay: shade relevant halves
      if (state.watcher.bluff) {
        const bluff = state.watcher.bluff;
        this.watcherOverlay.fillStyle(0xf7c14a, 0.08);
        if (bluff === "East/West") {
          // shade left and right halves
          const mid = HALF;
          for (let y = 0; y < GRID; y++) {
            for (let x = 0; x < GRID; x++) {
              if (x < mid || x > mid) {
                const { sx, sy } = screenFromGrid(x, y);
                this.watcherOverlay.fillRect(sx, sy, TILE_SIZE - 1, TILE_SIZE - 1);
              }
            }
          }
        } else if (bluff === "North/South") {
          const mid = HALF;
          for (let y = 0; y < GRID; y++) {
            for (let x = 0; x < GRID; x++) {
              if (y < mid || y > mid) {
                const { sx, sy } = screenFromGrid(x, y);
                this.watcherOverlay.fillRect(sx, sy, TILE_SIZE - 1, TILE_SIZE - 1);
              }
            }
          }
        }
      }
    }

    // Draw ring bands and clearer boundaries (independent of view)
    this.ringsOverlay.clear();
    // Fill alternating bands
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const idx = state.ringIndex[y][x];
        if (idx > 0) {
          // alternate soft fills; odd rings slightly bluish, even rings subtle
          const color = idx % 2 === 1 ? 0x93c5fd : 0x000000;
          const alpha = idx % 2 === 1 ? 0.07 : 0.03;
          const { sx, sy } = screenFromGrid(x, y);
          this.ringsOverlay.fillStyle(color, alpha);
          this.ringsOverlay.fillRect(sx, sy, TILE_SIZE - 1, TILE_SIZE - 1);
        }
      }
    }
    // Boundary outlines: thicker and brighter
    this.ringsOverlay.lineStyle(3, 0x9ca3af, 0.7);
    const ringT = state.ringThickness;
    const ringBase = 1 + state.moatThickness;
    for (let k = 1; k <= state.ringCount; k++) {
      const boundaryR = ringBase + k * ringT; // outer edge of ring k
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const r = Math.max(Math.abs(x - HALF), Math.abs(y - HALF));
          if (r === boundaryR) {
            const { sx, sy } = screenFromGrid(x, y);
            this.ringsOverlay.strokeRect(sx + 0.5, sy + 0.5, TILE_SIZE - 2, TILE_SIZE - 2);
          }
        }
      }
    }

    // Draw prisoner marker if visible in current view
    const { sx, sy } = screenFromGrid(state.prisoner.x, state.prisoner.y);
    this.prisonerMarker.setPosition(sx + 2, sy + 2);
    if (state.view === "Watcher") {
      // Watcher never sees the prisoner directly in this prototype
      this.prisonerMarker.setVisible(false);
    } else {
      // prisoner view: marker visible only if inside FoV
      this.prisonerMarker.setVisible(fov[state.prisoner.y][state.prisoner.x]);
    }

    // Draw noise markers (Watcher view only)
    this.noiseLayer.clear();
    if (state.view === "Watcher") {
      for (const n of state.noiseMarkers) {
        const p = screenFromGrid(n.x, n.y);
        this.noiseLayer.fillStyle(0xff5757, 0.8);
        this.noiseLayer.fillCircle(p.sx + TILE_SIZE / 2, p.sy + TILE_SIZE / 2, 4);
      }
    }
  }
}

function updateUI() {
  ui.turnLabel.textContent = state.turn;
  ui.roleLabel.textContent = state.view;
  ui.facingLabel.textContent = DIRS[state.watcher.facing];
  ui.mpLabel.textContent = state.prisoner.mp.toString();
  const buildEl = document.getElementById("buildLabel");
  if (buildEl) buildEl.textContent = BUILD_ID;
}

const config = {
  type: Phaser.AUTO,
  width: 360 + GRID * TILE_SIZE + 20,
  height: 20 + GRID * TILE_SIZE + 20,
  parent: "game",
  backgroundColor: "#0e0f13",
  scene: [MainScene],
};

new Phaser.Game(config);
