// Force the escape path in a real browser and confirm the ESCAPED overlay.
import { createRequire } from "module";
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { chromium, chromiumPath } from "./browser.mjs";
import { driveEscape } from "./escape.mjs";
const require = createRequire(import.meta.url);
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
  const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--use-gl=swiftshader","--no-sandbox"] });
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

  // Turn race, exit-neighbour filter, re-seeding and screen-relative keys all
  // live in escape.mjs now (each was a separate ~1-in-3 flake here first).
  const setup = await driveEscape(page);
  if (!setup.ok) {
    console.log(`SETUP FAILED: ${setup.reason} — not a feature failure`);
    await browser.close(); server.close();
    process.exit(2);
  }

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
})().catch(async (e) => {
  // Any unexpected throw still has to leave the machine clean, and has to be
  // distinguishable from an honest red. Exit 3, never 1.
  console.error("HARNESS ERROR:", e && e.message ? e.message : e);
  process.exit(3);
});
