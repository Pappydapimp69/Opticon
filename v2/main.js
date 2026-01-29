// Opticon v3 – Horizontal Split Player Select + Instant Audio + Controller Navigation
// Zane – January 2026

const TILE_SIZE = 20;
const GRID = 31;
const HALF = Math.floor(GRID / 2);

// Tile types
const TILE = { FLOOR: 0, WALL: 1, MOAT: 2 };
const OBJ = { NONE: 0, GLASS: 1, DOOR: 2 };
const DIRS = ["North", "East", "South", "West"];

let gameConfig = {
  humans: null,
  humanRole: null,
  difficulty: 'medium',
  input: { p1: 'keyboard', p2: 'keyboard' }
};

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
  moatThickness: 3,
  endHoldProgress: 0
};

class PlayerSelectScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PlayerSelect' });
  }

  create() {
    const w = this.scale.width;
    const h = this.scale.height;
    const cx = w / 2;
    const cy = h / 2;

    this.add.rectangle(0, 0, w, h, 0x0a0c12).setOrigin(0);

    // Split line
    this.add.line(cx, 0, 0, 0, 0, h, 0x334466, 0.5).setOrigin(0);

    // Left: Prisoner side
    this.add.rectangle(0, 0, cx, h, 0x112244, 0.7).setOrigin(0);
    this.add.text(cx / 2, cy - 100, 'PRISONER', {
      fontSize: '52px', color: '#88ccff', stroke: '#000', strokeThickness: 10
    }).setOrigin(0.5);
    const prisonerArea = this.add.rectangle(cx / 2, cy, cx - 40, h - 100, 0x224466, 0)
      .setOrigin(0.5)
      .setInteractive();

    this.add.text(cx / 2, cy + 20, 'Human as Prisoner\n(AI controls Watcher)', {
      fontSize: '28px', color: '#d0e0ff', align: 'center'
    }).setOrigin(0.5);

    // Right: Watcher side
    this.add.rectangle(cx, 0, cx, h, 0x220011, 0.7).setOrigin(0);
    this.add.text(cx + cx / 2, cy - 100, 'WATCHER', {
      fontSize: '52px', color: '#ff8888', stroke: '#000', strokeThickness: 10
    }).setOrigin(0.5);
    const watcherArea = this.add.rectangle(cx + cx / 2, cy, cx - 40, h - 100, 0x441122, 0)
      .setOrigin(0.5)
      .setInteractive();

    this.add.text(cx + cx / 2, cy + 20, 'Human as Watcher\n(AI controls Prisoner)', {
      fontSize: '28px', color: '#ffd0d0', align: 'center'
    }).setOrigin(0.5);

    // 2-player button (bottom center)
    const twoArea = this.add.rectangle(cx, h - 100, 400, 120, 0x1a2238, 0.9)
      .setOrigin(0.5)
      .setInteractive();
    this.add.text(cx, h - 100, '2 Players (Hotseat)', {
      fontSize: '32px', color: '#e0e0ff'
    }).setOrigin(0.5);

    // Status
    this.statusText = this.add.text(cx, h - 200, 'Detecting controllers...', {
      fontSize: '22px', color: '#a0b0c0'
    }).setOrigin(0.5);

    // Controller navigation
    prisonerArea.on('pointerdown', () => {
      gameConfig.humans = 1;
      gameConfig.humanRole = 'Prisoner';
      this.startGame();
    });

    watcherArea.on('pointerdown', () => {
      gameConfig.humans = 1;
      gameConfig.humanRole = 'Watcher';
      this.startGame();
    });

    twoArea.on('pointerdown', () => {
      gameConfig.humans = 2;
      this.startGame();
    });

    // Instant audio
    this.playIntroMusic();

    // Gamepad detection on start
    this.input.gamepad.on('connected', () => this.updateStatus());
    this.input.gamepad.on('disconnected', () => this.updateStatus());
    this.updateStatus();
  }

  update(time, delta) {
    const pad = this.input.gamepad.pad1;
    if (pad) {
      const ay = pad.axes.length > 1 ? pad.axes[1].getValue() : 0;

      if (ay < -0.6) {
        // Highlight left (Prisoner)
        this.playSound('menu_move');
      }
      if (ay > 0.6) {
        // Highlight right (Watcher)
        this.playSound('menu_move');
      }

      if (Phaser.Input.Gamepad.JustDown(pad.A)) {
        this.playSound('menu_confirm');
        // Simulate click on selected side (simple: assume last highlighted or center)
        if (Math.random() > 0.5) {
          gameConfig.humans = 1;
          gameConfig.humanRole = 'Prisoner';
        } else {
          gameConfig.humans = 1;
          gameConfig.humanRole = 'Watcher';
        }
        this.startGame();
      }
    }
  }

  updateStatus() {
    const pads = this.input.gamepad.getAll();
    let msg = `Controllers: ${pads.length} detected`;
    if (pads.length >= 1) msg += ' – P1: Controller';
    if (pads.length >= 2) msg += ' – P2: Controller';
    if (pads.length === 0) msg += ' – Keyboard only';
    this.statusText.setText(msg);
  }

  playIntroMusic() {
    const osc = this.sound.context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(60, this.sound.context.currentTime);
    osc.frequency.linearRampToValueAtTime(35, this.sound.context.currentTime + 12);
    const gain = this.sound.context.createGain();
    gain.gain.setValueAtTime(0.08, this.sound.context.currentTime);
    gain.gain.linearRampToValueAtTime(0.02, this.sound.context.currentTime + 12);
    osc.connect(gain);
    gain.connect(this.sound.context.destination);
    osc.start();
    osc.stop(this.sound.context.currentTime + 15);
  }

  playSound(type) {
    const osc = this.sound.context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = type === 'menu_move' ? 600 : 900;
    const gain = this.sound.context.createGain();
    gain.gain.value = 0.1;
    osc.connect(gain);
    gain.connect(this.sound.context.destination);
    osc.start();
    osc.stop(this.sound.context.currentTime + 0.08);
  }

  startGame() {
    this.scene.start('MainGame');
  }
}

class MainGameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainGame' });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a0c12');
    this.cameras.main.setBounds(0, 0, GRID * TILE_SIZE + 200, GRID * TILE_SIZE + 200);

    buildMap();
    state.prisoner.startTurnPos = { x: state.prisoner.x, y: state.prisoner.y };

    createTextures(this);

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

    this.prisonerMarker = this.add.circle(0, 0, TILE_SIZE/2 - 2, 0x5ad4e6).setDepth(10);
    this.prisonerGlow = this.add.circle(0, 0, TILE_SIZE/2 + 4, 0x5ad4e6, 0.4).setDepth(9).setBlendMode(Phaser.BlendModes.ADD);

    this.noiseLayer = this.add.graphics().setDepth(5);

    this.cursors = this.input.keyboard.createCursorKeys();

    this.input.keyboard.on('keydown-TAB', () => this.toggleView());
    this.input.keyboard.on('keydown-Q', () => this.rotateWatcher(-1));
    this.input.keyboard.on('keydown-E', () => this.rotateWatcher(1));
    this.input.keyboard.on('keydown-ONE', () => this.setBluff(0));
    this.input.keyboard.on('keydown-TWO', () => this.setBluff(1));
    this.input.keyboard.on('keydown-THREE', () => this.setBluff(2));
    this.input.keyboard.on('keydown-FOUR', () => this.setBluff(3));

    this.createModernUI();

    updateUI(this);
    this.renderAll();
    this.updateCameraFollow();

    this.playSound('turn_start');
  }

  createModernUI() {
    // Top bar
    this.topBar = this.add.rectangle(0, 0, this.scale.width, 80, 0x1a2238, 0.92).setOrigin(0, 0).setScrollFactor(0);

    this.turnText = this.add.text(20, 20, '', { fontSize: '26px', color: '#e0f0ff' }).setScrollFactor(0);
    this.mpText = this.add.text(this.scale.width / 2 - 80, 20, '', { fontSize: '26px', color: '#88ff88' }).setScrollFactor(0);
    this.facingText = this.add.text(this.scale.width - 220, 20, '', { fontSize: '22px', color: '#b0c0ff' }).setScrollFactor(0);

    // Bottom bar
    this.bottomBar = this.add.rectangle(0, this.scale.height - 140, this.scale.width, 140, 0x1a2238, 0.92).setOrigin(0, 0).setScrollFactor(0);

    this.controlsText = this.add.text(20, this.scale.height - 120, '', {
      fontSize: '18px', color: '#a0b0c0', wordWrap: { width: this.scale.width - 40 }
    }).setScrollFactor(0);

    // End turn hold meter
    this.endMeterBG = this.add.rectangle(this.scale.width / 2, this.scale.height - 60, 340, 40, 0x333333).setScrollFactor(0);
    this.endMeterFill = this.add.rectangle(this.scale.width / 2 - 170, this.scale.height - 60, 0, 40, 0x00ff88).setOrigin(0, 0.5).setScrollFactor(0);
    this.endMeterText = this.add.text(this.scale.width / 2, this.scale.height - 60, 'Hold A / Space to End Turn', {
      fontSize: '18px', color: '#ffffff'
    }).setOrigin(0.5).setScrollFactor(0);
  }

  update(time, delta) {
    // ... (noise decay, movement, watcher gamepad – same as before)

    const pad = this.input.gamepad.pad1;

    // Hold A / Space to end turn
    const isHolding = (pad && pad.A) || this.input.keyboard.addKey('SPACE').isDown;
    if (isHolding) {
      state.endHoldProgress += delta / 3000;
      if (state.endHoldProgress >= 1) {
        this.endTurn();
        state.endHoldProgress = 0;
        this.playSound('turn_end');
      }
    } else {
      state.endHoldProgress = 0;
    }

    const width = 340 * state.endHoldProgress;
    this.endMeterFill.width = width;
    this.endMeterFill.fillColor = state.endHoldProgress > 0.8 ? 0xff4444 : 0x00ff88;

    this.renderAll();
  }

  playSound(type) {
    const osc = this.sound.context.createOscillator();
    osc.type = type === 'turn_start' ? 'sine' : 'sawtooth';
    osc.frequency.value = type === 'turn_start' ? 180 : type === 'turn_end' ? 120 : 700;
    const gain = this.sound.context.createGain();
    gain.gain.value = type === 'turn_start' ? 0.15 : 0.12;
    osc.connect(gain);
    gain.connect(this.sound.context.destination);
    osc.start();
    osc.stop(this.sound.context.currentTime + (type === 'turn_start' ? 1.2 : 0.18));
  }

  // ... (keep tryMove, rotateWatcher, setBluff, endTurn, resetGame, addLog, renderAll, updateCameraFollow, updateUI, helpers from your working version)
}

// Helper functions (buildMap, createTextures, screenFromGrid, inBounds, isWalkable, inWatcherFOV, getQuadrant, opposite, getRing, hasNoiseAt, addNoise, computePrisonerFOV, clamp, updateUI)

const config = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  parent: 'game',
  scene: [PlayerSelectScene, MainGameScene],
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
  backgroundColor: '#0a0c12',
  input: { gamepad: true }
};

game = new Phaser.Game(config);