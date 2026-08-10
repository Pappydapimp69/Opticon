// Force the escape path in a real browser and confirm the ESCAPED overlay.
import { createRequire } from "module";
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); const PORT = 8203;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-gl=swiftshader","--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(300);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(200);
  await page.click("#playPrisoner");
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());

  // Wait for the HUMAN's own prisoner (index 0) to actually hold the turn.
  // The game opens on an AI companion and the AI drives turns on a timer, so
  // setting `g.turn = "Prisoner"` below is not enough: if a companion is the
  // active prisoner, handlePrisonerIntent ignores the keypress outright and
  // the walk never happens. That made this test fail about one run in three,
  // with the failure looking like a broken escape rather than a race.
  await page.waitForFunction(() => {
    const a = window.__opticon;
    return a && a.game && !a.aiThinking && a.game.turn === "Prisoner" && a.game.activePrisoner === 0;
  }, null, { timeout: 20000 });

  // Teleport the prisoner adjacent to the exit, facing it, then step in.
  //
  // The neighbour search used to require `tiles[ny][nx] === TILE.FLOOR`. The
  // exit sits on the map edge, so two of its four neighbours are outer wall,
  // and on a fair share of seeds the remaining ones carry a door or another
  // object rather than plain floor. On those seeds the loop fell through,
  // returned -1, the test pressed nothing at all — and then reported "escape
  // verification failed", which reads as a broken escape rather than a setup
  // that never happened. That is why this was flaky at ~1 run in 4 (the game
  // picks a fresh random seed every start), and why the first fix for the
  // flake — waiting for the human to hold the turn, a real and separate bug —
  // did not clear it.
  //
  // Now: accept any non-WALL, non-MOAT neighbour, and if a seed genuinely has
  // none, restart into a new seed and try again rather than reporting a
  // failure the feature did not cause.
  const TILE_WALL = 1, TILE_MOAT = 2;
  let dir = -1;
  for (let attempt = 0; attempt < 8 && dir < 0; attempt++) {
    if (attempt > 0) {
      await page.click("#btnRestart").catch(() => {});
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__opticon.renderer.skipIntro());
      await page.waitForFunction(() => {
        const a = window.__opticon;
        return a && a.game && !a.aiThinking && a.game.turn === "Prisoner" && a.game.activePrisoner === 0;
      }, null, { timeout: 20000 }).catch(() => {});
    }
    dir = await page.evaluate(([WALL, MOAT]) => {
      const a = window.__opticon, g = a.game, m = g.map, p = g.prisoners[0];
      const ex = m.exit;
      const N = [[0, -1, 0], [1, 0, 1], [0, 1, 2], [-1, 0, 3]];
      for (const [dx, dy, stepDir] of N) {
        const nx = ex.x - dx, ny = ex.y - dy;
        if (!m.tiles[ny] || m.tiles[ny][nx] === undefined) continue;
        const t = m.tiles[ny][nx];
        if (t === WALL || t === MOAT) continue;
        p.x = nx; p.y = ny; p.startTurnPos = { x: nx, y: ny }; p.mp = 3;
        p.custody = 0; p.alive = true; p.escaped = false;
        g.turn = "Prisoner"; g.activePrisoner = 0;
        return stepDir; // direction to step FROM the neighbour INTO the exit
      }
      return -1;
    }, [TILE_WALL, TILE_MOAT]);
  }
  if (dir < 0) {
    console.log("SETUP FAILED: no reachable neighbour of the exit after 8 seeds — not a feature failure");
    await browser.close(); server.close();
    process.exit(2);
  }

  // Movement keys are SCREEN directions (the camera orbits), so the key for a
  // given world cardinal has to be looked up, not assumed. This happened to
  // pass with a fixed table only because the default camera makes up==North.
  // Let the camera actually arrive before asking which key points where.
  // The teleport above moves the prisoner ~30 tiles; the camera rig eases
  // toward its target over several frames, so for a moment `screenDirToWorld`
  // is being asked to project the prisoner's NEW tile through a camera still
  // framing the OLD one. Under perspective that far off-centre it returns a
  // different cardinal — which is how "step West into the exit" became a
  // keypress that walked South, and the whole reason this test still failed
  // after two other genuine fixes. Real play never hits it (the avatar moves a
  // tile at a time and the camera is never more than a tile behind); a
  // teleporting harness does.
  await page.evaluate(() => {
    const a = window.__opticon;
    for (let i = 0; i < 240; i++) a.renderer.updateCamera(a.game, a.game.prisoners[0], 0.1);
  });
  const key = await page.evaluate((d) => {
    const app = window.__opticon;
    const p = app.game.prisoners[0];
    for (let sd = 0; sd < 4; sd++) {
      if (app.renderer.screenDirToWorld(sd, { x: p.x, y: p.y }) === d) {
        return ["KeyW", "KeyD", "KeyS", "KeyA"][sd];
      }
    }
    return null;
  }, dir);
  if (!key) {
    console.log("SETUP FAILED: no screen direction resolves to the world direction needed");
    await browser.close(); server.close();
    process.exit(2);
  }
  await page.keyboard.press(key); // stage the move (hypothetical, not yet real)
  await page.waitForTimeout(200);
  await page.keyboard.press("Space"); // commit — actually steps onto the exit

  // Poll for the overlay rather than sleeping a guessed duration — headless
  // rAF can be throttled (sparse frames), and the walk-animation + deferred
  // game-over take longer in wall-clock terms there than on a real, visible
  // tab. Poll up to a generous budget instead of assuming a fixed delay.
  let result = null;
  for (let i = 0; i < 40; i++) {
    result = await page.evaluate(() => {
      const g = window.__opticon.game;
      const overlay = document.getElementById("overlay");
      const title = document.getElementById("overlayTitle").textContent;
      return { status: g.status, winner: g.winner, overlayVisible: !overlay.classList.contains("hidden"), title };
    });
    if (result.overlayVisible) break;
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: path.join(ROOT, "tests", "win-escape.png") });
  console.log("RESULT:", JSON.stringify(result), "errors:", errors.length);
  await browser.close(); server.close();
  const ok = result.status === "escaped" && result.overlayVisible && /ESCAP/i.test(result.title) && errors.length === 0;
  console.log(ok ? "✓ escape end-screen verified" : "✗ escape verification failed");
  process.exit(ok ? 0 : 1);
})();
