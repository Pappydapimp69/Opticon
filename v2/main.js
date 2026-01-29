// Opticon v2 – Core Game Logic
// Zane – January 2026
// Phaser 3 – 31×31 grid, 5 rings, win conditions, obstacles, watcher limits

const TILE_SIZE = 20;
const GRID = 31;
const HALF = Math.floor(GRID / 2);

// Tile types
const TILE = {
  FLOOR: 0,
  WALL: 1,
  MOAT: 2
};

// Object types on floor
const OBJ = {
  NONE: 0,
  GLASS: 1,   // noise on step
  DOOR: 2     // noise + opens on step
};

const DIRS = ["North", "East", "South", "West"]; // 0=N, 1=E, 2=S, 3=W

// Global state
const state = {
  map: [],
  objects: [],
  ringIndex: [],          // 0 = invalid, -1 = tower/moat, 1–5 = playable rings
  tiles: [],              // Phaser images
  prisoner: { x: HALF + 4, y: HALF + 6, mp: 3, startTurnPos: null },
  watcher: { facing: 0, bluffDir: null, hasRotated: false },
  turn: "Prisoner",
  view: "Prisoner",
  noiseMarkers: [],       // {x, y, ttl}
  ringCount: 5,
  ringThickness: 4,
  moatThickness: 3
};

let game; // global Phaser.Game instance

