// Headless smoke test: boots the game in Chromium, drives it, captures console
// errors and a screenshot. Run: node game/tests/smoke.mjs [scenario]
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8199;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

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

const scenario = process.argv[2] || "prisoner";

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const vw = Number(process.env.WIDTH || 1280);
  const vh = Number(process.env.HEIGHT || 800);
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });

  const errors = [];
  const logs = [];
  page.on("console", (m) => {
    logs.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  // Ensure build label loaded (module ran).
  const build = await page.$eval("#buildLabel", (el) => el.textContent).catch(() => null);

  // Start a game.
  const startBtn = scenario === "watcher" ? "#playWatcher" : scenario === "hotseat" ? "#playHotseat" : "#playPrisoner";
  await page.click(startBtn);
  await page.waitForTimeout(700);

  // Capture an early gameplay screenshot (before heavy play) for visual review.
  const shotPlay = path.join(ROOT, "tests", `play-${scenario}.png`);
  await page.screenshot({ path: shotPlay });

  // Drive some turns via keyboard.
  const keys = scenario === "watcher"
    ? ["KeyQ", "Digit2", "Space", "KeyE", "Space"]
    : ["KeyW", "Space", "KeyD", "Space", "KeyD", "Space", "KeyV"];
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(320);
  }
  await page.waitForTimeout(900);

  // Read internal state.
  const state = await page.evaluate(() => {
    const a = window.__opticon;
    if (!a || !a.game) return { ok: false };
    const g = a.game;
    return {
      ok: true,
      status: g.status,
      round: g.round,
      turn: g.turn,
      viewMode: a.viewMode,
      prisoner: { x: g.prisoners[0].x, y: g.prisoners[0].y, mp: g.prisoners[0].mp, alive: g.prisoners[0].alive, escaped: g.prisoners[0].escaped },
      facing: g.watcher.facing,
      noise: g.noise.length,
      logCount: g.log.length,
    };
  });

  const shot = path.join(ROOT, "tests", `shot-${scenario}.png`);
  await page.screenshot({ path: shot });

  console.log("BUILD:", build);
  console.log("STATE:", JSON.stringify(state, null, 2));
  console.log("ERRORS:", errors.length);
  errors.slice(0, 20).forEach((e) => console.log("  •", e));
  if (process.env.VERBOSE) logs.forEach((l) => console.log("  ", l));
  console.log("SCREENSHOT:", shot);

  await browser.close();
  server.close();
  process.exit(errors.length === 0 && state.ok ? 0 : 1);
})().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
