// pass-device.mjs — Headless check of the hotseat "pass the device" gate.
// A hotseat turn switch happens instantly in game state; without a gate, the
// OUTGOING player's screen would show the incoming player's privileged view
// (e.g. the Watcher's true gaze) before the physical handoff. This verifies
// the gate actually blocks the view switch until confirmed, on both turn
// directions (Prisoner -> Watcher and Watcher -> Prisoner).
// Run: node game/tests/pass-device.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8207;

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
  await page.click("#playHotseat");
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const isHidden = async (id) => page.$eval(`#${id}`, (el) => el.classList.contains("hidden"));

  check(await isHidden("passDevice"), "pass-device screen starts hidden (first player already holds it)");
  let viewMode = await page.evaluate(() => window.__opticon.viewMode);
  check(viewMode === "prisoner", `hotseat starts on Prisoner's view (got ${viewMode})`);

  // End the Prisoner's turn -> should gate on the pass screen, NOT switch
  // the camera/HUD to the Watcher's view yet.
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  check(!(await isHidden("passDevice")), "pass-device screen shows after Prisoner ends turn");
  let mode = await page.evaluate(() => window.__opticon.input.mode);
  check(mode === "pass", `input mode is 'pass' while gated (got ${mode})`);
  viewMode = await page.evaluate(() => window.__opticon.viewMode);
  check(viewMode === "prisoner", `view has NOT switched to watcher yet — still gated (got ${viewMode})`);
  let turn = await page.evaluate(() => window.__opticon.game.turn);
  check(turn === "Watcher", `game state already advanced to Watcher's turn underneath (got ${turn})`);
  const title = await page.$eval("#passDeviceTitle", (el) => el.textContent);
  check(/Watcher/.test(title), `pass screen names the correct incoming role (got "${title}")`);

  // Confirm (any key) -> now the view should switch.
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(200);
  check(await isHidden("passDevice"), "pass-device screen hides after confirm");
  viewMode = await page.evaluate(() => window.__opticon.viewMode);
  check(viewMode === "watcher", `view switches to watcher only after confirm (got ${viewMode})`);
  mode = await page.evaluate(() => window.__opticon.input.mode);
  check(mode === "game", `input mode returns to 'game' after confirm (got ${mode})`);

  // End the Watcher's turn (Space = scan & end) -> should gate again, this
  // time back toward the Prisoner, verifying the OTHER direction too.
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  const g2 = await page.evaluate(() => ({ over: window.__opticon.game.status !== "playing" }));
  if (!g2.over) {
    check(!(await isHidden("passDevice")), "pass-device screen shows after Watcher ends turn");
    const title2 = await page.$eval("#passDeviceTitle", (el) => el.textContent);
    check(/Prisoner/.test(title2), `pass screen names Prisoner on the return trip (got "${title2}")`);
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(200);
    viewMode = await page.evaluate(() => window.__opticon.viewMode);
    check(viewMode === "prisoner", `view switches back to prisoner after confirm (got ${viewMode})`);
  } else {
    console.log("  (game ended on round 1 grace scan — skipped return-trip check, not a failure)");
  }

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ pass-device passed" : "\n✗ pass-device failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("PASS-DEVICE TEST FAILED:", e);
  process.exit(1);
});
