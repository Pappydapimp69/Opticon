// watcher-aim-commit.mjs — Two separate contracts on the Watcher's controls.
//
// 1. SPATIAL CONTROLS ARE SCREEN-RELATIVE. A d-pad push means the top/bottom
//    of the screen, not a fixed compass bearing. The Watcher camera swings to
//    face the gaze, so a hardcoded up=North aims guards somewhere other than
//    where the player pointed as soon as the gaze is not North. Labelled
//    controls (N/E/S/W buttons, keys 1-4) must STAY absolute.
// 2. ROTATION IS STAGED, NOT INSTANT. rotateWatcher() sets rotatedThisTurn
//    and cannot be undone, so firing it straight off LB/RB spent the turn's
//    only rotation on a single keypress with no cancel and no way to switch
//    sides. It must preview, be changeable, be cancellable, and only reach
//    the rules through the same confirm the Prisoner uses.
// Run: node game/tests/watcher-aim-commit.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH || "/opt/node22/lib/node_modules/playwright";
const chromiumPath = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { chromium } = require(playwrightPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8234;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}

async function pollUntil(page, predicate, timeoutMs = 8000, arg) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function startWatcher(page) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.keyboard.down("Space");
  const opened = await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"));
  await page.keyboard.up("Space");
  if (!opened) throw new Error("intro hold did not open the menu");
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(100);
  await page.click("#playWatcher");
  await page.waitForTimeout(100);
  await page.hover("#btnStart");
  await page.mouse.down();
  const started = await pollUntil(page, () => !!window.__opticon?.game);
  await page.mouse.up();
  if (!started) throw new Error("Start hold did not create a game");
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await pollUntil(page, () => window.__opticon.game.turn === "Watcher", 15000);
  await page.waitForTimeout(300);
}

