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
const playwrightPath = process.env.PLAYWRIGHT_PATH || "/opt/node22/lib/node_modules/playwright";
const chromiumPath = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { chromium } = require(playwrightPath);

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

async function pollUntil(page, predicate, timeoutMs = 6000, arg) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

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

  // Inject a fake, mutable gamepad BEFORE navigation so pollGamepad() (rAF
  // driven, in main.js's loop()) picks it up from frame one.
  await page.addInitScript(() => {
    // Slot 0 is deliberately empty. Browsers retain slot identity across a
    // connection and reconnects/virtual pads commonly put the live device at
    // 1-3; production must discover it instead of assuming pads[0].
    window.__pad = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0], index: 2, id: "fake", connected: true, mapping: "standard", timestamp: 0 };
    navigator.getGamepads = () => [null, null, window.__pad, null];
    window.dispatchEvent(new Event("gamepadconnected"));
  });

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // Clear the intro splash with a genuine X-button hold (index 2), same as
  // hold-to-confirm.mjs, so the menu screen is what's under test.
  await page.evaluate(() => { window.__pad.buttons[2].pressed = true; });
  const menuOpened = await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"));
  await page.evaluate(() => { window.__pad.buttons[2].pressed = false; });
  check(menuOpened, "intro dismissed via gamepad X hold (setup)");

  // Press+release a single button edge (two poll frames apart).
  async function tap(i) {
    await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = true; }, i);
    const sawPress = await pollUntil(page, (idx) => !!window.__opticon.input.padPrev[idx], 1500, i);
    await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = false; }, i);
    const sawRelease = await pollUntil(page, (idx) => !window.__opticon.input.padPrev[idx], 1500, i);
    if (!sawPress || !sawRelease) throw new Error(`gamepad button ${i} was not polled through a full edge`);
  }
  const DOWN = 13, A = 0, START = 9;

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
  await tap(12); // dpad up, back toward the Start row
  const stillInGrid = await page.evaluate(() => !!document.querySelector("#menu .gpfocus"));
  check(stillInGrid, "dpad-up still moves focus back up the grid (no regression)");

  // We are now on the Start row. Menu confirm accepts both A and Start, so
  // the sustained hold must honor both too. Previously Start's edge could
  // focus/select controls but pollStartHold() watched only A, leaving the
  // player stranded on the final "Hold to Start" action.
  const focusedStart = await page.evaluate(() => document.querySelector("#menu .gpfocus")?.id === "btnStart");
  check(focusedStart, "dpad-up lands on the Hold to Start button");
  await tap(START);
  check(!(await page.evaluate(() => !!window.__opticon.game)), "a short Start-button tap does not launch the game");
  await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = true; }, START);
  const launchedWithStart = await pollUntil(page, () => !!window.__opticon.game, 1800);
  await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = false; }, START);
  check(launchedWithStart, "holding gamepad Start launches the game");

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
