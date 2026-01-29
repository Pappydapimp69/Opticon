// Opticon v2 – Core Game Logic
// Zane – January 2026
// Phaser 3 – 31x31 grid, 5 rings, win conditions, obstacles, watcher limits

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

    // Prisoner marker (visible only in Prisoner view)
    this.prisonerMarker = this.add.rectangle(0, 0, TILE_SIZE - 4, TILE_SIZE - 4, 0x5ad4e6)
      .setOrigin(0)
      .setDepth(10);

    // Noise overlay
    this.noiseLayer = this.add.graphics().setDepth(5);

    // Input
    this.cursors = this.input.keyboard.createCursorKeys();

    // UI buttons (simple Phaser text buttons for now)
    this.createUI();

    updateUI(this);
    this.renderAll();
  }

  update(time, delta) {
    // Decay noise
    state.noiseMarkers = state.noiseMarkers.filter(m => {
      m.ttl -= delta / 1000;
      return m.ttl > 0;
    });

    if (state.turn !== "Prisoner") return;

    // Keyboard movement (justDown to prevent holding)
    if (Phaser.Input.Keyboard.JustDown(this.cursors.left))  this.tryMove(-1, 0);
    if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) this.tryMove(1, 0);
    if (Phaser.Input.Keyboard.JustDown(this.cursors.up))    this.tryMove(0, -1);
    if (Phaser.Input.Keyboard.JustDown(this.cursors.down))  this.tryMove(0, 1);

    this.renderAll();
  }

  createUI() {
    const pad = 20;
    const x = pad;
    let y = pad;

    // Title
    this.add.text(x, y, 'Opticon v2', { fontSize: '32px', color: '#e9eef6' });
    y += 50;

    // Status labels
    this.turnLabel   = this.add.text(x, y, 'Turn: Prisoner',   { fontSize: '20px', color: '#fff' });
    y += 30;
    this.roleLabel   = this.add.text(x, y, 'View: Prisoner',   { fontSize: '20px', color: '#fff' });
    y += 30;
    this.facingLabel = this.add.text(x, y, 'Facing: North',    { fontSize: '20px', color: '#fff' });
    y += 30;
    this.mpLabel     = this.add.text(x, y, 'MP: 3',            { fontSize: '20px', color: '#fff' });
    y += 50;

    // Controls
    this.switchBtn = this.add.text(x, y, '[Tab] Switch View', { fontSize: '18px', color: '#aaa' })
      .setInteractive()
      .on('pointerdown', () => this.toggleView());
    y += 40;

    this.endBtn = this.add.text(x, y, '[Space] End Turn', { fontSize: '18px', color: '#aaa' })
      .setInteractive()
      .on('pointerdown', () => this.endTurn());
    y += 60;

    // Watcher controls (only visible when in Watcher view)
    this.rotLeftBtn = this.add.text(x, y, '[Q] Rotate Left', { fontSize: '18px', color: '#aaa' })
      .setInteractive()
      .on('pointerdown', () => this.rotateWatcher(-1));
    y += 30;
    this.rotRightBtn = this.add.text(x, y, '[E] Rotate Right', { fontSize: '18px', color: '#aaa' })
      .setInteractive()
      .on('pointerdown', () => this.rotateWatcher(1));
    y += 40;

    this.bluffLabels = [];
    for (let i = 0; i < 4; i++) {
      const btn = this.add.text(x + (i * 100), y, `[${i+1}] Bluff ${DIRS[i]}`, { fontSize: '18px', color: '#aaa' })
        .setInteractive()
        .on('pointerdown', () => this.setBluff(i));
      this.bluffLabels.push(btn);
    }
  }

  toggleView() {
    state.view = state.view === "Prisoner" ? "Watcher" : "Prisoner";
    updateUI(this);
    this.renderAll();
  }

  // ... (rest of methods: buildMap, createTextures, screenFromGrid, inWatcherFOV, getQuadrant, opposite,
  // isWalkable, computePrisonerFOV, tryMove, rotateWatcher, setBluff, endTurn, renderAll, resetGame, log)
  // will be added in the next message if you say "continue" or "next part"
}

// Helper functions (outside scene)

function buildMap() {
  // (full procedural generation code – tower, moat, rings, walls, obstacles)
  // Placeholder for now – full version in next part
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

  // Moat and rings (simplified placeholder)
  // ... full logic will be pasted in continuation
}

function createTextures(scene) {
  // Procedural textures for floor, wall, moat
  const sz = TILE_SIZE - 1;

  scene.textures.addCanvas('tex_floor', createCanvasTex(sz, sz, (ctx) => {
    ctx.fillStyle = '#171b28';
    ctx.fillRect(0, 0, sz, sz);
    // speckles...
  }));

  // similar for wall and moat...
}

function screenFromGrid(x, y) {
  return { sx: 100 + x * TILE_SIZE, sy: 50 + y * TILE_SIZE }; // offset for UI space
}

function updateUI(scene) {
  scene.turnLabel.setText(`Turn: ${state.turn}`);
  scene.roleLabel.setText(`View: ${state.view}`);
  scene.facingLabel.setText(`Facing: ${DIRS[state.watcher.facing]}`);
  scene.mpLabel.setText(`MP: ${state.prisoner.mp}`);
}

// Phaser game config
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
// Opticon v2 – Core Game Logic
// Zane – January 2026
// Phaser 3 – 31x31 grid, 5 rings, win conditions, obstacles, watcher limits

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

    this.turnLabel   = this.add.text(pad, y, '', { fontSize: '20