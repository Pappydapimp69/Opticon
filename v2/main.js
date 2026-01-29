// Opticon v3 – Modern UI + Controller Menu Navigation + Hold-to-End-Turn
// Zane – January 2026

const TILE_SIZE = 20;
const GRID = 31;
const HALF = Math.floor(GRID / 2);

const TILE = { FLOOR: 0, WALL: 1, MOAT: 2 };
const OBJ = { NONE: 0, GLASS: 1, DOOR: 2 };
const DIRS = ["North", "East", "South", "West"];

let gameConfig = {
  humans: null,
  humanRole: null,
  difficulty: null,
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
  endHoldTimer: 0,
  endHoldProgress: 0
};

class PlayerSelectScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PlayerSelect' });
  }

  create() {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    this.add.text(cx, cy - 140, 'Opticon', {
      fontSize: '52px', color: '#d0e0ff', stroke: '#000', strokeThickness: 8
    }).setOrigin(0.5);

    // Selection group
    this.buttons = [];
    this.selectedIndex = 0;

    const oneBtn = this.add.text(cx, cy - 10, '1 Player (vs AI)', {
      fontSize: '36px', color: '#fff', backgroundColor: '#1a2238',
      padding: { left: 40, right: 40, top: 20, bottom: 20 }
    }).setOrigin(0.5).setInteractive();
    this.buttons.push(oneBtn);

    const twoBtn = this.add.text(cx, cy + 80, '2 Players (Hotseat)', {
      fontSize: '36px', color: '#fff', backgroundColor: '#1a2238',
      padding: { left: 40, right: 40, top: 20, bottom: 20 }
    }).setOrigin(0.5).setInteractive();
    this.buttons.push(twoBtn);

    this.statusText = this.add.text(cx, cy + 180, 'Controllers: detecting...', {
      fontSize: '20px', color: '#a0b0c0'
    }).setOrigin(0.5);

    this.input.gamepad.on('connected', () => this.updateStatus());
    this.input.gamepad.on('disconnected', () => this.updateStatus());
    this.updateStatus();

    // Controller navigation
    this.input.gamepad.once('down', (pad) => {
      this.addLog("Controller detected – use D-pad / Left Stick to navigate, A to select");
    });

    this.updateSelectionHighlight();
  }

  update(time, delta) {
    const pad = this.input.gamepad.pad1;

    if (pad) {
      const ay = pad.axes.length > 1 ? pad.axes[1].getValue() : 0;

      // D-pad / stick up/down navigation
      if (Phaser.Input.Gamepad.JustDown(pad.up) || ay < -0.6) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.updateSelectionHighlight();
        this.playSound('menu_move');
      }
      if (Phaser.Input.Gamepad.JustDown(pad.down) || ay > 0.6) {
        this.selectedIndex = Math.min(this.buttons.length - 1, this.selectedIndex + 1);
        this.updateSelectionHighlight();
        this.playSound('menu_move');
      }

      // A to select
      if (Phaser.Input.Gamepad.JustDown(pad.A)) {
        this.buttons[this.selectedIndex].emit('pointerdown');
        this.playSound('menu_confirm');
      }
    }
  }

  updateSelectionHighlight() {
    this.buttons.forEach((btn, i) => {
      btn.setTint(i === this.selectedIndex ? 0xffff88 : 0xffffff);
      btn.setScale(i === this.selectedIndex ? 1.1 : 1.0);
    });
  }

  updateStatus() {
    const pads = this.input.gamepad.getAll();
    let msg = `Controllers: ${pads.length} detected`;
    if (pads.length >= 1) msg += ' – P1: Controller';
    if (pads.length >= 2) msg += ' – P2: Controller';
    if (pads.length === 0) msg += ' – Keyboard only';
    this.statusText.setText(msg);

    gameConfig.input.p1 = pads.length >= 1 ? 'controller' : 'keyboard';
    gameConfig.input.p2 = pads.length >= 2 ? 'controller' : 'keyboard';
  }

  playSound(type) {
    // Simple generated tones
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

  // ... (rest of PlayerSelectScene methods: showRoleAndDifficulty, showDifficulty, startGame – same as before)
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

    // Grid drawing (same as before)
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
    this.prisonerGlow = this.add.circle(0, 0, TILE_SIZE/2 + 4, 0x5ad4e6, 0.4)
      .setDepth(9).setBlendMode(Phaser.BlendModes.ADD);

    this.noiseLayer = this.add.graphics().setDepth(5);

    this.cursors = this.input.keyboard.createCursorKeys();

    // Keyboard
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
  }

  update(time, delta) {
    state.noiseMarkers = state.noiseMarkers.filter(m => (m.ttl -= delta / 1000) > 0);

    const pad = this.input.gamepad.pad1;

    if (state.turn === "Prisoner") {
      // Movement (keyboard + gamepad)
      if (Phaser.Input.Keyboard.JustDown(this.cursors.left))  this.tryMove(-1, 0);
      if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) this.tryMove(1, 0);
      if (Phaser.Input.Keyboard.JustDown(this.cursors.up))    this.tryMove(0, -1);
      if (Phaser.Input.Keyboard.JustDown(this.cursors.down))  this.tryMove(0, 1);

      if (pad) {
        const ax = pad.axes.length > 0 ? pad.axes[0].getValue() : 0;
        const ay = pad.axes.length > 1 ? pad.axes[1].getValue() : 0;
        if (Math.abs(ax) > 0.6 || Math.abs(ay) > 0.6) {
          if (ax < -0.6) this.tryMove(-1, 0);
          if (ax > 0.6) this.tryMove(1, 0);
          if (ay < -0.6) this.tryMove(0, -1);
          if (ay > 0.6) this.tryMove(0, 1);
        }
      }
    }

    if (state.turn === "Watcher" && pad) {
      if (Phaser.Input.Gamepad.JustDown(pad.Y)) this.setBluff(0);
      if (Phaser.Input.Gamepad.JustDown(pad.B)) this.setBluff(1);
      if (Phaser.Input.Gamepad.JustDown(pad.X)) this.setBluff(2);
      if (Phaser.Input.Gamepad.JustDown(pad.RB)) this.rotateWatcher(1);
      if (Phaser.Input.Gamepad.JustDown(pad.LB)) this.rotateWatcher(-1);
    }

    // Hold A to end turn
    if (pad && pad.A) {
      state.endHoldProgress += delta / 3000; // 3 seconds
      if (state.endHoldProgress >= 1) {
        this.endTurn();
        state.endHoldProgress = 0;
        this.playSound('turn_end');
      }
      this.updateEndHoldMeter();
    } else {
      state.endHoldProgress = 0;
      this.updateEndHoldMeter();
    }

    this.renderAll();
  }

  createModernUI() {
    // Top bar
    this.topBar = this.add.rectangle(0, 0, this.scale.width, 80, 0x1a2238, 0.9).setOrigin(0, 0);
    this.topBar.setScrollFactor(0);

    this.turnText = this.add.text(20, 20, '', { fontSize: '24px', color: '#e0f0ff' }).setScrollFactor(0);
    this.mpText = this.add.text(this.scale.width / 2 - 80, 20, '', { fontSize: '24px', color: '#88ff88' }).setScrollFactor(0);
    this.facingText = this.add.text(this.scale.width - 180, 20, '', { fontSize: '20px', color: '#b0c0ff' }).setScrollFactor(0);

    // Bottom bar
    this.bottomBar = this.add.rectangle(0, this.scale.height - 120, this.scale.width, 120, 0x1a2238, 0.9).setOrigin(0, 0);
    this.bottomBar.setScrollFactor(0);

    this.controlsText = this.add.text(20, this.scale.height - 100, '', { fontSize: '18px', color: '#a0b0c0', wordWrap: { width: this.scale.width - 40 } }).setScrollFactor(0);

    // End turn hold meter
    this.endMeterBG = this.add.rectangle(this.scale.width / 2, this.scale.height - 60, 300, 30, 0x333333).setScrollFactor(0);
    this.endMeterFill = this.add.rectangle(this.scale.width / 2 - 150, this.scale.height - 60, 0, 30, 0x00ff88).setOrigin(0, 0.5).setScrollFactor(0);

    this.updateUI();
  }

  updateEndHoldMeter() {
    const width = 300 * state.endHoldProgress;
    this.endMeterFill.width = width;
    this.endMeterFill.fillColor = state.endHoldProgress > 0.9 ? 0xff4444 : 0x00ff88;
  }

  updateUI() {
    this.turnText.setText(`Turn: ${state.turn}`);
    this.mpText.setText(`MP: ${state.prisoner.mp}`);
    this.facingText.setText(`Facing: ${DIRS[state.watcher.facing]}`);

    const isPrisonerTurn = state.turn === "Prisoner";
    this.controlsText.setText(isPrisonerTurn
      ? "Arrows / D-pad / Left Stick: Move (max 3)\nHold A / Space 3s: End Turn"
      : "Q / LB: Rotate Left    E / RB: Rotate Right\n1/Y: Bluff North    2/B: East    3/X: South\nHold A / Space 3s: End Turn"
    );

    this.updateEndHoldMeter();
  }

  // ... (keep tryMove, rotateWatcher, setBluff, endTurn, resetGame, addLog, renderAll, updateCameraFollow, helpers from previous)

  playSound(type) {
    const osc = this.sound.context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = type === 'turn_end' ? 300 : 800;
    const gain = this.sound.context.createGain();
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(this.sound.context.destination);
    osc.start();
    osc.stop(this.sound.context.currentTime + 0.12);
  }
}

// Helper functions (unchanged – buildMap, createTextures, screenFromGrid, etc.)
// Paste them here from your previous working version

// Launch
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