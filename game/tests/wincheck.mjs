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
  await page.click("#playPrisoner");
  await page.waitForTimeout(500);

  // Teleport the prisoner adjacent to the exit, facing it, then step in.
  const dir = await page.evaluate(() => {
    const a = window.__opticon, g = a.game, m = g.map, p = g.prisoners[0];
    const ex = m.exit;
    // find a walkable neighbor of exit
    const N = [[0,-1,2],[1,0,3],[0,1,0],[-1,0,1]]; // dx,dy,dirToStepFromNeighborIntoExit
    for (const [dx,dy,backDir] of N) {
      const nx = ex.x - dx, ny = ex.y - dy;
      if (m.tiles[ny] && m.tiles[ny][nx] === 0) {
        p.x = nx; p.y = ny; p.startTurnPos = {x:nx,y:ny}; p.mp = 3; g.turn = "Prisoner";
        // direction from neighbor into exit:
        if (dx===0&&dy===-1) return 0; if (dx===1&&dy===0) return 1; if (dx===0&&dy===1) return 2; if (dx===-1&&dy===0) return 3;
      }
    }
    return -1;
  });
  const keyByDir = ["KeyW","KeyD","KeyS","KeyA"];
  if (dir >= 0) { await page.keyboard.press(keyByDir[dir]); }
  await page.waitForTimeout(1200);

  const result = await page.evaluate(() => {
    const g = window.__opticon.game;
    const overlay = document.getElementById("overlay");
    const title = document.getElementById("overlayTitle").textContent;
    return { status: g.status, winner: g.winner, overlayVisible: !overlay.classList.contains("hidden"), title };
  });
  await page.screenshot({ path: path.join(ROOT, "tests", "win-escape.png") });
  console.log("RESULT:", JSON.stringify(result), "errors:", errors.length);
  await browser.close(); server.close();
  const ok = result.status === "escaped" && result.overlayVisible && /ESCAP/i.test(result.title) && errors.length === 0;
  console.log(ok ? "✓ escape end-screen verified" : "✗ escape verification failed");
  process.exit(ok ? 0 : 1);
})();
