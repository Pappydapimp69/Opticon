// turn-authority-hud.mjs — The hint bar and touch D-pad panels must teach/show
// controls for whoever is actually acting RIGHT NOW, not just whoever's turn
// it nominally is. `game.turn` says WHICH role is acting, but during an AI
// opponent's turn (or an AI companion's own turn within a human-Prisoner
// group) the human doesn't control it — showing that role's move
// instructions and D-pad there is a distinct bug from any information leak
// (shouldShowWatcherInfo already covers that): it's control-teaching drift,
// not secrecy drift. Caught via live QA screenshot as a human Watcher.
// Run: node game/tests/turn-authority-hud.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8320;
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

async function start(page, role, diff) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  await page.click(`[data-diff="${diff}"]`);
  await page.waitForTimeout(150);
  await page.click(role === "Prisoner" ? "#playPrisoner" : "#playWatcher");
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await page.waitForTimeout(400);
}

const snap = (page) =>
  page.evaluate(() => ({
    turn: window.__opticon.game.turn,
    activePrisoner: window.__opticon.game.activePrisoner,
    hint: document.getElementById("hint")?.textContent || "",
    prisonerActive: document.getElementById("prisonerControls")?.classList.contains("active"),
    watcherActive: document.getElementById("watcherControls")?.classList.contains("active"),
  }));

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

  // --- Human Watcher: the game opens mid the AI Prisoner's own turn.
  await start(page, "Watcher", "hard");
  const s1 = await snap(page);
  check(s1.turn === "Prisoner", `caught mid AI-Prisoner turn (got "${s1.turn}")`);
  check(!/plan a path|break a window|reach the green gate/i.test(s1.hint),
    "Watcher: hint bar does not show Prisoner move instructions during the AI's turn");
  check(/watching/i.test(s1.hint), `Watcher: neutral watching hint shown (got "${s1.hint}")`);
  check(!s1.prisonerActive && !s1.watcherActive, "Watcher: neither touch panel active during the AI's turn");

  await page.waitForFunction(() => window.__opticon.game.turn === "Watcher", { timeout: 15000 });
  await page.waitForTimeout(200);
  const s2 = await snap(page);
  check(s2.watcherActive && !s2.prisonerActive, "Watcher: Watcher panel active on the human's own turn");
  check(!/watching/i.test(s2.hint), `Watcher: real controls hint restored (got "${s2.hint}")`);

  // --- Human Prisoner with AI companions (hard difficulty spawns 3): an AI
  // companion's own turn (activePrisoner > 0) must be treated the same as an
  // AI opponent's turn, even though `game.turn` still says "Prisoner" and the
  // human DOES play that role.
  await start(page, "Prisoner", "hard");
  const s3 = await snap(page);
  check(s3.activePrisoner === 0, "Prisoner: opens on the human's own prisoner (index 0)");
  check(s3.prisonerActive, "Prisoner: Prisoner panel active on the human's own turn");
  check(!/watching/i.test(s3.hint), `Prisoner: real move hint shown (got "${s3.hint}")`);

  await page.keyboard.press("Space"); // end the human's own prisoner turn
  await page.waitForFunction(
    () => window.__opticon.game.turn === "Prisoner" && window.__opticon.game.activePrisoner === 1,
    { timeout: 15000 }
  );
  const s4 = await snap(page);
  check(!s4.prisonerActive && !s4.watcherActive, "Prisoner: no panel active during an AI companion's own turn");
  check(/watching/i.test(s4.hint), `Prisoner: neutral watching hint during AI companion's turn (got "${s4.hint}")`);

  await page.waitForFunction(
    () => window.__opticon.game.turn === "Prisoner" && window.__opticon.game.activePrisoner === 0,
    { timeout: 20000 }
  );
  await page.waitForTimeout(200);
  const s5 = await snap(page);
  check(s5.prisonerActive, "Prisoner: Prisoner panel active again once control cycles back to the human");
  check(!/watching/i.test(s5.hint), `Prisoner: real move hint restored (got "${s5.hint}")`);

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ turn-authority-hud passed" : "\n✗ turn-authority-hud failed");
  process.exit(ok ? 0 : 1);
})();
