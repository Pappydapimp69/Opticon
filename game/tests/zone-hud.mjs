// zone-hud.mjs — Headless check of the Zone readout: it must tell a human
// PRISONER which quadrant they are standing in (so the public "guards
// dispatched to the North quadrant" message is resolvable at all), flag that
// quadrant when a squad is sweeping it, and stay completely hidden from a
// human WATCHER — for whom it would be a free position tracker on the one
// thing the whole game hides.
// Run: node game/tests/zone-hud.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8231;

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

async function startAs(page, btn) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click(btn);
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await page.waitForTimeout(400);
}

const zone = (page) =>
  page.evaluate(() => {
    const stat = document.getElementById("zoneStat");
    const label = document.getElementById("zoneLabel");
    return {
      shown: !!stat && !stat.classList.contains("hidden"),
      text: label ? label.textContent : null,
      hunted: !!label && label.classList.contains("hunted"),
    };
  });

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

  // --- Human Prisoner: the readout must be present and name a real quadrant.
  await startAs(page, "#playPrisoner");
  const z0 = await zone(page);
  check(z0.shown, "Zone stat is visible to a human Prisoner");
  check(["North", "East", "South", "West"].includes(z0.text),
    `Zone names a cardinal quadrant (got "${z0.text}")`);
  check(!z0.hunted, "Zone is not flagged before any guards exist");

  // It must agree with the rules' own quadrantOf for the human's prisoner —
  // a readout that is merely *present* but points at the wrong quadrant is
  // worse than none, since every dispatch warning is read against it.
  const agrees = await page.evaluate(async () => {
    const R = await import("./src/rules.js");
    const M = await import("./src/map.js");
    const g = window.__opticon.game;
    const p = g.prisoners[0];
    return M.DIRS[R.quadrantOf(g, p.x, p.y)];
  });
  check(agrees === z0.text, `Zone matches rules.quadrantOf (hud="${z0.text}" rules="${agrees}")`);

  // --- A squad dispatched into THAT quadrant must flag it.
  const flagged = await page.evaluate(async () => {
    const R = await import("./src/rules.js");
    const g = window.__opticon.game;
    const p = g.prisoners[0];
    const q = R.quadrantOf(g, p.x, p.y);
    // Drive the rules directly rather than waiting for the AI to choose this
    // quadrant on its own — the readout is what's under test, not the AI.
    g.turn = "Watcher";
    const r = R.useSkill(g, R.SKILLS.DISPATCH, q);
    g.turn = "Prisoner";
    return { ok: r.ok, q };
  });
  check(flagged.ok, "dispatched a squad into the human prisoner's own quadrant");
  await page.waitForTimeout(300);
  const z1 = await zone(page);
  check(z1.hunted, "Zone flags 'hunted' once guards sweep that quadrant");
  check(z1.text.startsWith("⚠"), `Zone text carries the warning glyph (got "${z1.text}")`);

  // --- Recalling the guards must clear it again: a warning that never turns
  // off stops being a warning.
  await page.evaluate(() => { window.__opticon.game.watcher.guards.length = 0; });
  await page.waitForTimeout(300);
  const z2 = await zone(page);
  check(!z2.hunted, "Zone clears once the guards are gone");

  // --- Human Watcher: the readout is a position leak and must never appear.
  await startAs(page, "#playWatcher");
  await page.waitForTimeout(1200);
  const zw = await zone(page);
  check(!zw.shown, "Zone stat stays hidden from a human Watcher (no position leak)");

  // Even mid-prisoner-turn, when the AI prisoners are actually moving, a
  // Watcher-role viewer must not see it — that's the window where a
  // turn-gated check could accidentally open up.
  const leaked = await page.evaluate(async () => {
    const g = window.__opticon.game;
    g.turn = "Prisoner";
    return new Promise((res) => setTimeout(() => {
      const stat = document.getElementById("zoneStat");
      res(!!stat && !stat.classList.contains("hidden"));
    }, 300));
  });
  check(!leaked, "Zone stays hidden for a Watcher even during the Prisoner's turn");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ zone-hud passed" : "\n✗ zone-hud failed");
  process.exit(ok ? 0 : 1);
})();
