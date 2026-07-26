// ai-prisoners.mjs — Headless check of AI companion prisoners: multiple
// avatars render, the human controls only prisoner 0, and AI companion /
// AI Watcher turns auto-play without waiting on input that will never come.
// Run: node game/tests/ai-prisoners.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8215;

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

async function startGame(page, playBtn) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  await page.click(playBtn);
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
}

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });

  // --- Scenario 1: single-player Prisoner, with AI companions.
  {
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

    await startGame(page, "#playPrisoner");

    const count = await page.evaluate(() => window.__opticon.game.prisoners.length);
    check(count === 3, `single-player Prisoner: 3 prisoners created (got ${count})`);
    const avatarCount = await page.evaluate(() => window.__opticon.renderer.avatars.length);
    check(avatarCount === 3, `renderer built 3 avatars (got ${avatarCount})`);

    // End the human's (prisoner 0) turn without moving, repeatedly, and let
    // the AI Watcher + AI companions play themselves out. If companions
    // never got their own AI turn, activePrisoner would never move off 0
    // (or the game would silently stall waiting on human input that never
    // comes for prisoner 1/2).
    const seenPrisoners = new Set();
    for (let i = 0; i < 25; i++) {
      const state = await page.evaluate(() => {
        const g = window.__opticon.game;
        return { turn: g.turn, activePrisoner: g.activePrisoner, over: g.status !== "playing" };
      });
      if (state.over) break;
      seenPrisoners.add(state.activePrisoner);
      if (state.turn === "Prisoner" && state.activePrisoner === 0) {
        await page.keyboard.press("Space"); // human ends their own turn, no move
      }
      await page.waitForTimeout(300);
    }
    check(seenPrisoners.size > 1, `game cycled through more than one prisoner (saw indices: ${[...seenPrisoners].join(",")})`);
    check(seenPrisoners.has(1) || seenPrisoners.has(2), "an AI companion (prisoner 1 or 2) got a turn, not just prisoner 0");

    check(errors.length === 0, `scenario 1: no console errors (${errors.length} found)`);
    errors.slice(0, 5).forEach((e) => console.log("    •", e));
    await page.close();
  }

  // --- Scenario 2: single-player Watcher, ALL prisoners AI.
  {
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

    await startGame(page, "#playWatcher");

    const count = await page.evaluate(() => window.__opticon.game.prisoners.length);
    check(count === 3, `single-player Watcher: 3 prisoners created (got ${count})`);

    // Human plays Watcher every turn; AI should play EVERY prisoner's turn
    // automatically in between, cycling activePrisoner without any prisoner-
    // side input at all.
    const seenPrisoners = new Set();
    for (let i = 0; i < 20; i++) {
      const state = await page.evaluate(() => {
        const g = window.__opticon.game;
        return { turn: g.turn, activePrisoner: g.activePrisoner, over: g.status !== "playing" };
      });
      if (state.over) break;
      seenPrisoners.add(state.activePrisoner);
      if (state.turn === "Watcher") {
        await page.keyboard.press("Space"); // human scans & ends turn
      }
      await page.waitForTimeout(300);
    }
    check(seenPrisoners.size >= 2, `Watcher mode: multiple AI prisoners took turns (saw indices: ${[...seenPrisoners].join(",")})`);

    check(errors.length === 0, `scenario 2: no console errors (${errors.length} found)`);
    errors.slice(0, 5).forEach((e) => console.log("    •", e));
    await page.close();
  }

  // --- Scenario 3: hotseat stays exactly 1 prisoner (unaffected).
  {
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

    await startGame(page, "#playHotseat");
    const count = await page.evaluate(() => window.__opticon.game.prisoners.length);
    check(count === 1, `hotseat: still exactly 1 prisoner (got ${count})`);

  check(errors.length === 0, `scenario 3: no console errors (${errors.length} found)`);
    errors.slice(0, 5).forEach((e) => console.log("    •", e));
    await page.close();
  }


  // --- Scenario 4: AI movement must be ANIMATED, not teleported. Previously
  // the sim resolved a companion's whole turn instantly and the avatar merely
  // slid to the end tile, so a move read as a jump. Catching a non-empty walk
  // queue mid-turn proves the AI's route was handed to the renderer.
  {
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    await startGame(page, "#playWatcher"); // every prisoner is AI in this mode
    let sawQueue = false;
    let sawPace = false;
    for (let i = 0; i < 150 && !sawQueue; i++) {
      const s = await page.evaluate(() => {
        const r = window.__opticon.renderer;
        const a = r.avatars.find((av) => av.walk.queue.length > 0);
        return a ? { len: a.walk.queue.length, dur: a.walk.stepDur } : null;
      });
      if (s) {
        sawQueue = true;
        sawPace = s.dur > 0.22; // AI walks slower than a human commit
      }
      await page.waitForTimeout(50);
    }
    check(sawQueue, "an AI prisoner's move is queued as a walk (animated, not teleported)");
    check(sawPace, "AI walks use the slower, readable per-tile pace");
    check(errors.length === 0, `scenario 4: no page errors (${errors.length} found)`);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ ai-prisoners passed" : "\n✗ ai-prisoners failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("AI-PRISONERS TEST FAILED:", e);
  process.exit(1);
});
