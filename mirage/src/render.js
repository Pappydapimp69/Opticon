// render.js — Three.js presentation of the basin, drawn from PERCEPTION.
//
// Hard rule: this module reads the perceived world (percept.js), never the sim's
// truth. That is what lets a hallucinating lead be shown a monolith that does not
// exist without any special case here — the phantom simply arrives in the same
// list as the real ones.

import * as THREE from "../lib/three.module.js";
import { CELL, GRID, cellToWorld } from "./world.js";
import { perceivedMonoliths, perceivedPylons, perceivedCompanions, distortion } from "./percept.js";
import { PYLON_RADIUS } from "./state.js";

const PALETTE = {
  sky: 0x0a0f16,
  fog: 0x121a24,
  fogLost: 0x2a1d2b, // the basin goes wrong-coloured when the lead does
  ground: 0x333c4b,
  groundHi: 0x475364,
  rock: 0x1b212b,
  monolith: 0x59657a,
  monolithLogged: 0x7fd6c0,
  pylon: 0x2a3550,
  pylonLive: 0x74e0ff,
  pylonDead: 0x40484f,
  camp: 0xffb562,
  body: 0x8d97a8,
  bodyLost: 0xb06a72,
};

const EYE_HEIGHT = 1.72;

export function createRenderer(canvas, sim) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  // Fog density set against SIGHT_RANGE (38 units): at 0.021 a marker at the
  // edge of sighting range was ~47% fogged out, which made exploring feel like
  // guessing. 0.014 keeps the basin oppressive but legible.
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.014);

  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 420);
  const rig = new THREE.Group(); // yaw/position; camera holds pitch and roll
  rig.add(camera);
  scene.add(rig);

  scene.add(new THREE.HemisphereLight(0x5d708c, 0x1d2230, 1.05));
  const sun = new THREE.DirectionalLight(0xbfd0e6, 0.55);
  sun.position.set(-40, 60, 30);
  scene.add(sun);
  // A single carried lamp — cheaper than one light per companion, and it makes
  // the party's own pool of light the thing you navigate by.
  const lamp = new THREE.PointLight(0xffdcb0, 1.9, 44, 1.5);
  rig.add(lamp);

  // ---- terrain -------------------------------------------------------------
  const span = GRID * CELL;
  const groundGeo = new THREE.PlaneGeometry(span, span, GRID, GRID);
  groundGeo.rotateX(-Math.PI / 2);
  {
    const pos = groundGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const lo = new THREE.Color(PALETTE.ground);
    const hi = new THREE.Color(PALETTE.groundHi);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = sim.world.heightAt(x / CELL + GRID / 2, z / CELL + GRID / 2);
      pos.setY(i, h);
      c.copy(lo).lerp(hi, Math.min(1, Math.max(0, (h + 2) / 7)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    groundGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
  );
  scene.add(ground);

  const terrainHeight = (x, z) => sim.world.heightAt(x / CELL + GRID / 2, z / CELL + GRID / 2);

  // ---- rock spires (one instanced mesh for every blocked cell) -------------
  {
    let count = 0;
    for (let i = 0; i < sim.world.blocked.length; i++) if (sim.world.blocked[i]) count++;
    const rocks = new THREE.InstancedMesh(
      new THREE.ConeGeometry(CELL * 0.72, 1, 6),
      new THREE.MeshStandardMaterial({ color: PALETTE.rock, roughness: 1, flatShading: true }),
      count,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let n = 0;
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        if (!sim.world.blocked[cz * GRID + cx]) continue;
        const { x, z } = cellToWorld(cx, cz);
        // Deterministic pseudo-variation from the cell index — no rng needed, and
        // it stays identical across reloads of the same seed.
        const j = ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
        const h = 3.4 + ((j % 100) / 100) * 5.2;
        const yaw = ((j >>> 7) % 360) * (Math.PI / 180);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        m.compose(
          new THREE.Vector3(x, terrainHeight(x, z) + h / 2 - 0.4, z),
          q,
          new THREE.Vector3(1, h, 1),
        );
        rocks.setMatrixAt(n++, m);
      }
    }
    rocks.instanceMatrix.needsUpdate = true;
    scene.add(rocks);
  }

  // ---- ground litter -------------------------------------------------------
  // Scattered stones across the open floor. Not decoration: the basin is a fogged
  // plain, and without near-field detail passing the camera there is no parallax,
  // so walking reads as standing still with the fog shifting. This is the cheapest
  // fix — one instanced mesh, no per-frame work — and it is what makes movement
  // legible in an exploration game with a short view distance.
  {
    const MAX = 620;
    const stones = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({ color: 0x39424f, roughness: 1, flatShading: true }),
      MAX,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    // Deterministic scatter from the cell index, so the same seed lays out the
    // same stones on every reload without consuming the sim's rng stream.
    for (let cz = 1; cz < GRID - 1 && n < MAX; cz++) {
      for (let cx = 1; cx < GRID - 1 && n < MAX; cx++) {
        if (sim.world.blocked[cz * GRID + cx]) continue;
        const j = ((cx * 2654435761) ^ (cz * 40503)) >>> 0;
        if (j % 5 !== 0) continue; // ~20% of open cells get one
        const ox = (((j >>> 3) % 100) / 100 - 0.5) * CELL;
        const oz = (((j >>> 11) % 100) / 100 - 0.5) * CELL;
        const { x, z } = cellToWorld(cx, cz);
        const s = 0.5 + ((j >>> 17) % 100) / 140;
        q.setFromAxisAngle(up, ((j >>> 5) % 360) * (Math.PI / 180));
        m.compose(
          new THREE.Vector3(x + ox, terrainHeight(x + ox, z + oz) + 0.08 * s, z + oz),
          q,
          new THREE.Vector3(s, s * 0.6, s),
        );
        stones.setMatrixAt(n++, m);
      }
    }
    stones.count = n; // don't draw unused instances at the origin
    stones.instanceMatrix.needsUpdate = true;
    scene.add(stones);
  }

  // ---- camp ---------------------------------------------------------------
  {
    const camp = new THREE.Group();
    const { x, z } = sim.world.camp;
    camp.position.set(x, terrainHeight(x, z), z);
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0x555f6d, roughness: 0.8 }),
    );
    mast.position.y = 3;
    camp.add(mast);
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 14, 12),
      new THREE.MeshBasicMaterial({ color: PALETTE.camp }),
    );
    beacon.position.y = 6.2;
    camp.add(beacon);
    camp.add(new THREE.PointLight(PALETTE.camp, 1.1, 26, 1.7).translateY(6.2));
    scene.add(camp);
  }

  // ---- monoliths, pylons, figures: pooled and rebuilt from perception ------
  const monolithGeo = new THREE.BoxGeometry(1.5, 7.4, 1.1);
  const ringGeo = new THREE.TorusGeometry(PYLON_RADIUS, 0.09, 6, 40);
  const pool = { monoliths: new Map(), pylons: new Map(), figures: new Map() };

  function makeMonolith() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      monolithGeo,
      new THREE.MeshStandardMaterial({ color: PALETTE.monolith, roughness: 0.85, flatShading: true }),
    );
    body.position.y = 3.7;
    body.rotation.z = 0.06;
    g.add(body);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 10),
      new THREE.MeshBasicMaterial({ color: PALETTE.monolithLogged }),
    );
    cap.position.y = 7.7;
    cap.visible = false;
    g.add(cap);
    g.userData = { body, cap };
    scene.add(g);
    return g;
  }

  function makePylon() {
    const g = new THREE.Group();
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.5, 4.6, 8),
      new THREE.MeshStandardMaterial({ color: PALETTE.pylon, roughness: 0.7, metalness: 0.2 }),
    );
    col.position.y = 2.3;
    g.add(col);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshBasicMaterial({ color: PALETTE.pylonLive }),
    );
    core.position.y = 5.0;
    g.add(core);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: PALETTE.pylonLive, transparent: true, opacity: 0.28 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.25;
    g.add(ring);
    const glow = new THREE.PointLight(PALETTE.pylonLive, 1.4, 22, 1.7);
    glow.position.y = 5.0;
    g.add(glow);
    g.userData = { core, ring, glow };
    scene.add(g);
    return g;
  }

  function makeFigure() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: PALETTE.body, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.95, 6, 10), mat);
    body.position.y = 1.05;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), mat);
    head.position.y = 1.86;
    g.add(head);
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    );
    light.position.set(0.3, 1.3, 0.22);
    g.add(light);
    g.userData = { mat, light, bob: Math.random() * 6.283, lastX: 0, lastZ: 0 };
    scene.add(g);
    return g;
  }

  function syncPool(map, list, factory) {
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let obj = map.get(item.id);
      if (!obj) {
        obj = factory();
        map.set(item.id, obj);
      }
      obj.visible = true;
      obj.userData.item = item;
    }
    for (const [id, obj] of map) if (!seen.has(id)) obj.visible = false;
    return map;
  }

  const tmpColor = new THREE.Color();
  let elapsed = 0;

  function update(percept, dt, view) {
    elapsed += dt;
    const dis = distortion(percept, sim);

    // ---- camera ----
    const px = sim.player.x;
    const pz = sim.player.z;
    rig.position.set(px, terrainHeight(px, pz) + EYE_HEIGHT, pz);
    rig.rotation.y = view.yaw;
    camera.rotation.x = view.pitch;
    // Sway and roll scale with distortion: the lead's own tell, before anything
    // in the world has visibly changed.
    camera.rotation.z = Math.sin(percept.swayPhase * 1.7) * 0.045 * dis;
    camera.position.y = Math.sin(percept.swayPhase * 2.3) * 0.06 * dis;
    camera.fov = 72 + Math.sin(percept.swayPhase * 0.9) * 5 * dis;
    camera.updateProjectionMatrix();

    // ---- fog / colour drift ----
    tmpColor.set(PALETTE.fog).lerp(new THREE.Color(PALETTE.fogLost), dis);
    scene.fog.color.copy(tmpColor);
    scene.background = tmpColor;
    scene.fog.density = 0.014 + dis * 0.018; // the basin closes in as the lead goes
    lamp.intensity = 1.9 - dis * 0.6;

    // ---- markers ----
    syncPool(pool.monoliths, perceivedMonoliths(percept, sim), makeMonolith);
    for (const obj of pool.monoliths.values()) {
      if (!obj.visible) continue;
      const m = obj.userData.item;
      obj.position.set(m.x, terrainHeight(m.x, m.z), m.z);
      obj.userData.cap.visible = !!m.logged;
      obj.userData.body.material.color.set(m.logged ? PALETTE.monolithLogged : PALETTE.monolith);
    }

    // ---- pylons ----
    syncPool(pool.pylons, perceivedPylons(percept, sim), makePylon);
    for (const obj of pool.pylons.values()) {
      if (!obj.visible) continue;
      const p = obj.userData.item;
      obj.position.set(p.x, terrainHeight(p.x, p.z), p.z);
      // NOTE: `looksLive` — not `charge > 0`. A spent pylon can read as full to a
      // hallucinating lead, and that lie has to survive all the way to the pixel.
      const live = p.looksLive;
      const frac = Math.max(0, Math.min(1, (p.charge ?? 0) / 100));
      const shown = live ? Math.max(0.25, frac) : 0;
      obj.userData.core.material.color.set(live ? PALETTE.pylonLive : PALETTE.pylonDead);
      obj.userData.core.scale.setScalar(0.7 + shown * 0.5 + Math.sin(elapsed * 2 + p.x) * 0.04);
      obj.userData.glow.intensity = live ? 0.5 + shown * 1.4 : 0.05;
      obj.userData.ring.material.opacity = live ? 0.12 + shown * 0.22 : 0.05;
      obj.userData.ring.material.color.set(live ? PALETTE.pylonLive : PALETTE.pylonDead);
    }

    // ---- companions (real and otherwise) ----
    syncPool(pool.figures, perceivedCompanions(percept, sim), makeFigure);
    for (const obj of pool.figures.values()) {
      if (!obj.visible) continue;
      const c = obj.userData.item;
      const moved = Math.hypot(c.x - obj.userData.lastX, c.z - obj.userData.lastZ);
      obj.userData.lastX = c.x;
      obj.userData.lastZ = c.z;
      obj.userData.bob += moved * 2.6;
      obj.position.set(c.x, terrainHeight(c.x, c.z) + Math.abs(Math.sin(obj.userData.bob)) * 0.07, c.z);
      // Face travel direction; fall back to facing the lead when standing still.
      const dx = px - c.x;
      const dz = pz - c.z;
      obj.rotation.y = Math.atan2(dx, dz);
      obj.userData.mat.color.set(c.hallucinating ? PALETTE.bodyLost : PALETTE.body);
      obj.userData.light.material.color.set(c.hallucinating ? 0xff8a94 : 0xffd9a0);
    }

    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h || 1;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  return { renderer, scene, camera, rig, update, resize, terrainHeight, PALETTE };
}
