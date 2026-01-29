// Opticon v2 – Improved UI, Camera Follow, FOV-limited view
// Zane – January 2026

const TILE_SIZE = 20;
const GRID = 31;
const HALF = Math.floor(GRID / 2);

const TILE = { FLOOR: 0, WALL: 1, MOAT: 2 };
const OBJ = { NONE: 0, GLASS: 1, DOOR: 2 };
const DIRS = ["North", "East", "South", "West"];

const state = {
  map: [], objects: [], ringIndex: [],
  tiles: [],
  prisoner: { x: HALF + 4, y: HALF + 6, mp: 3, startTurnPos: null },
  watcher: { facing: 0, bluffDir: null, hasRotated: false },
  turn: "Prisoner",
  view: "Prisoner",
  noiseMarkers: [],
  ringCount: 5,
  ringThickness: 4,
  moatThickness: 3
};

let game;

class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a0c12');
    this.cameras.main.setBounds(0, 0, GRID * TILE_SIZE, GRID * TILE_SIZE);

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

    // Prisoner marker with glow
    this.prisonerMarker = this.add.circle(0, 0, TILE_SIZE/2 - 2, 0x5ad4e6).setDepth(10);
    this.prisonerGlow = this.add.circle(0, 0, TILE_SIZE/2 + 4, 0x5ad4e6, 0.4)
      .setDepth(9).setBlendMode(Phaser.BlendModes.ADD);

    // Noise overlay
    this.noiseLayer = this.add.graphics().setDepth(5);

    // Input
    this.cursors = this.input.keyboard.createCursorKeys();

    // Keyboard
    this.input.keyboard.on('keydown-TAB', () => this.toggleView());
    this.input.keyboard.on('keydown-SPACE', () => this.endTurn());
    this.input.keyboard.on('keydown-Q', () => this.rotateWatcher(-1));
    this.input.keyboard.on('keydown-E', () => this.rotateWatcher(1));
    this.input.keyboard.on('keydown-ONE', () => this.setBluff(0));
    this.input.keyboard.on('keydown-TWO', () => this.setBluff(1));
    this.input.keyboard.on('keydown-THREE', () => this.setBluff(2));
    this.input.keyboard.on('keydown-FOUR', () => this.setBluff(3));

    // Gamepad connect message
    this.input.gamepad.once('connected', () => {
      this.addLog("Controller connected", true);
    });

    this.createUI();

    updateUI(this);
    this.renderAll();
    this.updateCameraFollow();
  }

  update(time, delta) {
    state.noiseMarkers = state.noiseMarkers.filter(m => (m.ttl -= delta / 1000) > 0);

    const pad = this.input.gamepad.pad1;

    if (state.turn === "Prisoner") {
      // Keyboard move
      if (Phaser.Input.Keyboard.JustDown(this.cursors.left))  this.tryMove(-1, 0);
      if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) this.tryMove(1, 0);
      if (Phaser.Input.Keyboard.JustDown(this.cursors.up))    this.tryMove(0, -1);
      if (Phaser.Input.Keyboard.JustDown(this.cursors.down))  this.tryMove(0, 1);

      // Gamepad move (D-pad / left stick)
      if (pad) {
        const ax = pad.axes.length > 0 ? pad.axes[0].getValue() : 0;
        const ay = pad.axes.length > 1 ? pad.axes[1].getValue() : 0;
        if (Math.abs(ax) > 0.6) this.tryMove(ax > 0 ? 1 : -1, 0);
        if (Math.abs(ay) > 0.6) this.tryMove(0, ay > 0 ? 1 : -1);
      }
    }

    if (state.turn === "Watcher" && pad) {
      if (pad.A) this.endTurn();
      if (pad.B) this.setBluff(1);
      if (pad.X) this.setBluff(2);
      if (pad.Y) this.setBluff(0);
      if (pad.RB) this.rotateWatcher(1);
      if (pad.LB) this.rotateWatcher(-1);
    }

    this.renderAll();
  }

  createUI() {
    const x = 16;
    let y = 16;

    this.add.text(x, y, 'Opticon v2', { fontSize: '32px', color: '#d0e0ff', stroke: '#000', strokeThickness: 6 });
    y += 50;

    this.turnLabel   = this.add.text(x, y, '', { fontSize: '22px', color: '#e0f0ff' });
    y += 32;
    this.roleLabel   = this.add.text(x, y, '', { fontSize: '22px', color: '#e0f0ff' });
    y += 32;
    this.facingLabel = this.add.text(x, y, '', { fontSize: '20px', color: '#b0c0ff' });
    y += 32;
    this.mpLabel     = this.add.text(x, y, '', { fontSize: '20px', color: '#b0c0ff' });
    y += 60;

    // Controls help – shown always, but contextual
    this.controlsText = this.add.text(x, y, '', { fontSize: '16px', color: '#a0b0c0', wordWrap: { width: 340 } });
    this.updateControlsText();
  }

  updateControlsText() {
    const isPrisonerTurn = state.turn === "Prisoner";
    const text = isPrisonerTurn
      ? "Arrows / D-pad: Move (max 3)\nSpace / A: End Turn"
      : "Q / LB: Rotate Left\nE / RB: Rotate Right\n1/Y: Bluff North\n2/B: East\n3/X: South\n4/A: West\nSpace / A: End Turn";
    this.controlsText.setText(text);
  }

  toggleView() {
    state.view = state.view === "Prisoner" ? "Watcher" : "Prisoner";
    updateUI(this);
    this.renderAll();
    this.updateCameraFollow();
  }

  updateCameraFollow() {
    const target = state.turn === "Prisoner"
      ? { x: state.prisoner.x * TILE_SIZE + TILE_SIZE / 2 + 100, y: state.prisoner.y * TILE_SIZE + TILE_SIZE / 2 + 80 }
      : { x: HALF * TILE_SIZE + TILE_SIZE / 2 + 100, y: HALF * TILE_SIZE + TILE_SIZE / 2 + 80 };

    this.cameras.main.startFollow(target, true, 0.12, 0.12);
  }

  // Keep your existing tryMove, rotateWatcher, setBluff, endTurn, resetGame, addLog, renderAll, helpers

  renderAll() {
    const isPrisonerView = state.view === "Prisoner";

    // Reset
    state.tiles.flat().forEach(t => {
      t.setAlpha(1);
      t.clearTint();
    });

    if (isPrisonerView) {
      const vis = computePrisonerFOV();
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          state.tiles[y][x].setAlpha(vis[y][x] ? 1 : 0.08);
        }
      }
    }

    // Gaze / bluff tint (only on visible tiles in prisoner view)
    const realTint = isPrisonerView ? 0x555577 : 0x88ff88;
    const bluffTint = isPrisonerView ? 0x555577 : 0x444422;

    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (isPrisonerView && state.tiles[y][x].alpha < 0.2) continue;

        if (inWatcherFOV(state.watcher.facing, x, y)) {
          state.tiles[y][x].setTint(realTint);
        } else if (state.watcher.bluffDir !== null && inWatcherFOV(state.watcher.bluffDir, x, y)) {
          state.tiles[y][x].setTint(bluffTint);
        }
      }
    }

    // Prisoner marker & glow
    const { sx, sy } = screenFromGrid(state.prisoner.x, state.prisoner.y);
    this.prisonerMarker.setPosition(sx + TILE_SIZE/2, sy + TILE_SIZE/2)
      .setVisible(state.view === "Prisoner");
    this.prisonerGlow.setPosition(sx + TILE_SIZE/2, sy + TILE_SIZE/2)
      .setVisible(state.view === "Prisoner");

    // Noise in watcher view
    this.noiseLayer.clear();
    if (state.view === "Watcher") {
      state.noiseMarkers.forEach(m => {
        if (m.ttl > 0) {
          const { sx, sy } = screenFromGrid(m.x, m.y);
          this.noiseLayer.fillStyle(0xff4444, clamp(m.ttl / 4, 0, 1));
          this.noiseLayer.fillCircle(sx + TILE_SIZE/2, sy + TILE_SIZE/2, TILE_SIZE * 0.7);
        }
      });
    }
  }
}

// Keep all your helper functions here (buildMap, createTextures, screenFromGrid, etc.)

// Launch
const config = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  parent: 'game',
  scene: [MainScene],
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
  backgroundColor: '#0a0c12',
  input: { gamepad: true }
};

game = new Phaser.Game(config);