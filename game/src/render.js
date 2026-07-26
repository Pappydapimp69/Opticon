// render.js — Three.js 3D presentation of the Opticon world.
// Builds the panopticon (tower, moat, rings, walls, props) once, then updates
// dynamic bits (prisoner avatar, gaze wedge, noise pings, lighting, FoV) each frame.

import * as THREE from "../lib/three.module.js";
import { TILE, OBJ, DIR_VEC } from "./map.js";
import { computeFoV, inWatcherGaze, isLit, VIS } from "./rules.js";

const COLORS = {
  bg: 0x05070d,
  fog: 0x05070d,
  floorA: 0x1b2233,
  floorB: 0x141a29,
  wall: 0x2b3450,
  wallTop: 0x445070,
  moat: 0x090d18,
  tower: 0x2a2f45,
  towerEye: 0xff4d5e,
  prisoner: 0x5ad4e6,
  exit: 0x59f7a6,
  door: 0xb9793f,
  doorOpen: 0x5a3a22,
  glass: 0x7fc8ff,
  lampOn: 0xffd98a,
  lampOff: 0x40465a,
  gaze: 0x4a8ef7,
  bluff: 0xf7c14a,
  noise: 0xff5757,
  pathPreview: 0xf5e6a8,
  captureFlash: 0xffffff,
};

// World scale: one grid tile == TILE_W world units.
const TILE_W = 1;
const WALL_H = 1.1;
const FLOOR_H = 0.12;

