// menu-resume.mjs — the menu is not a one-way door. Opening it mid-game used
// to leave exactly one way out: holding Start, which threw the game away.
// Resume (button, Esc, gamepad B) must return to the SAME game; a finished
// game offers no Resume.
// Run: node game/tests/menu-resume.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, chromiumPath } from "./browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8233;
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
  await page.addInitScript(() => {
    window.__pad = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0], index: 0, id: "fake", connected: true, mapping: "standard", timestamp: 0 };
    navigator.getGamepads = () => [window.__pad, null, null, null];
  });

  const state = () => page.evaluate(() => {
    const a = window.__opticon;
    return {
      seed: a.config.seed, round: a.game?.round, mode: a.input.mode, running: a.running,
      menu: !document.getElementById("menu").classList.contains("hidden"),
      hud: !document.getElementById("hud").classList.contains("hidden"),
      resume: !document.getElementById("btnResume").classList.contains("hidden"),
      focus: document.querySelector("#menu .gpfocus")?.id || null,
    };
  });
  const openMenu = async () => { await page.click("#btnMenu"); await page.waitForTimeout(250); };
  const pad = async (b) => {
    await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, b); await page.waitForTimeout(100);
    await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, b); await page.waitForTimeout(150);
  };

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  let s = await state();
  check(s.menu && !s.resume, "fresh menu (no game yet) offers no Resume");

  await page.click("#playPrisoner");
  await page.waitForTimeout(150);
  s = await state();
  check(s.focus === "btnStart", "picking a mode still focuses Start, not Resume");
  await page.hover("#btnStart");
  await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  const before = await state();

  // 1. Button
  await openMenu();
  s = await state();
  check(s.menu && s.resume, "menu opened mid-game shows Resume");
  check(s.focus === "btnResume", "Resume is focused");
  await page.click("#btnResume");
  await page.waitForTimeout(250);
  s = await state();
  check(s.hud && !s.menu && s.mode === "game" && s.running, "Resume button returns to the game");
  check(s.seed === before.seed && s.round === before.round, "same game, not a new one");

  // 2. Esc
  await openMenu();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  s = await state();
  check(s.hud && s.mode === "game" && s.seed === before.seed, "Esc on the menu resumes the same game");

  // 3. Gamepad B
  await openMenu();
  await pad(1);
  s = await state();
  check(s.hud && s.mode === "game" && s.seed === before.seed, "gamepad B on the menu resumes the same game");

  // 4. Gamepad A on the focused Resume
  await openMenu();
  await pad(0);
  s = await state();
  check(s.hud && s.mode === "game" && s.seed === before.seed, "gamepad A on Resume resumes the same game");

  // 5. Keys still work after resuming
  await page.waitForFunction(() => {
    const a = window.__opticon;
    return !a.aiThinking && a.game.turn === "Prisoner" && a.game.activePrisoner === 0;
  }, null, { timeout: 20000 }).catch(() => {});
  let staged = 0;
  for (const k of ["KeyW", "KeyD", "KeyS", "KeyA"]) {
    await page.keyboard.press(k); await page.waitForTimeout(150);
    staged = await page.evaluate(() => window.__opticon.stagedPath.length);
    if (staged) break;
  }
  check(staged > 0, "movement input works after resuming");

  // 6. A finished game has nothing to resume
  await page.evaluate(() => { const g = window.__opticon.game; g.status = "captured"; g.winner = "Watcher"; });
  await openMenu();
  s = await state();
  check(s.menu && !s.resume, "a finished game offers no Resume");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  s = await state();
  check(s.menu, "Esc does nothing when there is nothing to resume");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));
  await browser.close();
  server.close();
  console.log(ok ? "\n✓ menu-resume passed" : "\n✗ menu-resume failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("MENU-RESUME TEST FAILED:", e);
  process.exit(1);
});
