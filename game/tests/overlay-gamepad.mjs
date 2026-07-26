// overlay-gamepad.mjs — Headless check that the game-over overlay's buttons
// are reachable by gamepad. input.mode never changed when the overlay
// appeared, so a gamepad press fired stale "game" intents into an already-
// ended game instead of navigating "Play again" / "Main menu".
// Run: node game/tests/overlay-gamepad.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8216;

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

  await page.addInitScript(() => {
    window.__pad = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0], index: 0, id: "fake", connected: true, mapping: "standard", timestamp: 0 };
    navigator.getGamepads = () => [window.__pad, null, null, null];
    window.dispatchEvent(new Event("gamepadconnected"));
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click("#playPrisoner");
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());

  // Teleport the prisoner adjacent to the exit, facing it, then actually
  // step in (same pattern as wincheck.mjs) — checkOver() only fires from the
  // real move-resolution/walk-animation path, not from a raw state mutation.
  const dir = await page.evaluate(() => {
    const a = window.__opticon, g = a.game, m = g.map, p = g.prisoners[0];
    const ex = m.exit;
    const N = [[0, -1, 0], [1, 0, 1], [0, 1, 2], [-1, 0, 3]];
    for (const [dx, dy, toExitDir] of N) {
      const nx = ex.x - dx, ny = ex.y - dy;
      if (m.tiles[ny] && m.tiles[ny][nx] === 0) {
        p.x = nx; p.y = ny; p.startTurnPos = { x: nx, y: ny }; p.mp = 3; g.turn = "Prisoner";
        return toExitDir;
      }
    }
    return -1;
  });
  const keyByDir = ["KeyW", "KeyD", "KeyS", "KeyA"];
  if (dir >= 0) {
    await page.keyboard.press(keyByDir[dir]);
    await page.waitForTimeout(200);
    await page.keyboard.press("Space");
  }
  let overlayVisible = false;
  for (let i = 0; i < 40; i++) {
    overlayVisible = await page.$eval("#overlay", (el) => !el.classList.contains("hidden"));
    if (overlayVisible) break;
    await page.waitForTimeout(150);
  }
  check(dir >= 0, "found a walkable exit-adjacent tile to drive a real escape");
  {
    check(overlayVisible, "game-over overlay is visible");
    const inputMode = await page.evaluate(() => window.__opticon.input.mode);
    check(inputMode === "overlay", `input.mode switches to 'overlay' when it appears (got '${inputMode}')`);

    const focusedRow0 = await page.evaluate(() => document.querySelector("#overlay .gpfocus")?.dataset.row);
    check(focusedRow0 === "0", "overlay buttons are gamepad-focusable (initial focus set)");

    // dpad-right moves focus from Play-again to Main-menu.
    await page.evaluate(() => { window.__pad.buttons[15].pressed = true; });
    await page.waitForTimeout(80);
    await page.evaluate(() => { window.__pad.buttons[15].pressed = false; });
    await page.waitForTimeout(80);
    const focusedIsMenu = await page.evaluate(() => document.querySelector("#overlay .gpfocus")?.id !== "btnRestart2");
    check(focusedIsMenu, "dpad-right moves focus to Main menu on the overlay");

    // A confirms — should return to the menu screen.
    await page.evaluate(() => { window.__pad.buttons[0].pressed = true; });
    await page.waitForTimeout(80);
    await page.evaluate(() => { window.__pad.buttons[0].pressed = false; });
    await page.waitForTimeout(150);
    const menuVisible = await page.$eval("#menu", (el) => !el.classList.contains("hidden"));
    check(menuVisible, "gamepad A on Main menu returns to the menu screen");
  }

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ overlay-gamepad passed" : "\n✗ overlay-gamepad failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("OVERLAY-GAMEPAD TEST FAILED:", e);
  process.exit(1);
});