// Frame-rate-independent smoothing factor (Brain dog#E10: a fixed per-frame
// fraction converges ~2x faster at 60fps than 30fps and jerks on frame
// spikes). `tau` is a time constant in seconds — larger = slower to catch up.
function smoothing(dt, tau) {
  return 1 - Math.exp(-dt / tau);
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);
    this.scene.fog = new THREE.Fog(COLORS.fog, 14, 42);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
    this.camera.position.set(0, 22, 20);
    this.camera.lookAt(0, 0, 0);

    // Camera rig state (smoothed).
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camPos = new THREE.Vector3(0, 22, 20);
    this.viewMode = "prisoner"; // "prisoner" | "watcher" | "overview"
    this.orbit = { az: 0.6, el: 0.9, dist: 16 };

    // Lighting.
    const amb = new THREE.AmbientLight(0x33406a, 0.7);
    this.scene.add(amb);
    const key = new THREE.DirectionalLight(0x9fb4ff, 0.5);
    key.position.set(6, 18, 8);
    this.scene.add(key);
    this.ambient = amb;

    this.groups = {};
    this.dynamicLights = [];
    this.time = 0;

    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Convert grid coords → world position (centered on tower).
  worldX(gx) {
    return (gx - this.center.x) * TILE_W;
  }
  worldZ(gy) {
    return (gy - this.center.y) * TILE_W;
  }

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this.renderer.dispose();
  }

  // Build the static world from a map. Call once per new game.
  buildWorld(game) {
    // clear previous
    for (const k of Object.keys(this.groups)) {
      this.scene.remove(this.groups[k]);
    }
    for (const l of this.dynamicLights) this.scene.remove(l.light);
    this.dynamicLights = [];
    this.groups = {};

    const map = game.map;
    this.center = map.center;
    const size = map.size;

    // --- Count tile categories for instancing.
    const floors = [];
    const walls = [];
    let moatCount = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = map.tiles[y][x];
        if (t === TILE.FLOOR) floors.push({ x, y });
        // A window tile gets its own translucent pane prop below, not the
        // solid wall block — the two would otherwise overlap at the same cell.
        else if (t === TILE.WALL && map.objects[y][x] !== OBJ.GLASS) walls.push({ x, y });
        else if (t === TILE.MOAT) moatCount++;
      }
    }
    // Walls includes the outer border (TILE.WALL). Also gather TOWER separately.

    // --- Floor instanced mesh (colored by ring parity).
    const floorGeo = new THREE.BoxGeometry(TILE_W * 0.98, FLOOR_H, TILE_W * 0.98);
    const floorMat = new THREE.MeshLambertMaterial({ vertexColors: false });
    floorMat.color = new THREE.Color(0xffffff);
    const floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, floors.length);
    floorMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(floors.length * 3),
      3
    );
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    this.floorIndex = new Map(); // "x,y" -> instance id
    floors.forEach((f, i) => {
      m4.makeTranslation(this.worldX(f.x), -FLOOR_H / 2, this.worldZ(f.y));
      floorMesh.setMatrixAt(i, m4);
      const ring = map.ring[f.y][f.x];
      col.setHex(ring % 2 === 1 ? COLORS.floorA : COLORS.floorB);
      floorMesh.setColorAt(i, col);
      this.floorIndex.set(`${f.x},${f.y}`, i);
    });
    floorMesh.instanceMatrix.needsUpdate = true;
    if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
    this.floorMesh = floorMesh;
    this.floorBaseColors = floors.map((f) =>
      map.ring[f.y][f.x] % 2 === 1 ? COLORS.floorA : COLORS.floorB
    );
    this.floors = floors;
    this.groups.floor = floorMesh;
    this.scene.add(floorMesh);

    // --- Wall instanced mesh.
    const wallGeo = new THREE.BoxGeometry(TILE_W, WALL_H, TILE_W);
    const wallMat = new THREE.MeshLambertMaterial({ color: COLORS.wall });
    const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, walls.length);
    walls.forEach((w, i) => {
      m4.makeTranslation(this.worldX(w.x), WALL_H / 2, this.worldZ(w.y));
      wallMesh.setMatrixAt(i, m4);
    });
    wallMesh.instanceMatrix.needsUpdate = true;
    this.groups.wall = wallMesh;
    this.scene.add(wallMesh);

    // --- Moat: a single dark recessed ring plane approximated by boxes band.
    const moatGeo = new THREE.BoxGeometry(TILE_W, 0.05, TILE_W);
    const moatMat = new THREE.MeshBasicMaterial({ color: COLORS.moat });
    const moatMesh = new THREE.InstancedMesh(moatGeo, moatMat, moatCount);
    let mi = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (map.tiles[y][x] === TILE.MOAT) {
          m4.makeTranslation(this.worldX(x), -0.25, this.worldZ(y));
          moatMesh.setMatrixAt(mi++, m4);
        }
      }
    }
    moatMesh.instanceMatrix.needsUpdate = true;
    this.groups.moat = moatMesh;
    this.scene.add(moatMesh);

    // --- Tower: central pillar with an "eye" that shows facing.
    const towerGroup = new THREE.Group();
    const towerR = (map.cfg.towerRadius + 0.5) * TILE_W;
    const towerGeo = new THREE.CylinderGeometry(towerR, towerR * 1.05, WALL_H * 3.4, 10);
    const towerMat = new THREE.MeshLambertMaterial({ color: COLORS.tower });
    const towerMesh = new THREE.Mesh(towerGeo, towerMat);
    towerMesh.position.set(this.worldX(this.center.x), WALL_H * 1.7, this.worldZ(this.center.y));
    towerGroup.add(towerMesh);

    // Eye beacon (rotates to facing).
    const eyeGeo = new THREE.SphereGeometry(towerR * 0.5, 16, 12);
    const eyeMat = new THREE.MeshBasicMaterial({ color: COLORS.towerEye });
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0, WALL_H * 3.4, 0);
    towerMesh.add(eye);
    this.eye = eye;
    const eyeLight = new THREE.PointLight(COLORS.towerEye, 1.2, 18, 2);
    eyeLight.position.copy(eye.position);
    towerMesh.add(eyeLight);
    this.eyeLight = eyeLight;

    this.towerMesh = towerMesh;
    this.groups.tower = towerGroup;
    this.scene.add(towerGroup);

    // --- Props (doors, windows, switches, lamps, exit) as small meshes.
    this.props = { doors: new Map(), windows: new Map(), switches: [], lamps: new Map(), exit: null };
    const propGroup = new THREE.Group();

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = map.objects[y][x];
        const t = map.tiles[y][x];
        const wx = this.worldX(x);
        const wz = this.worldZ(y);
        if (o === OBJ.DOOR) {
          const d = new THREE.Mesh(
            new THREE.BoxGeometry(TILE_W * 0.9, WALL_H * 0.9, TILE_W * 0.28),
            new THREE.MeshLambertMaterial({ color: COLORS.door })
          );
          d.position.set(wx, WALL_H * 0.45, wz);
          propGroup.add(d);
          this.props.doors.set(`${x},${y}`, d);
        } else if (o === OBJ.GLASS && t === TILE.WALL) {
          // A translucent pane filling the wall gap — hidden once broken
          // (see update()'s windows loop), revealing the passage underneath.
          const wmesh = new THREE.Mesh(
            new THREE.BoxGeometry(TILE_W * 0.92, WALL_H * 0.92, TILE_W * 0.14),
            new THREE.MeshPhysicalMaterial({
              color: COLORS.glass, transparent: true, opacity: 0.5,
              roughness: 0.1, metalness: 0, side: THREE.DoubleSide,
            })
          );
          wmesh.position.set(wx, WALL_H * 0.46, wz);
          propGroup.add(wmesh);
          this.props.windows.set(`${x},${y}`, wmesh);
        } else if (o === OBJ.SWITCH) {
          const s = new THREE.Mesh(
            new THREE.BoxGeometry(0.22, 0.5, 0.22),
            new THREE.MeshLambertMaterial({ color: 0x8899bb })
          );
          s.position.set(wx, 0.25, wz);
          propGroup.add(s);
          this.props.switches.push({ x, y, mesh: s, group: map.lightGroup[y][x] });
        } else if (o === OBJ.LIGHT) {
          const lampMesh = new THREE.Mesh(
            new THREE.CylinderGeometry(0.16, 0.22, WALL_H * 1.3, 8),
            new THREE.MeshBasicMaterial({ color: COLORS.lampOn })
          );
          lampMesh.position.set(wx, WALL_H * 0.65, wz);
          propGroup.add(lampMesh);
          const group = map.lightGroup[y][x];
          const pl = new THREE.PointLight(COLORS.lampOn, 1.0, 6 * TILE_W, 2);
          pl.position.set(wx, WALL_H * 1.1, wz);
          propGroup.add(pl);
          this.dynamicLights.push({ group, light: pl, mesh: lampMesh });
          this.props.lamps.set(`${x},${y}`, { mesh: lampMesh, light: pl, group });
        } else if (o === OBJ.EXIT) {
          const ex = new THREE.Mesh(
            new THREE.TorusGeometry(0.34, 0.09, 8, 20),
            new THREE.MeshBasicMaterial({ color: COLORS.exit })
          );
          ex.rotation.x = Math.PI / 2;
          ex.position.set(wx, 0.5, wz);
          propGroup.add(ex);
          const beam = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.3, WALL_H * 5, 12, 1, true),
            new THREE.MeshBasicMaterial({
              color: COLORS.exit,
              transparent: true,
              opacity: 0.14,
              side: THREE.DoubleSide,
            })
          );
          beam.position.set(wx, WALL_H * 2.5, wz);
          propGroup.add(beam);
          const exLight = new THREE.PointLight(COLORS.exit, 0.8, 10, 2);
          exLight.position.set(wx, 1.4, wz);
          propGroup.add(exLight);
          this.props.exit = { mesh: ex, beam, light: exLight };
        }
      }
    }
    this.groups.props = propGroup;
    this.scene.add(propGroup);

    // --- Prisoner avatars — one per prisoner in this game (AI companions
    // included), each with its own walk-queue so a committed human move and
    // an AI companion's move never fight over shared position/animation state.
    this.avatars = game.prisoners.map(() => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.24, 0.4, 6, 12),
        new THREE.MeshLambertMaterial({ color: COLORS.prisoner, emissive: 0x0a3a44 })
      );
      body.position.y = 0.5;
      group.add(body);
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.34, 0.44, 24),
        new THREE.MeshBasicMaterial({ color: COLORS.prisoner, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.04;
      group.add(halo);
      const pLight = new THREE.PointLight(COLORS.prisoner, 0.5, 4, 2);
      pLight.position.y = 0.7;
      group.add(pLight);
      return {
        group,
        halo,
        // When a committed move covers multiple tiles, the avatar visibly
        // steps through each one in order (with fired arrival events)
        // instead of sliding straight from the old tile to the final one.
        walk: { queue: [], from: null, t: 0, stepDur: 0.22 },
      };
    });
    const avatarGroup = new THREE.Group();
    for (const a of this.avatars) avatarGroup.add(a.group);
    this.groups.avatars = avatarGroup;
    this.scene.add(avatarGroup);

    // --- Watcher gaze wedge (a flat sector on the ground).
    this.gazeMesh = this.makeWedge(COLORS.gaze, 0.22);
    this.bluffMesh = this.makeWedge(COLORS.bluff, 0.14);
    this.groups.gaze = this.gazeMesh;
    this.groups.bluff = this.bluffMesh;
    this.scene.add(this.gazeMesh);
    this.scene.add(this.bluffMesh);

    // --- Noise ping pool.
    this.pings = [];
    const pingGroup = new THREE.Group();
    for (let i = 0; i < 12; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.32, 20),
        new THREE.MeshBasicMaterial({ color: COLORS.noise, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      pingGroup.add(ring);
      this.pings.push({ mesh: ring, active: false, t: 0, x: 0, y: 0 });
    }
    this.groups.pings = pingGroup;
    this.scene.add(pingGroup);

    // --- Persistent noise markers (the Watcher's standing intel).
    this.noiseMarks = [];
    const noiseGroup = new THREE.Group();
    for (let i = 0; i < 24; i++) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.4, 20),
        new THREE.MeshBasicMaterial({ color: COLORS.noise, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.visible = false;
      noiseGroup.add(disc);
      this.noiseMarks.push(disc);
    }
    this.groups.noiseMarks = noiseGroup;
    this.scene.add(noiseGroup);

    // --- Self-noise markers: a prisoner's OWN feedback ("I heard that") for
    // sound they personally made this turn. Same visual language as the
    // Watcher's noise intel (same color, same shape) — the meaning is
    // identical ("sound happened here"), only who may see it differs. Gated
    // by role (showPrisoner), not camera, and cleared every turn by rules.js.
    this.selfNoiseMarks = [];
    const selfNoiseGroup = new THREE.Group();
    for (let i = 0; i < 12; i++) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.4, 20),
        new THREE.MeshBasicMaterial({ color: COLORS.noise, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.visible = false;
      selfNoiseGroup.add(disc);
      this.selfNoiseMarks.push(disc);
    }
    this.groups.selfNoiseMarks = selfNoiseGroup;
    this.scene.add(selfNoiseGroup);

    // --- Staged movement path preview: a trace over dark tiles, not a light
    // source. Pool sized to MP_PER_TURN; markers + connecting line rebuilt
    // only when the staged path actually changes (cheap either way at 3 tiles).
    this.pathMarkers = [];
    const pathGroup = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const group = new THREE.Group();
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(0.34, 24),
        new THREE.MeshBasicMaterial({
          color: COLORS.pathPreview,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.32, 0.46, 28),
        new THREE.MeshBasicMaterial({
          color: COLORS.pathPreview,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      fill.rotation.x = -Math.PI / 2;
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.002;
      group.add(fill);
      group.add(ring);
      group.visible = false;
      pathGroup.add(group);
      this.pathMarkers.push({ group, fill, ring });
    }
    const pathLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COLORS.pathPreview, transparent: true, opacity: 0.85 })
    );
    pathLine.visible = false;
    pathGroup.add(pathLine);
    this.pathLine = pathLine;
    this.groups.pathPreview = pathGroup;
    this.scene.add(pathGroup);
    this._pathSig = "";

    // Reach radius for gaze wedge = whole play area.
    this.playRadius =
      (map.cfg.towerRadius + map.cfg.moatThickness + map.cfg.ringCount * map.cfg.ringThickness) * TILE_W;

    this.resize();
  }

  makeWedge(color, opacity) {
    // A 90-degree sector fan lying on the ground, apex at tower center.
    const seg = 16;
    const geo = new THREE.BufferGeometry();
    const verts = [0, 0.02, 0];
    const R = 30;
    for (let i = 0; i <= seg; i++) {
      const a = -Math.PI / 4 + (Math.PI / 2) * (i / seg);
      verts.push(Math.sin(a) * R, 0.02, -Math.cos(a) * R);
    }
    const idx = [];
    for (let i = 1; i <= seg; i++) idx.push(0, i, i + 1);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    return mesh;
  }

  // Enqueue a sequence of grid tiles {x,y,event} for prisoner `prisonerIndex`'s
  // avatar to visibly walk through in order, starting from `from`. Replaces
  // any prior queue for that specific prisoner only.
  walkTo(prisonerIndex, from, steps) {
    const a = this.avatars[prisonerIndex];
    if (!a) return;
    a.walk.queue = steps.slice();
    a.walk.from = { x: from.x, y: from.y };
    a.walk.t = 0;
  }

  // `color` defaults to the noise-ping red; pass COLORS.captureFlash for a
  // distinct white flash at a capture — same pooled ring, own material
  // instance per slot, so recoloring one trigger never bleeds into another.
  triggerPing(x, y, color = COLORS.noise) {
    const slot = this.pings.find((p) => !p.active) || this.pings[0];
    slot.active = true;
    slot.t = 0;
    slot.x = x;
    slot.y = y;
    slot.mesh.material.color.setHex(color);
    slot.mesh.visible = true;
    slot.mesh.position.set(this.worldX(x), 0.05, this.worldZ(y));
  }

  // A capture had no in-world visual moment before this — just a banner and
  // a sound cue, with nothing spatial in the Watcher's own tower view. Reuses
  // the same pooled ping ring, recolored, rather than a whole new effect.
  triggerCaptureFlash(x, y) {
    this.triggerPing(x, y, COLORS.captureFlash);
  }

  setViewMode(mode) {
    this.viewMode = mode;
    // Fog is a claustrophobia tool for the prisoner; the tower views need reach.
    if (mode === "prisoner") {
      this.scene.fog.near = 9;
      this.scene.fog.far = 30;
    } else {
      const r = (this.playRadius || 25) * 3;
      this.scene.fog.near = r * 0.6;
      this.scene.fog.far = r * 2.4;
    }
  }

  // Per-frame update. `game` is current state; `dt` seconds.
  update(game, dt, opts = {}) {
    this.time += dt;
    const map = game.map;
    // Camera/FoV/path-preview below are about the HUMAN's own vantage point,
    // not whoever's turn is currently resolving — `game.activePrisoner`
    // cycles through AI companions automatically, and following it here
    // would yank the camera onto a teammate mid-turn. The caller (main.js)
    // knows which prisoner is the human's and passes it explicitly.
    const viewedIdx = opts.viewedPrisoner != null ? opts.viewedPrisoner : 0;
    const p = game.prisoners[viewedIdx] || game.prisoners[0];

    // Avatar position, per prisoner: walk a queued path tile-by-tile if one
    // is active for THAT prisoner (a just-committed move — Brain
    // telegraph#E6: the sim already resolved this, only the visual catches
    // up), otherwise smoothly settle toward its real tile (AI moves,
    // teleports, idle). Fairness: the Watcher never sees prisoners directly
    // — `showPrisoner` (decided by the caller) applies to the whole group
    // uniformly, hidden for a pure Watcher or on the Watcher's turn in hotseat.
    const showPrisoner = opts.showPrisoner !== undefined ? opts.showPrisoner : true;
    const arrived = [];
    for (let i = 0; i < game.prisoners.length; i++) {
      const pr = game.prisoners[i];
      const av = this.avatars[i];
      if (!av) continue;
      if (av.walk.queue.length) {
        const target = av.walk.queue[0];
        av.walk.t = Math.min(1, av.walk.t + dt / av.walk.stepDur);
        const te = easeInOutQuad(av.walk.t);
        av.group.position.x =
          this.worldX(av.walk.from.x) + (this.worldX(target.x) - this.worldX(av.walk.from.x)) * te;
        av.group.position.z =
          this.worldZ(av.walk.from.y) + (this.worldZ(target.y) - this.worldZ(av.walk.from.y)) * te;
        if (av.walk.t >= 1) {
          av.walk.from = { x: target.x, y: target.y };
          av.walk.queue.shift();
          av.walk.t = 0;
          arrived.push(target);
        }
      } else {
        const targetAX = this.worldX(pr.x);
        const targetAZ = this.worldZ(pr.y);
        const k = smoothing(dt, 0.1);
        av.group.position.x += (targetAX - av.group.position.x) * k;
        av.group.position.z += (targetAZ - av.group.position.z) * k;
      }
      av.group.visible = showPrisoner && pr.alive && !pr.escaped;
      // Pulse halo, phase-offset per prisoner so a group doesn't pulse in lockstep.
      av.halo.material.opacity = 0.4 + 0.2 * Math.sin(this.time * 4 + i * 0.7);
    }

    // Eye faces watcher facing; color shifts if it just scanned.
    const facing = game.watcher.facing;
    const eyeAngle = [Math.PI, -Math.PI / 2, 0, Math.PI / 2][facing];
    if (this.eye) {
      // Position the eye offset toward facing direction on top of tower.
      const off = (map.cfg.towerRadius + 0.2);
      const v = DIR_VEC[facing];
      const eyeK = smoothing(dt, 0.125);
      this.eye.position.x += (v.dx * off - this.eye.position.x) * eyeK;
      this.eye.position.z += (v.dy * off - this.eye.position.z) * eyeK;
    }

    // Dynamic lights follow light state.
    for (const dl of this.dynamicLights) {
      const on = game.lightState[dl.group];
      dl.light.intensity += ((on ? 1.0 : 0) - dl.light.intensity) * smoothing(dt, 0.167);
      dl.mesh.material.color.setHex(on ? COLORS.lampOn : COLORS.lampOff);
    }

    // Doors: show open/closed.
    for (const [k, mesh] of this.props.doors) {
      const [dx, dy] = k.split(",").map(Number);
      const open = game.openedDoors.has(dy * map.size + dx);
      mesh.visible = !open;
    }

    // Windows: hide the pane once broken (permanent — unlike a door, never
    // toggles back).
    for (const [k, mesh] of this.props.windows) {
      const [wx2, wy2] = k.split(",").map(Number);
      const broken = game.brokenWindows.has(wy2 * map.size + wx2);
      mesh.visible = !broken;
    }

    // Self-noise: this prisoner's own "I heard that" markers. Role-gated only
    // (showPrisoner), independent of camera — it's private feedback, not tied
    // to a particular viewing angle.
    const selfNoise = opts.selfNoise || [];
    for (let i = 0; i < this.selfNoiseMarks.length; i++) {
      const disc = this.selfNoiseMarks[i];
      const n = selfNoise[i];
      if (opts.showPrisoner && n) {
        disc.visible = true;
        disc.position.set(this.worldX(n.x), 0.055, this.worldZ(n.y));
        disc.material.opacity = 0.3 + 0.1 * Math.sin(this.time * 4 + i);
      } else {
        disc.visible = false;
      }
    }

    // Gaze + bluff wedges: only for whoever is legitimately "being" the Watcher
    // right now (role-gated, not just camera-gated) — a Prisoner-role human
    // must never see the true gaze, even by cycling their own camera to the
    // watcher/overview angle. Also hidden on the ground-level prisoner camera
    // for the legitimate Watcher, for atmosphere/clutter reasons.
    const showGaze = this.viewMode !== "prisoner" && !!opts.showWatcherInfo;
    this.updateWedge(this.gazeMesh, facing, showGaze);
    this.updateWedge(
      this.bluffMesh,
      game.watcher.bluff,
      showGaze && game.watcher.bluff != null
    );

    // Persistent noise markers — the Watcher's standing intel, same role gate.
    const showNoise = this.viewMode !== "prisoner" && !!opts.showWatcherInfo;
    for (let i = 0; i < this.noiseMarks.length; i++) {
      const disc = this.noiseMarks[i];
      const n = game.noise[i];
      if (showNoise && n) {
        disc.visible = true;
        disc.position.set(this.worldX(n.x), 0.06, this.worldZ(n.y));
        disc.material.opacity = 0.2 + 0.25 * (n.ttl / 2) + 0.08 * Math.sin(this.time * 5 + i);
      } else {
        disc.visible = false;
      }
    }

    // Noise pings expand & fade.
    for (const ping of this.pings) {
      if (!ping.active) continue;
      ping.t += dt;
      const s = 1 + ping.t * 3;
      ping.mesh.scale.set(s, s, s);
      ping.mesh.material.opacity = Math.max(0, 0.8 - ping.t * 0.8);
      if (ping.t > 1) {
        ping.active = false;
        ping.mesh.visible = false;
      }
    }
    // Keep persistent noise markers softly visible in watcher view.

    // FoV darkening (prisoner view only): dim floor tiles outside FoV.
    this.applyFoV(game, p, this.viewMode === "prisoner");

    // Staged path preview (prisoner-view affordance; visible even on dark
    // unlit tiles by design — it traces, it doesn't reveal or emit light).
    this.updatePathPreview(p, opts.stagedPath || []);

    // Camera behaviour.
    this.updateCamera(game, p, dt, opts);

    this.renderer.render(this.scene, this.camera);
    return { arrived };
  }

  renderOnce() {
    this.renderer.render(this.scene, this.camera);
  }

  updateWedge(mesh, dir, visible) {
    if (dir == null || !visible) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.set(this.worldX(this.center.x), 0.03, this.worldZ(this.center.y));
    // Wedge default points North (-Z). Rotate to dir.
    const rot = [0, -Math.PI / 2, Math.PI, Math.PI / 2][dir];
    mesh.rotation.set(0, rot, 0);
  }

  // Trace a staged (uncommitted) prisoner path: a ring per tile + a thin line
  // through them, warm and distinct from noise (red) / gaze (blue) / bluff
  // (amber). Purely decorative — MeshBasicMaterial, no PointLight, no effect
  // on isLit()/FoV — so it never "lights" a dark tile, only marks it.
  updatePathPreview(prisoner, path) {
    const sig = path.map((s) => `${s.x},${s.y}`).join("|");
    if (sig === this._pathSig) {
      // Unchanged: just keep the tip pulsing for legibility against a dark floor.
      if (path.length) {
        const tip = this.pathMarkers[path.length - 1];
        const pulse = 0.6 + 0.3 * Math.sin(this.time * 6);
        tip.ring.material.opacity = pulse;
        tip.fill.material.opacity = pulse * 0.35;
      }
      return;
    }
    this._pathSig = sig;

    this.pathMarkers.forEach((m) => {
      m.group.visible = false;
      m.ring.material.opacity = 0;
      m.fill.material.opacity = 0;
    });
    if (!path.length) {
      this.pathLine.visible = false;
      return;
    }

    const pts = [new THREE.Vector3(this.worldX(prisoner.x), 0.06, this.worldZ(prisoner.y))];
    path.forEach((step, i) => {
      const m = this.pathMarkers[i];
      if (m) {
        const isTip = i === path.length - 1;
        m.group.visible = true;
        m.group.position.set(this.worldX(step.x), 0.06, this.worldZ(step.y));
        m.ring.material.opacity = isTip ? 0.9 : 0.55 + 0.1 * i;
        m.fill.material.opacity = isTip ? 0.3 : 0.15 + 0.05 * i;
      }
      pts.push(new THREE.Vector3(this.worldX(step.x), 0.06, this.worldZ(step.y)));
    });

    this.pathLine.geometry.dispose();
    this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.pathLine.visible = true;
  }

  applyFoV(game, prisoner, enabled) {
    if (!this.floorMesh) return;
    const col = new THREE.Color();
    if (!enabled) {
      // Full brightness.
      this.floors.forEach((f, i) => {
        col.setHex(this.floorBaseColors[i]);
        this.floorMesh.setColorAt(i, col);
      });
      if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
      this.ambient.intensity = 0.7;
      return;
    }
    this.ambient.intensity = 0.28;
    const vis = computeFoV(game, prisoner);
    this.floors.forEach((f, i) => {
      const key = `${f.x},${f.y}`;
      const level = vis.get(key);
      let mul;
      if (level === VIS.CLEAR) mul = 1.35;
      else if (level === VIS.FOGGY) mul = 0.9;
      else if (level === VIS.OUTLINE) mul = 0.5;
      else mul = 0.12; // unseen
      col.setHex(this.floorBaseColors[i]).multiplyScalar(mul);
      this.floorMesh.setColorAt(i, col);
    });
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
  }

  updateCamera(game, prisoner, dt, opts) {
    const cx = this.worldX(prisoner.x);
    const cz = this.worldZ(prisoner.y);
    const towerX = this.worldX(this.center.x);
    const towerZ = this.worldZ(this.center.y);

    let tPos = new THREE.Vector3();
    let tTarget = new THREE.Vector3();

    if (this.viewMode === "watcher") {
      // High over the tower looking outward toward the facing direction.
      const v = DIR_VEC[game.watcher.facing];
      tTarget.set(towerX + v.dx * 8, 0, towerZ + v.dy * 8);
      tPos.set(towerX - v.dx * 4, this.playRadius * 1.5 + 6, towerZ - v.dy * 4);
    } else if (this.viewMode === "overview") {
      tTarget.set(towerX, 0, towerZ);
      const a = this.orbit.az;
      const d = this.playRadius * 2.1;
      tPos.set(towerX + Math.sin(a) * d, d * 0.85, towerZ + Math.cos(a) * d);
    } else {
      // Prisoner third-person: behind & above, orbitable.
      const a = this.orbit.az;
      const d = this.orbit.dist;
      const el = this.orbit.el;
      tTarget.set(cx, 0.6, cz);
      tPos.set(
        cx + Math.sin(a) * d * Math.cos(el),
        d * Math.sin(el) + 2,
        cz + Math.cos(a) * d * Math.cos(el)
      );
    }

    const k = smoothing(dt, 0.25);
    this.camPos.lerp(tPos, k);
    this.camTarget.lerp(tTarget, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }
}
