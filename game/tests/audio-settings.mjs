// audio-settings.mjs — Headless check of the volume menu buttons, the HUD
// mute toggle, and localStorage persistence across a reload.
// Run: node game/tests/audio-settings.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8201;

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
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space"); // hold to dismiss intro -> menu
  await page.waitForTimeout(500);

  // Default volume is Full (1) until the player touches the menu.
  const initialVol = await page.evaluate(() => window.__opticon.audio.volume);
  check(initialVol === 1, `default volume is Full (got ${initialVol})`);

  // Click "Low" in the Sound row.
  await page.click('[data-vol="0.35"]');
  await page.waitForTimeout(100);
  let vol = await page.evaluate(() => window.__opticon.audio.volume);
  check(Math.abs(vol - 0.35) < 1e-6, `menu click sets volume to Low (got ${vol})`);
  let selClass = await page.$eval('[data-vol="0.35"]', (el) => el.classList.contains("sel"));
  check(selClass, "Low button shows selected state");

  // Start a game, then use the HUD mute toggle.
  await page.click("#playPrisoner");
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.click("#btnSound");
  await page.waitForTimeout(100);
  vol = await page.evaluate(() => window.__opticon.audio.volume);
  check(vol === 0, `HUD mute toggle silences audio (got ${vol})`);
  let icon = await page.$eval("#btnSound", (el) => el.textContent);
  check(icon === "🔇", `HUD mute icon shows muted (got ${icon})`);

  await page.click("#btnSound"); // unmute
  await page.waitForTimeout(100);
  vol = await page.evaluate(() => window.__opticon.audio.volume);
  check(Math.abs(vol - 0.35) < 1e-6, `HUD unmute restores prior volume (got ${vol})`);

  // Persistence: difficulty + volume should survive a reload.
  await page.click("#btnMenu");
  await page.waitForTimeout(200);
  await page.click('[data-diff="hard"]');
  await page.waitForTimeout(100);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => window.__opticon.config.difficulty);
  const restoredVol = await page.evaluate(() => window.__opticon.audio.volume);
  check(restored === "hard", `difficulty persists across reload (got ${restored})`);
  check(Math.abs(restoredVol - 0.35) < 1e-6, `volume persists across reload (got ${restoredVol})`);

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ audio-settings passed" : "\n✗ audio-settings failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("AUDIO-SETTINGS TEST FAILED:", e);
  process.exit(1);
});