class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0e0f13');

    buildMap();
    state.prisoner.startTurnPos = { x: state.prisoner.x, y: state.prisoner.y };

    createTextures(this);

    // Draw grid
    for (let y = 0; y < GRID; y++) {
      state.tiles[y] = [];
      for (let x = 0; x < GRID; x++) {
        const { sx, sy } = screenFromGrid(x, y);
        const t = state.map[y][x];
        let key = 'tex_floor';
        if (t === TILE.WALL) key = 'tex_wall';
        if (t === TILE.MOAT) key = 'tex_moat';

        const img = this.add.image(sx, sy, key).setOrigin(0);
        img.setDisplaySize(TILE_SIZE - 1, TILE_SIZE - 1);
        state.tiles[y][x] = img;
      }
    }

    // Prisoner marker
    this.prisonerMarker = this.add.rectangle(0, 0, TILE_SIZE - 4, TILE_SIZE - 4, 0x5ad4e6)
      .setOrigin(0)
      .setDepth(10);

    // Noise overlay
    this.noiseLayer = this.add.graphics().setDepth(5);

    // Input
    this.cursors = this.input.keyboard.createCursorKeys();

    // Keyboard shortcuts
    this.input.keyboard.on('keydown-TAB', () => this.toggleView());
    this.input.keyboard.on('keydown-SPACE', () => this.endTurn());
    this.input.keyboard.on('keydown-Q', () => this.rotateWatcher(-1));
    this.input.keyboard.on('keydown-E', () => this.rotateWatcher(1));
    this.input.keyboard.on('keydown-ONE', () => this.setBluff(0));
    this.input.keyboard.on('keydown-TWO', () => this.setBluff(1));
    this.input.keyboard.on('keydown-THREE', () => this.setBluff(2));
    this.input.keyboard.on('keydown-FOUR', () => this.setBluff(3));

    this.createUI();

    updateUI(this);
    this.renderAll();
  }

  update(time, delta) {
    // Decay noise markers
    state.noiseMarkers = state.noiseMarkers.filter(m => {
      m.ttl -= delta / 1000;
      return m.ttl > 0;
    });

    if (state.turn !== "Prisoner") return;

    // Movement input
    if (Phaser.Input.Keyboard.JustDown(this.cursors.left))  this.tryMove(-1, 0);
    if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) this.tryMove(1, 0);
    if (Phaser.Input.Keyboard.JustDown(this.cursors.up))    this.tryMove(0, -1);
    if (Phaser.Input.Keyboard.JustDown(this.cursors.down))  this.tryMove(0, 1);

    this.renderAll();
  }

  createUI() {
    const pad = 20;
    let y = pad;

    // Title
    this.add.text(pad, y, 'Opticon v2', { fontSize: '32px', color: '#e9eef6' });
    y += 50;

    this.turnLabel   = this.add.text(pad, y, '', { fontSize: '20px', color: '#fff' });
    y += 30;
    this.roleLabel   = this.add.text(pad, y, '', { fontSize: '20px', color: '#fff' });
    y += 30;
    this.facingLabel = this.add.text(pad, y, '', { fontSize: '20px', color: '#fff' });
    y += 30;
    this.mpLabel     = this.add.text(pad, y, '', { fontSize: '20px', color: '#fff' });
    y += 50;

    // Controls help
    this.add.text(pad, y, 'Tab = Switch View', { fontSize: '18px', color: '#aaa' });
    y += 30;
    this.add.text(pad, y, 'Space = End Turn', { fontSize: '18px', color: '#aaa' });
    y += 40;
    this.add.text(pad, y, 'Q / E = Rotate Left / Right', { fontSize: '18px', color: '#aaa' });
    y += 30;
    this.add.text(pad, y, '1 2 3 4 = Bluff N E S W', { fontSize: '18px', color: '#aaa' });
  }

  toggleView() {
    state.view = state.view === "Prisoner" ? "Watcher" : "Prisoner";
    updateUI(this);
    this.renderAll();
  }

  tryMove(dx, dy) {
    if (state.turn !== "Prisoner" || state.prisoner.mp <= 0) return;
    const nx = state.prisoner.x + dx;
    const ny = state.prisoner.y + dy;
    if (!isWalkable(nx, ny)) return;

    let noise = false;
    const obj = state.objects[ny][nx];
    if (obj === OBJ.GLASS) {
      noise = true;
      this.addLog("Stepped on glass – noisy!");
    } else if (obj === OBJ.DOOR) {
      noise = true;
      state.objects[ny][nx] = OBJ.NONE;
      this.addLog("Door forced open – noisy!");
    }

    if (noise) addNoise(nx, ny);

    state.prisoner.x = nx;
    state.prisoner.y = ny;
    state.prisoner.mp--;

    // Win check – escape outer ring
    if (getRing(nx, ny) === state.ringCount) {
      this.addLog("*** PRISONER ESCAPES RING 5! ***");
      this.resetGame("Prisoner");
      return;
    }

    this.renderAll();
    updateUI(this);
  }

  rotateWatcher(delta) {
    if (state.turn !== "Watcher" || state.watcher.hasRotated) return;
    state.watcher.facing = (state.watcher.facing + delta + 4) % 4;
    state.watcher.hasRotated = true;
    this.addLog(`Watcher rotated to ${DIRS[state.watcher.facing]}`);
    updateUI(this);
    this.renderAll();
  }

  setBluff(dir) {
    if (state.turn !== "Watcher") return;
    const facing = state.watcher.facing;
    if (dir === facing || dir === opposite(facing)) return;
    state.watcher.bluffDir = dir;
    this.addLog(`Watcher bluffs ${DIRS[dir]}`);
    updateUI(this);
    this.renderAll();
  }

  endTurn() {
    if (state.turn === "Prisoner") {
      const moved = Math.abs(state.prisoner.x - state.prisoner.startTurnPos.x) +
                    Math.abs(state.prisoner.y - state.prisoner.startTurnPos.y);
      if (moved >= 2) {
        addNoise(state.prisoner.startTurnPos.x, state.prisoner.startTurnPos.y);
      }
      state.turn = "Watcher";
      state.prisoner.mp = 0;
      state.watcher.hasRotated = false;
      this.addLog("Turn: Watcher");
      // Capture check
      if (hasNoiseAt(state.prisoner.x, state.prisoner.y) &&
          inWatcherFOV(state.watcher.facing, state.prisoner.x, state.prisoner.y)) {
        this.addLog("*** WATCHER CAPTURES VIA NOISE! ***");
        this.resetGame("Watcher");
        return;
      }
    } else {
      // Watcher end: paranoia alert
      const q = getQuadrant(state.prisoner.x, state.prisoner.y);
      if (q === state.watcher.facing || q === state.watcher.bluffDir) {
        this.addLog("*** You feel like you're being watched. ***", true);
      }
      state.watcher.bluffDir = null;
      state.turn = "Prisoner";
      state.prisoner.mp = 3;
      state.prisoner.startTurnPos = { x: state.prisoner.x, y: state.prisoner.y };
      this.addLog("Turn: Prisoner");
    }
    updateUI(this);
    this.renderAll();
  }

  resetGame(winner) {
    this.addLog(`${winner.toUpperCase()} WINS! Resetting...`);
    buildMap();
    state.prisoner = { x: HALF + 4, y: HALF + 6, mp: 3, startTurnPos: null };
    state.watcher = { facing: 0, bluffDir: null, hasRotated: false };
    state.turn = "Prisoner";
    state.view = "Prisoner";
    state.noiseMarkers = [];
    state.prisoner.startTurnPos = { x: state.prisoner.x, y: state.prisoner.y };
    updateUI(this);
    this.renderAll();
  }

  addLog(text, isAlert = false) {
    const color = isAlert ? '#ff6b6b' : '#9ca3af';
    const logText = this.add.text(20, 600 + (this.children.list.filter(c => c.type === 'Text' && c.y >= 600).length * 22),
      text, { fontSize: '16px', color, wordWrap: { width: 300 } });
    // Auto-remove after 15 seconds
    this.time.delayedCall(15000, () => logText.destroy());
  }

  renderAll() {
    // Reset tints
    state.tiles.flat().forEach(t => {
      t.clearTint();
      t.setAlpha(1);
    });

    const isPrisonerView = state.view === "Prisoner";

    // Shade watcher gaze and bluff
    const realTint = isPrisonerView ? 0x666688 : 0x88ff88;
    const bluffTint = isPrisonerView ? 0x666688 : 0x444422;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (inWatcherFOV(state.watcher.facing, x, y)) {
          state.tiles[y][x].setTint(realTint);
        } else if (state.watcher.bluffDir !== null && inWatcherFOV(state.watcher.bluffDir, x, y)) {
          state.tiles[y][x].setTint(bluffTint);
        }
      }
    }

    // Prisoner FOV dim in prisoner view
    if (isPrisonerView) {
      const vis = computePrisonerFOV();
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          if (!vis[y][x]) state.tiles[y][x].setAlpha(0.3);
        }
      }
    }

    // Prisoner marker
    const { sx, sy } = screenFromGrid(state.prisoner.x, state.prisoner.y);
    this.prisonerMarker.setPosition(sx + 2, sy + 2)
      .setVisible(state.view === "Prisoner");

    // Noise circles (watcher view only)
    this.noiseLayer.clear();
    if (state.view === "Watcher") {
      state.noiseMarkers.forEach(m => {
        if (m.ttl > 0) {
          const { sx, sy } = screenFromGrid(m.x, m.y);
          this.noiseLayer.fillStyle(0xff4444, clamp(m.ttl / 4, 0, 1));
          this.noiseLayer.fillCircle(sx + TILE_SIZE/2, sy + TILE_SIZE/2, TILE_SIZE * 0.6);
        }
      });
    }
  }
}

