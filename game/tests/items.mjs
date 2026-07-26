// items.mjs — Headless check of the prisoner item pipeline end to end through
// main.js: pickup on a committed move, the item bar rendering, the
// "arm then press a direction" gesture, and mutual exclusion with the
// break-window toggle.
// Run: node game/tests/items.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8217;

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
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click("#playPrisoner");
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());

  const itemCount = await page.evaluate(() => window.__opticon.game.map.items.length);
  check(itemCount > 0, `map generated item pickups (${itemCount})`);

  const rendered = await page.evaluate(() => window.__opticon.renderer.props.items.size);
  check(rendered === itemCount, `renderer built a prop for every item (${rendered}/${itemCount})`);

  // The bar starts empty (nothing carried yet).
  const barEmptyAtStart = await page.$eval("#itemBar", (el) => el.classList.contains("empty"));
  check(barEmptyAtStart, "item bar is hidden while carrying nothing");

  // Grant items directly, then confirm the bar renders them (drives the same
  // loop()-refreshed path the real pickup uses).
  await page.evaluate(() => {
    const p = window.__opticon.game.prisoners[0];
    p.items = ["muffle", "lockpick"];
  });
  await page.waitForTimeout(200);
  const chips = await page.$$eval("#itemBar .item-chip", (els) => els.length);
  check(chips === 2, `item bar renders a chip per carried item (got ${chips})`);

  // Arming a directional item highlights it; the break toggle must disarm.
  await page.evaluate(() => { window.__opticon.game.prisoners[0].items = ["lockpick"]; });
  await page.waitForTimeout(150);
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(150);
  const armed = await page.$eval("#itemBar .item-chip", (el) => el.classList.contains("armed"));
  check(armed, "pressing 1 arms the directional item");

  await page.click("#breakToggle");
  await page.waitForTimeout(150);
  const disarmedByBreak = await page.$eval("#itemBar .item-chip", (el) => !el.classList.contains("armed"));
  check(disarmedByBreak, "arming the break toggle disarms the item (mutually exclusive)");
  await page.click("#breakToggle"); // reset
  await page.waitForTimeout(100);

  // Muffle needs no direction — pressing its slot applies it immediately.
  await page.evaluate(() => {
    const p = window.__opticon.game.prisoners[0];
    p.items = ["muffle"];
    p.muffled = false;
  });
  await page.waitForTimeout(150);
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(200);
  const muffleState = await page.evaluate(() => {
    const p = window.__opticon.game.prisoners[0];
    return { muffled: p.muffled, carried: p.items.length };
  });
  check(muffleState.muffled === true, "muffle applies immediately without a direction");
  check(muffleState.carried === 0, "muffle is consumed on use");

  // A real pickup: teleport onto an item tile via the normal committed move.
  const pickup = await page.evaluate(async () => {
    const a = window.__opticon;
    const g = a.game;
    const it = g.map.items.find((i) => {
      const k = (i.y) * g.map.size + (i.x - 1);
      return g.map.tiles[i.y][i.x - 1] === 0 && g.map.objects[i.y][i.x - 1] === 0;
    });
    if (!it) return { skipped: true };
    const p = g.prisoners[0];
    p.x = it.x - 1; p.y = it.y; p.startTurnPos = { x: p.x, y: p.y }; p.mp = 3;
    p.items = [];
    g.turn = "Prisoner";
    g.activePrisoner = 0;
    return { skipped: false, kind: it.kind, x: it.x, y: it.y };
  });
  if (pickup.skipped) {
    console.log("  (no item with a walkable west neighbour on this seed — pickup path skipped)");
  } else {
    await page.keyboard.press("KeyD"); // stage a step east onto the item
    await page.waitForTimeout(200);
    await page.keyboard.press("Space"); // commit
    await page.waitForTimeout(700);
    const after = await page.evaluate((t) => {
      const g = window.__opticon.game;
      return {
        carried: g.prisoners[0].items,
        taken: g.takenItems.has(t.y * g.map.size + t.x),
        propHidden: !window.__opticon.renderer.props.items.get(`${t.x},${t.y}`).mesh.visible,
      };
    }, pickup);
    check(after.carried.includes(pickup.kind), `walking onto a pickup collects it (${pickup.kind})`);
    check(after.taken, "the tile is retired in game state");
    check(after.propHidden, "the 3D prop disappears once collected");
  }

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ items passed" : "\n✗ items failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("ITEMS TEST FAILED:", e);
  process.exit(1);
});
