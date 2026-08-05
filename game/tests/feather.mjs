// feather.mjs — The Golden Feather: one round of true sight of the eye.
//
// Every other prisoner item acts on the world (noise, light, doors, your own
// footsteps). This one acts on the information asymmetry itself, which is the
// only thing the panopticon actually runs on — so the assertions that matter
// are about WHO learns WHAT, not about a number changing:
//   * a Prisoner normally sees "?" for Gaze, and the true facing after use;
//   * it reveals the FACING ONLY — not the bluff, not skill readiness, not
//     the suspicion read, all of which remain Watcher-only;
//   * it expires with the round rather than lasting the game;
//   * it is one-use and cannot be double-spent.
// Run: node game/tests/feather.mjs
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
const PORT = 8236;
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

async function pollUntil(page, predicate, timeoutMs = 15000, arg) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

const DIRS = ["North", "East", "South", "West"];

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));

  // ---- Pure-rules half: no browser needed, so failures here are unambiguous.
  const map = await import("../src/map.js");
  const rules = await import("../src/rules.js");
  {
    const m = map.generateMap(4242, { ...map.MAP_DEFAULTS, prisonerCount: 1 });
    const g = rules.createGame(m, { prisoners: m.spawns });
    const p = g.prisoners[0];
    p.items = [map.ITEM_KINDS.FEATHER];
    g.watcher.facing = 2;

    check(g.gazeRevealedForRound === null, "a fresh game reveals nothing");
    const r = rules.useItem(g, map.ITEM_KINDS.FEATHER, null);
    check(r.ok && r.event === "feather" && r.facing === 2,
      `using it reports the true facing (${JSON.stringify(r)})`);
    check(g.gazeRevealedForRound === g.round, "the reveal is stamped with the current round");
    check(p.items.length === 0, "the feather is consumed");
    check(!rules.useItem(g, map.ITEM_KINDS.FEATHER, null).ok, "it cannot be spent twice");

    // Expiry by comparison, not by something remembering to clear a flag.
    const wasRound = g.round;
    g.round += 1;
    check(g.gazeRevealedForRound !== g.round,
      `the reveal expires when the round advances (${wasRound} -> ${g.round})`);

    // It must not move the capture rule at all — sight, not safety.
    const g2 = rules.createGame(m, { prisoners: m.spawns });
    const before = rules.isExposed(g2, g2.prisoners[0].x, g2.prisoners[0].y, "medium");
    g2.prisoners[0].items = [map.ITEM_KINDS.FEATHER];
    rules.useItem(g2, map.ITEM_KINDS.FEATHER, null);
    const after = rules.isExposed(g2, g2.prisoners[0].x, g2.prisoners[0].y, "medium");
    check(before === after, "it changes what you KNOW, not whether you can be caught");
  }

  // The item must actually be reachable in play, or it is decoration.
  {
    let seen = 0, maps = 0;
    for (let i = 0; i < 40; i++) {
      const m = map.generateMap((i * 2654435761) >>> 0 || 1, { ...map.MAP_DEFAULTS, prisonerCount: 3 });
      maps++;
      if ((m.items || []).some((it) => it.kind === map.ITEM_KINDS.FEATHER)) seen++;
    }
    check(seen > 0, `the feather actually spawns on generated maps (${seen}/${maps})`);
  }

  // ---- Browser half: the reveal has to reach the screen, and only the screen
  // it is meant for.
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.keyboard.down("Space");
  await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"), 8000);
  await page.keyboard.up("Space");
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(100);
  await page.click("#playPrisoner");
  await page.waitForTimeout(100);
  await page.hover("#btnStart");
  await page.mouse.down();
  await pollUntil(page, () => !!window.__opticon?.game, 8000);
  await page.mouse.up();
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await pollUntil(page, () => document.getElementById("turnLabel").textContent.trim().startsWith("Prisoner 1/"));
  await page.waitForTimeout(400);

  const gazeText = () => page.evaluate(() => document.getElementById("facingLabel").textContent.trim());
  const gazeShown = () => page.evaluate(() =>
    !document.getElementById("gazeStat").classList.contains("hidden"));

  check(!(await gazeShown()), "a Prisoner is shown no Gaze readout to begin with");

  // Hand the human's own prisoner a feather and spend it through the real UI.
  await page.evaluate(async () => {
    const m = await import("./src/map.js");
    const g = window.__opticon.game;
    g.watcher.facing = 1; // East
    g.prisoners[0].items = [m.ITEM_KINDS.FEATHER];
  });
  await page.waitForTimeout(300);
  await page.keyboard.press("Digit1"); // use item in slot 1
  await page.waitForTimeout(400);

  check(await gazeShown(), "spending the feather reveals the Gaze readout");
  const shown = await gazeText();
  check(shown.startsWith("East"), `it shows the TRUE facing (got ${JSON.stringify(shown)})`);
  check(/🪶/.test(shown), "the reading is marked as feather-bought, not permanent sight");

  // The narrow gate: facing only. Everything else stays Watcher-only.
  const leak = await page.evaluate(() => ({
    watcherInfo: window.__opticon.game.watcher.bluff,
    skillBarEmpty: document.getElementById("skillBar").classList.contains("empty"),
    suspicionEmpty: document.getElementById("suspicionHud").classList.contains("empty"),
  }));
  check(leak.skillBarEmpty, "the Watcher's skill readiness stays hidden");
  check(leak.suspicionEmpty, "the Watcher's suspicion read stays hidden");

  // And it lapses — driven by an actual turn cycle, not by poking `round`.
  // The HUD is redrawn on game events, so mutating state directly would test
  // the stale DOM rather than the expiry.
  const roundBefore = await page.evaluate(() => window.__opticon.game.round);
  await page.keyboard.press("Space"); // end turn -> Watcher acts -> round advances
  await pollUntil(page, (r) => window.__opticon.game.round > r, 20000, roundBefore);
  await pollUntil(page, () =>
    document.getElementById("turnLabel").textContent.trim().startsWith("Prisoner 1/"), 20000);
  await page.waitForTimeout(400);
  const roundAfter = await page.evaluate(() => window.__opticon.game.round);
  check(roundAfter > roundBefore, `a real turn cycle advanced the round (${roundBefore} -> ${roundAfter})`);
  check(!(await gazeShown()), "the reveal lapses once the round moves on");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ feather passed" : "\n✗ feather failed");
  process.exit(ok ? 0 : 1);
})();
