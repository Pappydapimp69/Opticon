// record.mjs — The per-role, per-difficulty win/loss record: it must count
// each finished game EXACTLY once (checkOver() has four call sites and the
// `running` flag does not stop the later ones re-entering while isOver() is
// still true), attribute the result to the human's own side, keep the tiers
// separate, survive a reload, and never record a hotseat game (two humans,
// no personal record to own).
// Run: node game/tests/record.mjs
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
const PORT = 8232;
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

async function pollUntil(page, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function start(page, role, diff) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.keyboard.down("Space");
  const menuOpened = await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"));
  await page.keyboard.up("Space");
  if (!menuOpened) throw new Error("intro hold did not open the menu");
  await page.click(`[data-diff="${diff}"]`);
  await page.waitForTimeout(100);
  await page.click(role === "Prisoner" ? "#playPrisoner" : role === "Watcher" ? "#playWatcher" : "#playHotseat");
  await page.waitForTimeout(100);
  await page.hover("#btnStart");
  await page.mouse.down();
  const started = await pollUntil(page, () => !!window.__opticon?.game);
  await page.mouse.up();
  if (!started) throw new Error("Start hold did not create a game");
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await page.waitForTimeout(250);
}

// End the game the way the GAME ends it, not by poking status and hoping.
// checkOver() runs on the avatar's arrival and on the AI/turn-handoff loops —
// never while idling on the human's own turn — so a forced `escaped = true`
// mid-turn would leave the game running and silently record nothing.
async function finishAs(page, winner) {
  // Both endings below are driven by the human pressing a key, so wait for a
  // turn the human actually controls — a Watcher game opens mid AI-prisoner
  // turn, where every keypress is correctly ignored.
  await pollUntil(page, () => {
    const label = document.getElementById("turnLabel")?.textContent.trim() || "";
    return window.__opticon.config.humanRole === "Watcher"
      ? label === "Watcher"
      : label.startsWith("Prisoner 1/") || label === "Prisoner";
  }, 15000);

  if (winner === "Prisoner") {
    // Stand next to the gate, then walk onto it for real: the escape fires
    // when the avatar visibly arrives, which is the path that ends the game.
    // Arrow keys are SCREEN directions now, not compass bearings (the camera
    // orbits, so up is the top of the map as drawn). This used to press
    // `["ArrowUp","ArrowRight",...][worldDir]` and walk somewhere that was not
    // the gate. Ask the game's own resolver which screen direction currently
    // lands on the world direction we need.
    const worldDir = await page.evaluate(() => {
      const app = window.__opticon;
      const g = app.game;
      const p = g.prisoners[0];
      const e = g.map.exit;
      const D = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W
      for (let d = 0; d < 4; d++) {
        const sx = e.x - D[d][0], sy = e.y - D[d][1];
        if (sx < 0 || sy < 0 || sx >= g.map.size || sy >= g.map.size) continue;
        p.x = sx; p.y = sy; p.mp = p.mpMax || 3;
        return d; // WORLD direction; the screen key is resolved after the camera settles
      }
      return -1;
    });
    // Same camera-settle the wincheck harness needs: the teleport above moves
    // the prisoner across the map, and until the rig eases onto its new target
    // `screenDirToWorld` is projecting the new tile through a camera still
    // framing the old one, which can resolve a direction to the wrong key.
    // This test happened to pass without it; that was luck, not correctness.
    await page.evaluate(() => {
      const a = window.__opticon;
      for (let i = 0; i < 240; i++) a.renderer.updateCamera(a.game, a.game.prisoners[0], 0.1);
    });
    const sd = await page.evaluate((d) => {
      const app = window.__opticon;
      const p = app.game.prisoners[0];
      for (let s = 0; s < 4; s++) {
        if (app.renderer.screenDirToWorld(s, { x: p.x, y: p.y }) === d) return s;
      }
      return -1;
    }, worldDir);
    await page.keyboard.press(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"][sd >= 0 ? sd : worldDir]);
    await page.waitForTimeout(120);
    await page.keyboard.press("Space"); // commit the move onto the gate
  } else {
    // Down the prisoners but leave `status` alone, then end the turn for
    // real: rules.js's own checkEndConditions() is what declares the capture,
    // and the turn handoff is what reaches checkOver(). Writing `status`
    // directly instead would make isOver() true immediately, and handleIntent
    // bails on an already-over game — so the end-of-game path would never run.
    await page.evaluate(() => {
      window.__opticon.game.prisoners.forEach((p) => { p.alive = false; p.escaped = false; });
    });
    await page.keyboard.press("Space"); // end turn -> handoff -> end conditions
  }
  await pollUntil(page, () => !document.getElementById("overlay").classList.contains("hidden"), 12000);
  await page.waitForTimeout(200);
}

const readRecord = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("opticon.record.v1") || "null"));

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

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.evaluate(() => localStorage.removeItem("opticon.record.v1"));

  // --- A win as Prisoner counts once, in that role and tier only.
  await start(page, "Prisoner", "medium");
  await finishAs(page, "Prisoner");
  let rec = await readRecord(page);
  check(rec?.Prisoner?.medium?.won === 1, `a Prisoner win records one win (got ${JSON.stringify(rec?.Prisoner?.medium)})`);
  check(rec?.Prisoner?.medium?.lost === 0, "a win does not also record a loss");
  check(rec?.Watcher?.medium?.won === 0 && rec?.Prisoner?.easy?.won === 0,
    "the win lands only in the played role and difficulty");

  const overlayText = await page.$eval("#overlayText", (el) => el.textContent);
  check(/1W/.test(overlayText), `the game-over screen shows the running record (got ${JSON.stringify(overlayText)})`);

  // --- Losing the same role/tier increments only the loss side.
  await start(page, "Prisoner", "medium");
  await finishAs(page, "Watcher");
  rec = await readRecord(page);
  check(rec?.Prisoner?.medium?.won === 1 && rec?.Prisoner?.medium?.lost === 1,
    `a Prisoner loss records one loss (got ${JSON.stringify(rec?.Prisoner?.medium)})`);

  // --- As Watcher, the SAME winner value is now the human's own win.
  await start(page, "Watcher", "medium");
  await finishAs(page, "Watcher");
  rec = await readRecord(page);
  check(rec?.Watcher?.medium?.won === 1 && rec?.Watcher?.medium?.lost === 0,
    `a Watcher win is credited to the Watcher (got ${JSON.stringify(rec?.Watcher?.medium)})`);
  check(rec?.Prisoner?.medium?.lost === 1, "the Watcher's win did not also touch the Prisoner record");

  // --- Difficulty tiers stay separate.
  await start(page, "Watcher", "hard");
  await finishAs(page, "Watcher");
  rec = await readRecord(page);
  check(rec?.Watcher?.hard?.won === 1 && rec?.Watcher?.medium?.won === 1,
    `hard and medium are tracked separately (got hard=${JSON.stringify(rec?.Watcher?.hard)})`);

  // --- Hotseat is two humans: nothing is recorded for either role.
  const before = JSON.stringify(await readRecord(page));
  await start(page, "Hotseat", "medium");
  await finishAs(page, "Watcher");
  const after = JSON.stringify(await readRecord(page));
  check(before === after, "a hotseat game records nothing");

  // --- The menu shows the record for the SELECTED difficulty, and follows it.
  // Reload to the menu rather than clicking through: the hotseat leg above
  // ends behind the pass-device screen, which deliberately blocks every
  // control under it. The record lives in localStorage, so a reload keeps it.
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.keyboard.down("Space");
  await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"));
  await page.keyboard.up("Space");
  await page.waitForTimeout(250);
  await page.click('[data-diff="hard"]');
  await page.waitForTimeout(200);
  const hardLine = await page.$eval("#recordWatcher", (el) => el.textContent);
  await page.click('[data-diff="easy"]');
  await page.waitForTimeout(200);
  const easyLine = await page.$eval("#recordWatcher", (el) => el.textContent);
  check(/1W/.test(hardLine), `menu shows the hard record on hard (got ${JSON.stringify(hardLine)})`);
  check(/no runs yet/.test(easyLine), `menu shows an untouched tier as empty (got ${JSON.stringify(easyLine)})`);

  // --- It survives a reload (this is the whole point of persisting it).
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const reloaded = await readRecord(page);
  check(reloaded?.Watcher?.hard?.won === 1, "the record survives a page reload");

  // --- Corrupt storage degrades to a fresh record instead of breaking boot.
  await page.evaluate(() => localStorage.setItem("opticon.record.v1", "{not json"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const booted = await page.evaluate(() => !!window.__opticon);
  check(booted, "corrupt record storage still boots the game");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ record passed" : "\n✗ record failed");
  process.exit(ok ? 0 : 1);
})();