// ────────────────────────────────────────────────
// Helper functions (outside scene)
// ────────────────────────────────────────────────

function buildMap() {
  state.map = Array(GRID).fill().map(() => Array(GRID).fill(TILE.FLOOR));
  state.objects = Array(GRID).fill().map(() => Array(GRID).fill(OBJ.NONE));
  state.ringIndex = Array(GRID).fill().map(() => Array(GRID).fill(0));

  // Central tower
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      state.map[HALF + dy][HALF + dx] = TILE.WALL;
      state.ringIndex[HALF + dy][HALF + dx] = -1;
    }
  }

  // Moat
  for (let r = 2; r <= 1 + state.moatThickness; r++) {
    for (let y = HALF - r; y <= HALF + r; y++) {
      for (let x = HALF - r; x <= HALF + r; x++) {
        if (Math.max(Math.abs(x - HALF), Math.abs(y - HALF)) === r && inBounds(x, y)) {
          state.map[y][x] = TILE.MOAT;
          state.ringIndex[y][x] = -1;
        }
      }
    }
  }

  // Rings
  let currentRadius = 2 + state.moatThickness;
  for (let ring = 1; ring <= state.ringCount; ring++) {
    const ringStart = currentRadius;
    currentRadius += state.ringThickness;
    for (let r = ringStart; r < currentRadius; r++) {
      for (let y = HALF - r; y <= HALF + r; y++) {
        for (let x = HALF - r; x <= HALF + r; x++) {
          if (Math.max(Math.abs(x - HALF), Math.abs(y - HALF)) === r && inBounds(x, y)) {
            state.ringIndex[y][x] = ring;
          }
        }
      }
    }
  }

  // Procedural walls & obstacles
  const rng = Math.random;
  for (let i = 0; i < 120; i++) {
    const x = Math.floor(rng() * (GRID - 6)) + 3;
    const y = Math.floor(rng() * (GRID - 6)) + 3;
    if (state.ringIndex[y][x] > 0 && state.map[y][x] === TILE.FLOOR) {
      if (rng() < 0.30) state.map[y][x] = TILE.WALL;
      if (rng() < 0.18) state.objects[y][x] = rng() < 0.5 ? OBJ.GLASS : OBJ.DOOR;
    }
  }
}