const DIRS = ["North", "East", "South", "West"];

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  // ---------- 1. Screen-relative aiming ----------
  await startWatcher(page);

  // The mapping must actually depend on the camera. Sample it with the gaze
  // (and so the camera) pointing each of the four ways: if screen-up resolved
  // to the same world dir every time, it is still hardcoded.
  const upPerFacing = [];
  for (let f = 0; f < 4; f++) {
    await page.evaluate((face) => { window.__opticon.game.watcher.facing = face; }, f);
    await page.waitForTimeout(700); // camera lerps toward the new facing
    upPerFacing.push(await page.evaluate(() => window.__opticon.renderer.screenDirToWorld(0)));
  }
  console.log(`    screen-up resolves to: ${upPerFacing.map((d) => DIRS[d]).join(", ")} (gaze N,E,S,W)`);
  check(new Set(upPerFacing).size > 1,
    `screen-up follows the camera instead of being fixed (got ${JSON.stringify(upPerFacing.map((d) => DIRS[d]))})`);

  // The four screen directions must stay a permutation of the four world
  // directions — never two screen keys aiming at the same quadrant.
  const quad = await page.evaluate(() => [0, 1, 2, 3].map((d) => window.__opticon.renderer.screenDirToWorld(d)));
  check(new Set(quad).size === 4, `the four screen directions map to four distinct quadrants (got ${JSON.stringify(quad)})`);
  // Opposite screen directions must resolve to opposite world directions.
  check((quad[0] + 2) % 4 === quad[2] && (quad[1] + 2) % 4 === quad[3],
    `opposite screen directions stay opposite on the map (got ${JSON.stringify(quad.map((d) => DIRS[d]))})`);

  // And a real d-pad dispatch must land in the quadrant the screen pointed to.
  await page.evaluate(() => {
    const g = window.__opticon.game;
    g.watcher.facing = 1; // deliberately NOT north, so absolute != screen-relative
    g.watcher.skills.dispatch = 0;
    g.watcher.guards.length = 0;
  });
  await page.waitForTimeout(700);
  const expectDown = await page.evaluate(() => window.__opticon.renderer.screenDirToWorld(2));
  await page.evaluate(() => window.__opticon.input.onIntent("skill", "dispatch"));
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__opticon.input.onIntent("bluffScreen", 2)); // d-pad DOWN
  await page.waitForTimeout(250);
  const dispatched = await page.evaluate(() => window.__opticon.game.watcher.guards.map((g) => g.quadrant));
  check(dispatched.length === 2 && dispatched.every((q) => q === expectDown),
    `d-pad down sends guards to the quadrant at the bottom of the screen (${DIRS[expectDown]}; got ${JSON.stringify(dispatched.map((d) => DIRS[d]))})`);

  // Labelled controls must NOT be re-aimed: "N" means North, always.
  await page.evaluate(() => {
    const g = window.__opticon.game;
    g.watcher.guards.length = 0;
    g.watcher.skills.dispatch = 0;
  });
  await page.evaluate(() => window.__opticon.input.onIntent("skill", "dispatch"));
  await page.waitForTimeout(150);
  await page.click('#watcherControls [data-intent="bluff"][data-arg="0"]');
  await page.waitForTimeout(250);
  const labelled = await page.evaluate(() => window.__opticon.game.watcher.guards.map((g) => g.quadrant));
  check(labelled.length === 2 && labelled.every((q) => q === 0),
    `the labelled "N" button still means North (got ${JSON.stringify(labelled.map((d) => DIRS[d]))})`);

  // ---------- 2. Staged rotation ----------
  await startWatcher(page);
  const base = await page.evaluate(() => window.__opticon.game.watcher.facing);

  await page.keyboard.press("KeyE"); // rotate clockwise
  await page.waitForTimeout(200);
  let s = await page.evaluate(() => ({
    facing: window.__opticon.game.watcher.facing,
    staged: window.__opticon.stagedFacing,
    rotated: window.__opticon.game.watcher.rotatedThisTurn,
    btn: document.getElementById("commitBtn").textContent,
    gaze: document.getElementById("facingLabel").textContent,
  }));
  check(s.facing === base && !s.rotated, "pressing rotate does NOT commit the gaze");
  check(s.staged === (base + 1) % 4, `the rotation is staged as a preview (got ${s.staged})`);
  check(/\?/.test(s.gaze), `the HUD marks the gaze as provisional (got ${JSON.stringify(s.gaze)})`);
  check(/Commit/i.test(s.btn), `the confirm control offers to commit (got ${JSON.stringify(s.btn)})`);

  // Switching sides before committing must work — the core complaint.
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(150);
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(150);
  s = await page.evaluate(() => ({
    staged: window.__opticon.stagedFacing,
    facing: window.__opticon.game.watcher.facing,
    rotated: window.__opticon.game.watcher.rotatedThisTurn,
  }));
  check(s.staged === (base + 3) % 4, `the player can switch to the other direction before committing (got ${s.staged})`);
  check(s.facing === base && !s.rotated, "switching direction still has not touched the real gaze");

  // Cancelling back to the original heading must leave nothing staged.
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(200);
  s = await page.evaluate(() => ({
    staged: window.__opticon.stagedFacing,
    facing: window.__opticon.game.watcher.facing,
    rotated: window.__opticon.game.watcher.rotatedThisTurn,
    btn: document.getElementById("commitBtn").textContent,
  }));
  check(s.staged === null, `rotating back cancels the preview (got ${s.staged})`);
  check(!s.rotated && s.facing === base, "a cancelled rotation costs nothing");
  check(/Scan/i.test(s.btn), `the confirm control returns to scan & end (got ${JSON.stringify(s.btn)})`);

  // Now commit for real, and confirm it does NOT also end the turn.
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space"); // first press: commit the rotation
  await page.waitForTimeout(300);
  s = await page.evaluate(() => ({
    facing: window.__opticon.game.watcher.facing,
    staged: window.__opticon.stagedFacing,
    rotated: window.__opticon.game.watcher.rotatedThisTurn,
    turn: window.__opticon.game.turn,
  }));
  check(s.facing === (base + 1) % 4, `confirming applies the staged rotation (got ${s.facing}, base ${base})`);
  check(s.staged === null, "the preview clears once committed");
  check(s.turn === "Watcher", "committing a rotation does not also end the turn");

  // The turn's single rotation is spent — further presses must say so, not
  // silently stage something that can never be applied.
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(200);
  s = await page.evaluate(() => ({
    staged: window.__opticon.stagedFacing,
    hint: document.getElementById("hint").textContent,
  }));
  check(s.staged === null, "no preview is offered once the rotation is spent");
  check(/already rotated/i.test(s.hint), `the player is told why (got ${JSON.stringify(s.hint)})`);

  // And the next press really does end the turn.
  await page.keyboard.press("Space");
  await pollUntil(page, () => window.__opticon.game.turn !== "Watcher", 6000);
  check(await page.evaluate(() => window.__opticon.game.turn !== "Watcher"),
    "a second confirm scans and ends the turn as before");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ watcher-aim-commit passed" : "\n✗ watcher-aim-commit failed");
  process.exit(ok ? 0 : 1);
})();
