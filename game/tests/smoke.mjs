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
  // Dismiss the intro splash (unlocks audio, reveals the menu). Requires a
  // HOLD (>=650ms), not a tap — a single press must NOT dismiss it.
  await page.keyboard.down("Space");
  await page.waitForTimeout(750);
  await page.keyboard.up("Space");
  await page.waitForTimeout(300);

  // Ensure build label loaded (module ran).
  const build = await page.$eval("#buildLabel", (el) => el.textContent).catch(() => null);

  // Start a game: difficulty -> play type (selects only, moves focus to
  // Start) -> hold the Start button.
  const startBtn = scenario === "watcher" ? "#playWatcher" : scenario === "hotseat" ? "#playHotseat" : "#playPrisoner";
  await page.waitForSelector('[data-diff="medium"]', { state: "visible", timeout: 20000 });
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(200);
  await page.click(startBtn);
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  // Wait for the HUMAN to actually hold the turn before driving anything. The
  // game opens on an AI companion in Prisoner mode and the AI runs on a timer,
  // so pressing keys immediately raced it — the same race that made wincheck
  // fail one run in three. Here it was worse than flaky: nothing below
  // asserted the keys did anything, so losing the race was silent.
  await page.waitForFunction(() => {
    const a = window.__opticon;
    if (!a || !a.game) return false;
    if (a.aiThinking) return false;
    return a.game.turn === "Prisoner"
      ? a.game.activePrisoner === 0
      : true;
  }, null, { timeout: 20000 }).catch(() => {});

  // What the drive below is supposed to change. Captured BEFORE the keys so
  // the assertions at the end can tell "played a few turns" apart from "sat
  // there while every keypress was ignored" — which this test could not
  // distinguish for its entire existence.
  const before = await page.evaluate(() => {
    const g = window.__opticon.game;
    const p = g.prisoners[0];
    return { x: p.x, y: p.y, mp: p.mp, round: g.round, facing: g.watcher.facing, view: window.__opticon.viewMode };
  });

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

  // Did the drive actually drive anything? Each scenario has its own tell:
  // a Prisoner spends move points or moves, a Watcher's turn cycle advances
  // the round, and every scenario ends on KeyV/the view toggle.
  const moved = scenario === "watcher"
    ? state.round > before.round || state.facing !== before.facing
    : state.prisoner.x !== before.x || state.prisoner.y !== before.y ||
      state.prisoner.mp !== before.mp || state.round > before.round;
  const viewChanged = scenario === "watcher" ? true : state.viewMode !== before.view;

  const shot = path.join(ROOT, "tests", `shot-${scenario}.png`);
  await page.screenshot({ path: shot });

  console.log("BUILD:", build);
  console.log("STATE:", JSON.stringify(state, null, 2));
  console.log("DROVE:", moved ? "yes" : "NO — every keypress was ignored", `(view ${before.view} -> ${state.viewMode})`);
  console.log("ERRORS:", errors.length);
  errors.slice(0, 20).forEach((e) => console.log("  •", e));
  if (process.env.VERBOSE) logs.forEach((l) => console.log("  ", l));
  console.log("SCREENSHOT:", shot);

  await browser.close();
  server.close();
  const pass = errors.length === 0 && state.ok && moved && viewChanged;
  if (!pass && state.ok && !moved) console.log("  • the scenario's keypresses changed nothing");
  if (!pass && state.ok && !viewChanged) console.log("  • the view toggle did nothing");
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
