// main.js - Fixed: Native gamepad polling + horizontal split select + instant audio
// No Phaser gamepad wrapper, direct navigator.getGamepads() detection

const TILE_SIZE = 20;
const GRID = 31;
const HALF = Math.floor(GRID / 2);

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
    this.add.line(cx, 0, 0, 0, 0, h, 0x334466, 0.5).setOrigin(0);

    // Prisoner left
    this.add.rectangle(0, 0, cx, h, 0x112244, 0.7).setOrigin(0);
    this.add.text(cx / 2, cy - 100, 'PRISONER', { fontSize: '52px', color: '#88ccff', stroke: '#000', strokeThickness: 10 }).setOrigin(0.5);
    const prisonerArea = this.add.rectangle(cx / 2, cy, cx - 40, h - 100, 0x224466, 0).setOrigin(0.5).setInteractive();
    this.add.text(cx / 2, cy + 20, 'Human as Prisoner\n(AI Watcher)', { fontSize: '28px', color: '#d0e0ff', align: 'center' }).setOrigin(0.5);

    // Watcher right
    this.add.rectangle(cx, 0, cx, h, 0x220011, 0.7).setOrigin(0);
    this.add.text(cx + cx / 2, cy - 100, 'WATCHER', { fontSize: '52px', color: '#ff8888', stroke: '#000', strokeThickness: 10 }).setOrigin(0.5);
    const watcherArea = this.add.rectangle(cx + cx / 2, cy, cx - 40, h - 100, 0x441122, 0).setOrigin(0.5).setInteractive();
    this.add.text(cx + cx / 2, cy + 20, 'Human as Watcher\n(AI Prisoner)', { fontSize: '28px', color: '#ffd0d0', align: 'center' }).setOrigin(0.5);

    // 2-player bottom
    const twoArea = this.add.rectangle(cx, h - 100, 400, 120, 0x1a2238, 0.9).setOrigin(0.5).setInteractive();
    this.add.text(cx, h - 100, '2 Players (Hotseat)', { fontSize: '32px', color: '#e0e0ff' }).setOrigin(0.5);

    // Status
    this.statusText = this.add.text(cx, h - 200, 'Detecting controllers...', { fontSize: '22px', color: '#a0b0c0' }).setOrigin(0.5);

    // Poll gamepads immediately and every 100ms
    this.updateGamepadStatus();
    this.time.addEvent({ delay: 100, callback: this.updateGamepadStatus, callbackScope: this, loop: true });

    // Instant audio
    this.playIntroMusic();

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
  }

  updateGamepadStatus() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let count = 0;
    for (let pad of pads) if (pad) count++;

    let msg = `Controllers: ${count} detected`;
    if (count >= 1) msg += ' – P1 ready';
    if (count >= 2) msg += ' – P2 ready';
    if (count === 0) msg += ' – Keyboard only';
    this.statusText.setText(msg);

    gameConfig.input.p1 = count >= 1 ? 'controller' : 'keyboard';
    gameConfig.input.p2 = count >= 2 ? 'controller' : 'keyboard';
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

  update(time, delta) {
    state.noiseMarkers = state.noiseMarkers.filter(m => (m.ttl -= delta / 1000) > 0);

    // Raw native gamepad polling - P1 = first pad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads[0];

    if (state.turn === "Prisoner" && pad) {
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;

      if (Math.abs(ax) > 0.6 || Math.abs(ay) > 0.6) {
        if (ax < -0.6) this.tryMove(-1, 0);
        if (ax > 0.6) this.tryMove(1, 0);
        if (ay < -0.6) this.tryMove(0, -1);
        if (ay > 0.6) this.tryMove(0, 1);
      }
    }

    if (state.turn === "Watcher" && pad) {
      if (pad.buttons[0].pressed) this.endTurn();     // A
      if (pad.buttons[3].pressed) this.setBluff(0);   // Y North
      if (pad.buttons[1].pressed) this.setBluff(1);   // B East
      if (pad.buttons[2].pressed) this.setBluff(2);   // X South
      if (pad.buttons[5].pressed) this.rotateWatcher(1); // RB right
      if (pad.buttons[4].pressed) this.rotateWatcher(-1); // LB left
    }

    // Hold A or Space to end turn
    const isHolding = (pad && pad.buttons[0].pressed) || this.input.keyboard.addKey('SPACE').isDown;
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

    this.renderAll();
  }

  createModernUI() {
    this.topBar = this.add.rectangle(0, 0, this.scale.width, 80, 0x1a2238, 0.92).setOrigin(0, 0).setScrollFactor(0);

    this.turnText = this.add.text(20, 20, '', { fontSize: '26px', color: '#e0f0ff' }).setScrollFactor(0);
    this.mpText = this.add.text(this.scale.width / 2 - 80, 20, '', { fontSize: '26px', color: '#88ff88' }).setScrollFactor(0);
    this.facingText = this.add.text(this.scale.width - 220, 20, '', { fontSize: '22px', color: '#b0c0ff' }).setScrollFactor(0);

    this.bottomBar = this.add.rectangle(0, this.scale.height - 140, this.scale.width, 140, 0x1a2238, 0.92).setOrigin(0, 0).setScrollFactor(0);

    this.controlsText = this.add.text(20, this.scale.height - 120, '', {
      fontSize: '18px', color: '#a0b0c0', wordWrap: { width: this.scale.width - 40 }
    }).setScrollFactor(0);

    this.endMeterBG = this.add.rectangle(this.scale.width / 2, this.scale.height - 60, 340, 40, 0x333333).setScrollFactor(0);
    this.endMeterFill = this.add.rectangle(this.scale.width / 2 - 170, this.scale.height - 60, 0, 40, 0x00ff88).setOrigin(0, 0.5).setScrollFactor(0);
    this.endMeterText = this.add.text(this.scale.width / 2, this.scale.height - 60, 'Hold A / Space to End Turn', {
      fontSize: '18px', color: '#ffffff'
    }).setOrigin(0.5).setScrollFactor(0);
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

    const width = 340 * state.endHoldProgress;
    this.endMeterFill.width = width;
    this.endMeterFill.fillColor = state.endHoldProgress > 0.8 ? 0xff4444 : 0x00ff88;
  }

  playSound(type) {
    const osc = this.sound.context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = type === 'turn_start' ? 180 : type === 'turn_end' ? 120 : 700;
    const gain = this.sound.context.createGain();
    gain.gain.value = type === 'turn_start' ? 0.15 : 0.12;
    osc.connect(gain);
    gain.connect(this.sound.context.destination);
    osc.start();
    osc.stop(this.sound.context.currentTime + (type === 'turn_start' ? 1.2 : 0.18));
  }

  // ... (keep tryMove, rotateWatcher, setBluff, endTurn, resetGame, addLog, renderAll, updateCameraFollow, helpers)
}

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