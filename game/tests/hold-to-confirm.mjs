// hold-to-confirm.mjs — Headless check that the intro splash and the menu's
// Start button both require an actual HOLD (>=650ms), not a tap/click. A
// short press must be a no-op; only a sustained hold crossing the threshold
// dismisses the intro or launches the game.
// Run: node game/tests/hold-to-confirm.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8211;

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

  const introHidden = () => page.$eval("#intro", (el) => el.classList.contains("hidden"));

  // A brief tap of Space must NOT dismiss the intro.
  await page.keyboard.down("Space");
  await page.waitForTimeout(150);
  await page.keyboard.up("Space");
  await page.waitForTimeout(150);
  check(!(await introHidden()), "a short Space tap does NOT dismiss the intro");

  // Releasing early resets progress — holding again from 0 for only 400ms
  // (short of the 650ms threshold) must still not dismiss it.
  await page.keyboard.down("Space");
  await page.waitForTimeout(400);
  await page.keyboard.up("Space");
  await page.waitForTimeout(150);
  check(!(await introHidden()), "release-before-threshold resets progress (still not dismissed)");

  // A genuine hold past the threshold dismisses it. dismissIntro() adds the
  // 'hidden' class only after its 520ms fadeout, so wait past that too.
  await page.keyboard.down("Space");
  await page.waitForTimeout(750);
  await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  check(await introHidden(), "a full hold past the threshold dismisses the intro");

  // Menu: selecting a play mode must NOT start the game immediately.
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(100);
  await page.click("#playPrisoner");
  await page.waitForTimeout(200);
  let gameExists = await page.evaluate(() => !!window.__opticon.game);
  check(!gameExists, "selecting a play mode does not start the game immediately");
  const startLabel = await page.$eval("#startLabel", (el) => el.textContent);
  check(/Prisoner/.test(startLabel), `Start button reflects the selected mode (got "${startLabel}")`);
  const menuHidden = await page.$eval("#menu", (el) => el.classList.contains("hidden"));
  check(!menuHidden, "menu stays open after selecting a play mode (no auto-start)");

  // A brief tap-hold of the Start button (short of threshold) must not start it.
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(150);
  gameExists = await page.evaluate(() => !!window.__opticon.game);
  check(!gameExists, "a short Start-button press does NOT launch the game");

  // A full hold does start it.
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(300);
  gameExists = await page.evaluate(() => !!window.__opticon.game);
  check(gameExists, "a full Start-button hold launches the game");
  const running = await page.evaluate(() => window.__opticon.running);
  check(running === true, "game is running after the hold completes");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ hold-to-confirm passed" : "\n✗ hold-to-confirm failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("HOLD-TO-CONFIRM TEST FAILED:", e);
  process.exit(1);
});
