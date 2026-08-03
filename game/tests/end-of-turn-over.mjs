// end-of-turn-over.mjs — A game that ENDS on a human's own end-turn must
// still show the result screen.
//
// The human end-turn paths called checkOver() *before* endWatcherTurn() /
// endPrisonerTurn() — but those are the calls that advance the round (which
// trips ROUND_LIMIT) and run the rules' own end-condition check. So a human
// Watcher who ended the turn that hit the round limit reached
// `status: "captured", timedOut: true` with no overlay, no result, and no
// recorded W/L: a finished game that just sat there looking playable.
// Run: node game/tests/end-of-turn-over.mjs
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
const PORT = 8233;
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

async function pollUntil(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function start(page, role) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.keyboard.down("Space");
  const opened = await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"));
  await page.keyboard.up("Space");
  if (!opened) throw new Error("intro hold did not open the menu");
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(100);
  await page.click(role === "Watcher" ? "#playWatcher" : "#playPrisoner");
  await page.waitForTimeout(100);
  await page.hover("#btnStart");
  await page.mouse.down();
  const started = await pollUntil(page, () => !!window.__opticon?.game);
  await page.mouse.up();
  if (!started) throw new Error("Start hold did not create a game");
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await page.waitForTimeout(250);
}

const ROUND_LIMIT = 90;

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

  // --- Human Watcher, ending the turn that hits the round limit.
  await start(page, "Watcher");
  await pollUntil(page, () => document.getElementById("turnLabel")?.textContent.trim() === "Watcher", 15000);
  await page.evaluate((limit) => { window.__opticon.game.round = limit; }, ROUND_LIMIT);
  await page.keyboard.press("Space"); // scan & end turn -> round 91 -> time up

  const shown = await pollUntil(page, () => !document.getElementById("overlay").classList.contains("hidden"), 8000);
  const state = await page.evaluate(() => ({
    status: window.__opticon.game.status,
    timedOut: !!window.__opticon.game.timedOut,
    title: document.getElementById("overlayTitle").textContent,
    text: document.getElementById("overlayText").textContent,
  }));
  check(state.timedOut, `the rules did flag a timeout (so this test has teeth) — status ${state.status}`);
  check(shown, "the result screen appears when the round limit ends a human Watcher's turn");
  check(state.title === "TIME UP", `the result names the timeout (got "${state.title}")`);
  check(/Watcher on medium/.test(state.text), `a timed-out game still records a result (got ${JSON.stringify(state.text)})`);

  // --- The overlay's own controls must work from that state.
  await page.click("#btnRestart2");
  await page.waitForTimeout(600);
  const restarted = await page.evaluate(() => ({
    status: window.__opticon.game.status,
    round: window.__opticon.game.round,
    overlayHidden: document.getElementById("overlay").classList.contains("hidden"),
  }));
  check(restarted.status === "playing" && restarted.round === 1,
    `Play again works from a timed-out game (got ${JSON.stringify(restarted)})`);
  check(restarted.overlayHidden, "the overlay clears on Play again");

  // --- A human Prisoner's own end-turn must reach the same check.
  await start(page, "Prisoner");
  await pollUntil(page, () => document.getElementById("turnLabel")?.textContent.trim().startsWith("Prisoner 1/"), 15000);
  await page.evaluate((limit) => {
    // Round-limit the game AND leave the human's own prisoner as the last one
    // standing, so ending this turn is what closes the game out.
    const g = window.__opticon.game;
    g.round = limit;
    g.prisoners.forEach((p, i) => { if (i > 0) p.alive = false; });
  }, ROUND_LIMIT);
  await page.keyboard.press("Space");
  const shown2 = await pollUntil(page, () => !document.getElementById("overlay").classList.contains("hidden"), 10000);
  check(shown2, "the result screen appears when a human Prisoner's end-turn ends the game");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ end-of-turn-over passed" : "\n✗ end-of-turn-over failed");
  process.exit(ok ? 0 : 1);
})();