function createTextures(scene) {
  const sz = TILE_SIZE - 1;

  const makeTex = (key, color, extra) => {
    const g = scene.add.graphics();
    g.fillStyle(color);
    g.fillRect(0, 0, sz, sz);
    if (extra) extra(g);
    g.generateTexture(key, sz, sz);
    g.destroy();
  };

  makeTex('tex_floor', 0x171b28, g => {
    g.fillStyle(0x20273a, 0.5);
    for (let i = 0; i < 12; i++) {
      g.fillRect(Math.random()*sz, Math.random()*sz, 2, 2);
    }
  });

  makeTex('tex_wall', 0x2a2f45, g => {
    g.lineStyle(2, 0x3a4160);
    for (let i = 4; i < sz; i += 8) {
      g.lineBetween(0, i, sz, i);
    }
  });

  makeTex('tex_moat', 0x121827, g => {
    g.lineStyle(1, 0x1e2740);
    for (let i = 0; i < sz*2; i += 10) {
      g.lineBetween(i-sz, 0, i, sz);
    }
  });
}

function screenFromGrid(x, y) {
  return { sx: 100 + x * TILE_SIZE, sy: 80 + y * TILE_SIZE };
}

function inBounds(x, y) {
  return x >= 0 && x < GRID && y >= 0 && y < GRID;
}

function isWalkable(x, y) {
  if (!inBounds(x, y)) return false;
  return state.map[y][x] === TILE.FLOOR;
}

function inWatcherFOV(dir, x, y) {
  const dx = x - HALF;
  const dy = y - HALF;
  switch (dir) {
    case 0: return dy <= 0 && Math.abs(dx) <= -dy;
    case 1: return dx >= 0 && Math.abs(dy) <= dx;
    case 2: return dy >= 0 && Math.abs(dx) <= dy;
    case 3: return dx <= 0 && Math.abs(dy) <= -dx;
    default: return false;
  }
}

function getQuadrant(x, y) {
  for (let d = 0; d < 4; d++) {
    if (inWatcherFOV(d, x, y)) return d;
  }
  return -1;
}

function opposite(dir) {
  return (dir + 2) % 4;
}

function getRing(x, y) {
  return inBounds(x, y) ? state.ringIndex[y][x] : 0;
}

function hasNoiseAt(x, y) {
  return state.noiseMarkers.some(m => m.x === x && m.y === y && m.ttl > 0);
}

function addNoise(x, y) {
  state.noiseMarkers.push({ x, y, ttl: 4 });
}

function computePrisonerFOV() {
  const vis = Array(GRID).fill().map(() => Array(GRID).fill(false));
  const { x, y } = state.prisoner;
  vis[y][x] = true;

  const dirs = [{dx:0,dy:-1}, {dx:1,dy:0}, {dx:0,dy:1}, {dx:-1,dy:0}];
  dirs.forEach(d => {
    let cx = x, cy = y;
    for (let step = 0; step < 5; step++) {
      cx += d.dx; cy += d.dy;
      if (!inBounds(cx, cy)) break;
      vis[cy][cx] = true;
      if (state.map[cy][cx] !== TILE.FLOOR) break;
    }
  });
  return vis;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function updateUI(scene) {
  scene.turnLabel.setText(`Turn: ${state.turn}`);
  scene.roleLabel.setText(`View: ${state.view}`);
  scene.facingLabel.setText(`Facing: ${DIRS[state.watcher.facing]}`);
  scene.mpLabel.setText(`MP: ${state.prisoner.mp}`);
}

// Launch the game
const config = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  parent: 'game',
  scene: [MainScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  backgroundColor: '#0e0f13'
};

game = new Phaser.Game(config);