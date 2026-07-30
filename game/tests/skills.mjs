// skills.mjs — Headless check of the Watcher skill bar through main.js:
// rendering, cooldown display, the hidden-info gate (a hotseat PRISONER must
// never read the tower's readiness), and that a skill actually fires.
// Run: node game/tests/skills.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8218;

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

async function startAs(page, btn) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click(btn);
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
}

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  // --- Human Watcher: the bar should appear on the Watcher's turn.
  await startAs(page, "#playWatcher");
  // The AI prisoners move first; wait for the handoff back to the Watcher.
  for (let i = 0; i < 40; i++) {
    const t = await page.evaluate(() => window.__opticon.game.turn);
    if (t === "Watcher") break;
    await page.waitForTimeout(200);
  }
  const turn = await page.evaluate(() => window.__opticon.game.turn);
  check(turn === "Watcher", `reached the Watcher's turn (got ${turn})`);

  await page.waitForTimeout(300);
  const chips = await page.$$eval("#skillBar .skill-chip", (els) => els.length);
  check(chips === 5, `skill bar renders all five skills (got ${chips})`);

  // Wide scan is always usable — fire it with its key and confirm cooldown.
  await page.keyboard.press("Digit6");
  await page.waitForTimeout(250);
  const afterWide = await page.evaluate(() => {
    const w = window.__opticon.game.watcher;
    return { armed: w.wideScan, cd: w.skills.wideScan };
  });
  check(afterWide.armed === true, "pressing 6 arms the wide scan");
  check(afterWide.cd > 0, `wide scan went on cooldown (${afterWide.cd})`);
  const cooling = await page.$$eval("#skillBar .skill-chip.cooling", (els) => els.length);
  check(cooling >= 1, "the spent skill renders as cooling down");

  // Dispatch guards: arm with 9, pick a quadrant with 1-4 (must wait out
  // wide scan's cooldown from above — dispatch has its own, separate one).
  const quadrant = await page.evaluate(() => {
    const g = window.__opticon.game;
    const { center } = g.map;
    const dx = g.map.exit.x - center.x, dy = g.map.exit.y - center.y;
    return Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 0 : 2) : (dx > 0 ? 1 : 3);
  });
  await page.keyboard.press("Digit9");
  await page.waitForTimeout(150);
  const armed = await page.evaluate(() => window.__opticon.armedDispatch);
  check(armed === true, "pressing 9 arms dispatch");
  await page.keyboard.press(["Digit1", "Digit2", "Digit3", "Digit4"][quadrant]);
  await page.waitForTimeout(200);
  const afterDispatch = await page.evaluate(() => ({
    guards: window.__opticon.game.watcher.guards.length,
    meshes: window.__opticon.renderer.guardMeshes.size,
    armed: window.__opticon.armedDispatch,
  }));
  check(afterDispatch.guards === 2, `dispatch spawns 2 guards (got ${afterDispatch.guards})`);
  check(afterDispatch.meshes === 2, `renderer builds a mesh per guard (got ${afterDispatch.meshes})`);
  check(afterDispatch.armed === false, "dispatch clears the armed flag once fired");

  check(errors.length === 0, `watcher scenario: no console errors (${errors.length} found)`);
  await page.close();

  // --- Hotseat: on the PRISONER's turn the bar must be empty, or the
  // prisoner's player reads the tower's readiness off a shared screen.
  const { page: p2, errs } = await (async () => {
    const errs = [];
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    p2.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    p2.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
    return { page: p2, errs };
  })();
  await startAs(p2, "#playHotseat");
  const hotseatTurn = await p2.evaluate(() => window.__opticon.game.turn);
  check(hotseatTurn === "Prisoner", "hotseat opens on the Prisoner's turn");
  await p2.waitForTimeout(300);
  const barHiddenForPrisoner = await p2.$eval("#skillBar", (el) => el.classList.contains("empty") && el.innerHTML === "");
  check(barHiddenForPrisoner, "skill bar is empty on the hotseat Prisoner's turn (no readiness leak)");

  check(errs.length === 0, `hotseat scenario: no console errors (${errs.length} found)`);
  errs.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ skills passed" : "\n✗ skills failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("SKILLS TEST FAILED:", e);
  process.exit(1);
});
