// screen-relative-move.mjs — Up is up, not North.
//
// The Watcher's d-pad already resolved directions against the live camera; the
// Prisoner's never did. Every direction a Prisoner can give is spatial (WASD,
// arrows, the on-screen ▲▼◀▶, a d-pad, a stick) — there is no labelled
// compass control on that side at all — yet "up" was hardcoded to world-North.
// Both the prisoner and overview cameras orbit, so the moment the view turned,
// pressing up walked you sideways.
//
// Brain opticon#E24: "a camera-relative movement sign error passes every
// displacement-magnitude test — inverted controls still MOVED". So this file
// never asserts "the prisoner moved". It asserts the SIGN of the movement
// after projecting it through the same camera that drew the frame: press up,
// and the avatar's projected position must travel toward the TOP of the
// screen, whatever compass direction that turned out to be.
// Run: node game/tests/screen-relative-move.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8217;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.keyboard.down("Space");
await page.waitForTimeout(800);
await page.keyboard.up("Space");
await page.waitForTimeout(300);
await page.click('[data-diff="medium"]');
await page.waitForTimeout(200);
await page.click("#playPrisoner");
await page.waitForTimeout(200);
await page.hover("#btnStart");
await page.mouse.down();
await page.waitForTimeout(800);
await page.mouse.up();
await page.waitForTimeout(500);
await page.evaluate(() => window.__opticon.renderer.skipIntro());
await page.waitForFunction(() => window.__opticon?.game, null, { timeout: 15000 });

// Project a map tile through the LIVE camera into normalized device coords.
// This is the same transform that put the tile on screen, so "toward the top"
// is exactly "larger NDC y" with no separate handedness convention to invert.
const projectTile = (x, y) =>
  page.evaluate(([x, y]) => {
    const r = window.__opticon.renderer;
    r.camera.updateMatrixWorld();
    const THREE = r.camera.constructor;
    const v = new r.camPos.constructor(r.worldX(x), 0, r.worldZ(y));
    v.project(r.camera);
    return { x: v.x, y: v.y };
  }, [x, y]);

// Put the human's prisoner somewhere with open floor all around, so a blocked
// tile can never be mistaken for a wrong direction, then read where a given
// SCREEN direction resolves to in world terms.
const setupOpenGround = () =>
  page.evaluate(() => {
    const app = window.__opticon;
    const g = app.game;
    const p = g.prisoners[0];
    g.turn = "Prisoner";
    g.activePrisoner = 0;
    p.mp = 3;
    p.custody = 0;
    // Carve a 5x5 clearing centred on the prisoner.
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        g.map.tiles[p.y + dy][p.x + dx] = 0; // TILE.FLOOR
        g.map.objects[p.y + dy][p.x + dx] = 0; // OBJ.NONE
      }
    }
    return { x: p.x, y: p.y };
  });

const resolve = (screenDir, from) =>
  page.evaluate(([d, from]) => window.__opticon.renderer.screenDirToWorld(d, from), [screenDir, from]);

const setOrbit = (az) =>
  page.evaluate((az) => {
    const app = window.__opticon;
    app.renderer.orbit.az = az;
    // Snap the smoothed rig straight onto the new pose — otherwise the
    // camera is still easing toward it and the projection under test is a
    // pose that was never actually on screen.
    for (let i = 0; i < 200; i++) app.renderer.updateCamera(app.game, app.game.prisoners[0], 0.1);
  }, az);

const DIR_VEC = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];
const NAMES = ["North", "East", "South", "West"];
const SCREEN = ["up", "right", "down", "left"];
// What each screen direction must do to the projected position: up increases
// NDC y, right increases NDC x, and so on.
const WANT = [{ ax: "y", sign: +1 }, { ax: "x", sign: +1 }, { ax: "y", sign: -1 }, { ax: "x", sign: -1 }];

