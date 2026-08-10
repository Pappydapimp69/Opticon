// window-break.mjs — Headless check of the window-break UI wiring: keyboard
// Shift+direction and the touch break-toggle button, end to end through
// main.js (not just rules.js's breakWindow, already covered in
// logic.test.mjs). Run: node game/tests/window-break.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8213;

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

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  await page.click("#playPrisoner");
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());

  // Find two windows on the generated map, each with an adjacent floor tile.
  // startGame() picks a fresh random seed every time, so a single attempt
  // isn't reproducible — retry via a plain Restart click (unlike the initial
  // Start, Restart isn't hold-gated) until a seed with 2+ windows turns up,
  // rather than flaking whenever an unlucky seed has few/none.
  async function findWindows() {
    return page.evaluate(() => {
      const a = window.__opticon;
      const g = a.game;
      const m = g.map;
      const found = [];
      for (let y = 1; y < m.size - 1 && found.length < 2; y++) {
        for (let x = 1; x < m.size - 1 && found.length < 2; x++) {
          if (m.tiles[y][x] !== 1 /* TILE.WALL */ || m.objects[y][x] !== 2 /* OBJ.GLASS */) continue;
          const cands = [
            { fx: x, fy: y - 1, dir: 2, wx: x, wy: y },
            { fx: x, fy: y + 1, dir: 0, wx: x, wy: y },
            { fx: x - 1, fy: y, dir: 1, wx: x, wy: y },
            { fx: x + 1, fy: y, dir: 3, wx: x, wy: y },
          ];
          for (const c of cands) {
            if (m.tiles[c.fy] && m.tiles[c.fy][c.fx] === 0 /* TILE.FLOOR */) {
              found.push(c);
              break;
            }
          }
        }
      }
      return { count: found.length, found };
    });
  }

  let setup = await findWindows();
  for (let attempt = 0; attempt < 20 && setup.count < 2; attempt++) {
    await page.click("#btnRestart");
    await page.waitForTimeout(250);
    setup = await findWindows();
  }
  // Each Restart click re-enters startGame() → a fresh cutscene, re-arming
  // cutsceneActive — skip it once more so the break-window intents below
  // land as real actions, not as the cutscene's skip-on-any-control catch.
  await page.evaluate(() => window.__opticon.renderer.skipIntro());

  check(setup.count >= 1, `map has at least one usable window (found ${setup.count} after retries)`);
  if (setup.count < 1) {
    console.log("  (no window found on this seed — skipping remaining checks, not a failure of the feature itself)");
  } else {
    const w1 = setup.found[0];
    // Screen-relative, so ask the renderer which key currently points at a
    // given world cardinal rather than assuming W==North.
    const keyFor = (worldDir, from) => page.evaluate(([d, from]) => {
      const app = window.__opticon;
      for (let sd = 0; sd < 4; sd++) {
        if (app.renderer.screenDirToWorld(sd, from) === d) return ["KeyW", "KeyD", "KeyS", "KeyA"][sd];
      }
      return "KeyW";
    }, [worldDir, from]);

    // --- Keyboard: Shift+direction breaks it.
    await page.evaluate((c) => {
      const a = window.__opticon;
      const p = a.game.prisoners[0];
      p.x = c.fx; p.y = c.fy; p.startTurnPos = { x: c.fx, y: c.fy };
    }, w1);
    await page.waitForTimeout(100);
    await page.keyboard.down("ShiftLeft");
    await page.keyboard.press(await keyFor(w1.dir, { x: w1.fx, y: w1.fy }));
    await page.keyboard.up("ShiftLeft");
    await page.waitForTimeout(150);
    let broken = await page.evaluate((c) => {
      const g = window.__opticon.game;
      return g.brokenWindows.has(c.wy * g.map.size + c.wx);
    }, w1);
    check(broken, "Shift+direction breaks the window it faces");
    let stillAtSpot = await page.evaluate((c) => {
      const p = window.__opticon.game.prisoners[0];
      return p.x === c.fx && p.y === c.fy;
    }, w1);
    check(stillAtSpot, "breaking via keyboard does not move the prisoner");

    if (setup.count >= 2) {
      const w2 = setup.found[1];
      // --- Touch: arm via the break-toggle, then tap a direction.
      await page.evaluate((c) => {
        const a = window.__opticon;
        const p = a.game.prisoners[0];
        p.x = c.fx; p.y = c.fy; p.startTurnPos = { x: c.fx, y: c.fy };
        p.mp = 3;
      }, w2);
      await page.waitForTimeout(100);
      await page.click("#breakToggle");
      await page.waitForTimeout(100);
      const armedClass = await page.$eval("#breakToggle", (el) => el.classList.contains("armed"));
      check(armedClass, "break-toggle shows an armed visual state after tapping it");

      const dirSelector = ["up", "right", "down", "left"][w2.dir];
      await page.click(`.dpad .${dirSelector}`);
      await page.waitForTimeout(150);
      broken = await page.evaluate((c) => {
        const g = window.__opticon.game;
        return g.brokenWindows.has(c.wy * g.map.size + c.wx);
      }, w2);
      check(broken, "arming via touch toggle then tapping a direction breaks that window");
      const stillArmed = await page.$eval("#breakToggle", (el) => el.classList.contains("armed"));
      check(!stillArmed, "break-toggle disarms itself after one use");
    } else {
      console.log("  (only one window on this seed — skipped the touch-toggle check, not a failure)");
    }
  }

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ window-break passed" : "\n✗ window-break failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("WINDOW-BREAK TEST FAILED:", e);
  process.exit(1);
});
