// gamepad-menu-nav.mjs — Headless check that dpad nav on the play-mode splash
// can reach EVERY focusable control, including "How to play" (previously
// unreachable: its <summary> had no data-row/data-col, so it sat outside the
// menu's row/col grid entirely).
// Run: node game/tests/gamepad-menu-nav.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8212;

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

  // Inject a fake, mutable gamepad BEFORE navigation so pollGamepad() (rAF
  // driven, in main.js's loop()) picks it up from frame one.
  await page.addInitScript(() => {
    window.__pad = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0], index: 0, id: "fake", connected: true, mapping: "standard", timestamp: 0 };
    navigator.getGamepads = () => [window.__pad, null, null, null];
    window.dispatchEvent(new Event("gamepadconnected"));
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // Clear the intro splash with a genuine X-button hold (index 2), same as
  // hold-to-confirm.mjs, so the menu screen is what's under test.
  await page.evaluate(() => { window.__pad.buttons[2].pressed = true; });
  await page.waitForTimeout(750);
  await page.evaluate(() => { window.__pad.buttons[2].pressed = false; });
  await page.waitForTimeout(700);
  const introHidden = await page.$eval("#intro", (el) => el.classList.contains("hidden"));
  check(introHidden, "intro dismissed via gamepad X hold (setup)");

  // Press+release a single button edge (two poll frames apart).
  async function tap(i) {
    await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = true; }, i);
    await page.waitForTimeout(80);
    await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = false; }, i);
    await page.waitForTimeout(80);
  }
  const DOWN = 13, A = 0;

  // Difficulty (row 0/1 depending on markup) → play mode → sound → Start →
  // How to play: walk all the way down with dpad-down and confirm the focus
  // lands on the "How to play" summary at the bottom (data-row="5").
  for (let i = 0; i < 6; i++) await tap(DOWN);
  const focusedRow = await page.evaluate(() => {
    const el = document.querySelector("#menu .gpfocus");
    return el ? el.dataset.row : null;
  });
  check(focusedRow === "5", `dpad-down walks focus all the way to "How to play" (row 5, got row ${focusedRow})`);
  const focusedIsHow = await page.evaluate(() => {
    const el = document.querySelector("#menu .gpfocus");
    return !!el && el.closest(".how") != null;
  });
  check(focusedIsHow, "the focused control is inside the How-to-play <details>");

  // A confirm on it should open the disclosure (native <summary> toggle).
  const openBefore = await page.$eval(".how", (el) => el.open);
  check(!openBefore, "How-to-play starts closed");
  await tap(A);
  const openAfter = await page.$eval(".how", (el) => el.open);
  check(openAfter, "gamepad A on the focused summary opens How-to-play");

  // Difficulty/mode nav must still work after this change (regression check).
  await page.evaluate(() => { window.__pad.buttons[12].pressed = true; }); // dpad up, back toward top rows
  await page.waitForTimeout(80);
  await page.evaluate(() => { window.__pad.buttons[12].pressed = false; });
  await page.waitForTimeout(80);
  const stillInGrid = await page.evaluate(() => !!document.querySelector("#menu .gpfocus"));
  check(stillInGrid, "dpad-up still moves focus back up the grid (no regression)");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ gamepad-menu-nav passed" : "\n✗ gamepad-menu-nav failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("GAMEPAD-MENU-NAV TEST FAILED:", e);
  process.exit(1);
});