for (const view of ["prisoner", "overview"]) {
  await page.evaluate((v) => {
    window.__opticon.viewMode = v;
    window.__opticon.renderer.setViewMode(v);
  }, view);

  for (const az of [0.6, 2.2, 3.9, 5.4]) {
    await setOrbit(az);
    const at = await setupOpenGround();
    const here = await projectTile(at.x, at.y);
    // Project all four cardinals once, then judge each screen direction
    // against the same data the resolver had.
    const proj = [];
    for (let d = 0; d < 4; d++) {
      const v = DIR_VEC[d];
      const there = await projectTile(at.x + v.dx, at.y + v.dy);
      proj.push({ x: there.x - here.x, y: there.y - here.y });
    }
    const picked = [];
    let signsOk = true;
    let bestOk = true;
    for (let sd = 0; sd < 4; sd++) {
      const world = await resolve(sd, at);
      picked.push(NAMES[world]);
      const want = WANT[sd];
      // THE sign check (opticon#E24). A magnitude test ("it moved") passes
      // for all four cardinals, so it can never catch an inversion.
      if (Math.sign(proj[world][want.ax]) !== want.sign) signsOk = false;
      // And it must be the BEST of the four, not merely an acceptable one.
      // Deliberately not "the requested axis dominates": at a camera sitting
      // between two cardinals (az ~3.9, ~5.4) world-North projects diagonally
      // and NO cardinal is dominantly "up" — the honest contract there is
      // that the resolver picks the closest available, which is exactly what
      // the player sees.
      const dot = (d) => {
        const m = Math.hypot(proj[d].x, proj[d].y) || 1;
        return (proj[d].x * (want.ax === "x" ? want.sign : 0) +
                proj[d].y * (want.ax === "y" ? want.sign : 0)) / m;
      };
      let best = 0;
      for (let d = 1; d < 4; d++) if (dot(d) > dot(best)) best = d;
      if (world !== best) bestOk = false;
    }
    check(signsOk,
      `${view} view @ az ${az.toFixed(1)}: every screen direction moves the right way on screen (${picked.join("/")})`);
    check(bestOk,
      `${view} view @ az ${az.toFixed(1)}: and picks the closest cardinal available, not just an acceptable one`);
    // The mapping must stay a bijection — four screen directions onto four
    // distinct cardinals. A degenerate camera could collapse two onto one and
    // still satisfy every sign check above.
    check(new Set(picked).size === 4, `${view} view @ az ${az.toFixed(1)}: four distinct cardinals, no collapse`);
  }
}

// ---- The mapping is not a constant --------------------------------------
// If it were, the whole feature would be a no-op that happens to agree with
// North on the default camera. Rotating the view must change what "up" means.
{
  await page.evaluate(() => {
    window.__opticon.viewMode = "overview";
    window.__opticon.renderer.setViewMode("overview");
  });
  const at = await setupOpenGround();
  await setOrbit(0.6);
  const a = await resolve(0, at);
  await setOrbit(0.6 + Math.PI);
  const b = await resolve(0, at);
  check(a !== b, `spinning the camera 180° changes what "up" means (${NAMES[a]} -> ${NAMES[b]})`);
}

// ---- A real keypress walks the way the key points ------------------------
// Everything above tests the resolver. This tests that the resolver is
// actually wired into movement — the failure mode where the mapping is
// perfect and nothing calls it.
{
  await page.evaluate(() => {
    window.__opticon.viewMode = "prisoner";
    window.__opticon.renderer.setViewMode("prisoner");
  });
  for (const az of [0.6, 3.7]) {
    await setOrbit(az);
    const at = await setupOpenGround();
    const here = await projectTile(at.x, at.y);
    await page.keyboard.press("KeyW");
    await page.waitForTimeout(150);
    const staged = await page.evaluate(() => {
      const s = window.__opticon.stagedPath;
      return s.length ? { x: s[s.length - 1].x, y: s[s.length - 1].y } : null;
    });
    check(!!staged, `az ${az.toFixed(1)}: pressing W stages a step`);
    if (staged) {
      const there = await projectTile(staged.x, staged.y);
      const dy = there.y - here.y;
      const dx = there.x - here.x;
      check(dy > 0 && Math.abs(dy) > Math.abs(dx),
        `az ${az.toFixed(1)}: W walks toward the top of the screen (ndc dy ${dy.toFixed(3)}, dx ${dx.toFixed(3)})`);
    }
    // Clear the staged path before the next pass.
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__opticon.stagedPath.length = 0; });
  }
}

// ---- And one rendered frame, per T9 -------------------------------------
// A headless sim proves the system and cannot prove the picture. Cheap
// insurance that the camera pose these numbers came from is a real one.
await page.screenshot({ path: path.join(ROOT, "tests", "shot-screen-relative.png") });

check(errors.length === 0, `no console errors (${errors.length} found)`);
if (errors.length) console.log(errors.slice(0, 5));

await browser.close();
server.close();
console.log(ok ? "\n✓ screen-relative-move passed" : "\n✗ screen-relative-move failed");
process.exit(ok ? 0 : 1);
