// intro-cutscene.mjs — Headless check of the "lay of the land" flythrough
// played once per game start. Two co-equal requirements were asked for (a
// level sweep AND per-prisoner close-ups — Brain dog#E23: verify each named
// clause independently, not just the flashier one via a demo impression),
// plus the hidden-info rule that governs every other view/log/HUD gate in
// this codebase: a Watcher-role human must never see prisoner spawns.
// Run: node game/tests/intro-cutscene.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8213;

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

async function newPage(browser) {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  return { page, errors };
}

async function dismissIntroAndStart(page, playBtnId) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space");
  await page.waitForTimeout(750);
  await page.keyboard.up("Space");
  await page.waitForTimeout(300);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click(playBtnId);
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
}

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });

  // --- Scenario 1: single-player Prisoner — BOTH clauses must be true. ---
  {
    const { page, errors } = await newPage(browser);
    await dismissIntroAndStart(page, "#playPrisoner");
    await page.waitForTimeout(50);

    const cutsceneActive = await page.evaluate(() => window.__opticon.cutsceneActive);
    check(cutsceneActive === true, "cutscene is active right after game start");

    // Clause 1: a level sweep is actually happening — the camera moves
    // meaningfully over the first ~1s, not sitting frozen on the start frame.
    const pos0 = await page.evaluate(() => window.__opticon.renderer.camPos.toArray());
    await page.waitForTimeout(900);
    const pos1 = await page.evaluate(() => window.__opticon.renderer.camPos.toArray());
    const moved = Math.hypot(pos1[0] - pos0[0], pos1[1] - pos0[1], pos1[2] - pos0[2]);
    check(moved > 1, `clause 1 — level-sweep camera actually moves (Δ=${moved.toFixed(2)})`);

    // Clause 2: the timeline includes a waypoint at (or very near) EVERY
    // prisoner's spawn tile, not just the tower/gate — proves the
    // close-up half of the request was actually built, independent of
    // clause 1's camera-movement check.
    const { visitsAllSpawns, prisonerCount } = await page.evaluate(() => {
      const g = window.__opticon.game;
      const r = window.__opticon.renderer;
      const wp = r.cutscene ? r.cutscene.waypoints : [];
      const near = (a, b, eps) => Math.abs(a - b) < eps;
      const hits = g.prisoners.every((p) => {
        const wx = r.worldX(p.x), wz = r.worldZ(p.y);
        return wp.some((w) => near(w.target.x, wx, 0.05) && near(w.target.z, wz, 0.05));
      });
      return { visitsAllSpawns: hits, prisonerCount: g.prisoners.length };
    });
    check(prisonerCount >= 3, `scenario has multiple prisoners to check (got ${prisonerCount})`);
    check(visitsAllSpawns, "clause 2 — the timeline visits every prisoner's spawn, not just the level");

    // Skip parity: skipping must land on the EXACT same camera state the
    // cutscene's own final waypoint targets (provable, not eyeballed).
    const endCam = await page.evaluate(() => {
      const r = window.__opticon.renderer;
      const last = r.cutscene.waypoints[r.cutscene.waypoints.length - 1];
      return { pos: last.pos.toArray(), target: last.target.toArray() };
    });
    await page.evaluate(() => window.__opticon.renderer.skipIntro());
    const afterSkip = await page.evaluate(() => ({
      pos: window.__opticon.renderer.camPos.toArray(),
      target: window.__opticon.renderer.camTarget.toArray(),
      active: window.__opticon.cutsceneActive,
    }));
    const eq = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    check(eq(afterSkip.pos, endCam.pos) && eq(afterSkip.target, endCam.target), "skip lands on the exact scripted end-of-cutscene camera state");
    check(afterSkip.active === false, "cutsceneActive clears once skipped");

    // Normal play must work immediately afterward (input isn't stuck gated).
    await page.keyboard.press("KeyD");
    await page.waitForTimeout(200);
    const moved2 = await page.evaluate(() => window.__opticon.stagedPath.length > 0);
    check(moved2, "gameplay input works normally right after the cutscene ends");

    check(errors.length === 0, `scenario 1: no console errors (${errors.length} found)`);
    await page.close();
  }

  // --- Scenario 2: single-player Watcher — spawns must NEVER be shown. ---
  {
    const { page, errors } = await newPage(browser);
    await dismissIntroAndStart(page, "#playWatcher");
    await page.waitForTimeout(200);

    const showPrisoners = await page.evaluate(() => window.__opticon.cutsceneShowPrisoners);
    check(showPrisoners === false, "Watcher-mode cutscene never gates in the per-spawn close-ups");

    const anyAvatarVisible = await page.evaluate(() => {
      const r = window.__opticon.renderer;
      return r.avatars.some((a) => a.group.visible);
    });
    check(!anyAvatarVisible, "no prisoner avatar is ever visible during a Watcher-role cutscene (no spawn leak)");

    await page.waitForTimeout(600);
    const stillHidden = await page.evaluate(() => {
      const r = window.__opticon.renderer;
      return !r.avatars.some((a) => a.group.visible);
    });
    check(stillHidden, "stays hidden through the whole sweep, not just frame one");

    check(errors.length === 0, `scenario 2: no console errors (${errors.length} found)`);
    await page.close();
  }

  // --- Scenario 3: hotseat — pass-the-device precedent: no close-ups. ---
  {
    const { page, errors } = await newPage(browser);
    await dismissIntroAndStart(page, "#playHotseat");
    await page.waitForTimeout(200);
    const showPrisoners = await page.evaluate(() => window.__opticon.cutsceneShowPrisoners);
    check(showPrisoners === false, "hotseat cutscene never gates in the per-spawn close-ups either");
    check(errors.length === 0, `scenario 3: no console errors (${errors.length} found)`);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ intro-cutscene passed" : "\n✗ intro-cutscene failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("INTRO-CUTSCENE TEST FAILED:", e);
  process.exit(1);
});
