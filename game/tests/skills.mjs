// skills.mjs — Headless check of the Watcher skill bar through main.js:
// rendering, cooldown display, the hidden-info gate (a hotseat PRISONER must
// never read the tower's readiness), and that a skill actually fires.
// Run: node game/tests/skills.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH || "/opt/node22/lib/node_modules/playwright";
const chromiumPath = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { chromium } = require(playwrightPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8218;

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

async function pollUntil(page, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function startAs(page, btn) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space");
  const menuOpened = await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"));
  await page.keyboard.up("Space");
  if (!menuOpened) throw new Error("intro hold did not open the menu");
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click(btn);
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  const gameStarted = await pollUntil(page, () => !!window.__opticon?.game);
  await page.mouse.up();
  if (!gameStarted) throw new Error("Start hold did not create a game");
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
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

  // --- Human Watcher: the bar should appear on the Watcher's turn.
  await startAs(page, "#playWatcher");
  // The AI prisoners move first; wait for the handoff back to the Watcher.
  for (let i = 0; i < 40; i++) {
    const t = await page.evaluate(() => window.__opticon.game.turn);
    if (t === "Watcher") break;
    await page.waitForTimeout(200);
  }
  const turn = await page.evaluate(() => window.__opticon.game.turn);
  check(turn === "Watcher", `reached the Watcher's turn (got ${turn})`);

  await page.waitForTimeout(300);
  const chips = await page.$$eval("#skillBar .skill-chip", (els) => els.length);
  check(chips === 5, `skill bar renders all five skills (got ${chips})`);
  const controlsHint = await page.$eval("#hint", (el) => el.textContent);
  check(controlsHint.includes("5-9: skills"), `keyboard hint advertises all five skill keys (got ${JSON.stringify(controlsHint)})`);

  // Unavailable actions must explain their precondition instead of merely
  // playing a blocked sound. Echo begins unavailable because no noise exists.
  await page.evaluate(() => {
    window.__opticon.game.noise = [];
    window.__opticon.game.watcher.skills.echo = 0;
  });
  await page.keyboard.press("Digit7");
  await page.waitForTimeout(100);
  const blockedEcho = await page.evaluate(() => ({
    hint: document.getElementById("hint").textContent,
    cd: window.__opticon.game.watcher.skills.echo,
  }));
  check(blockedEcho.hint.includes("needs an active noise trace"), `blocked Echo explains why (got ${JSON.stringify(blockedEcho.hint)})`);
  check(blockedEcho.cd === 0, "blocked Echo does not spend its cooldown");

  // Double Bluff is an explicit two-step skill: make the first claim, arm
  // key 5, then choose a distinct second direction. The old UI passed null
  // straight into useSkill(), so key 5 and the chip could never work.
  await page.keyboard.press("Digit1");
  await page.keyboard.press("Digit5");
  await page.waitForTimeout(100);
  const doubleArmed = await page.evaluate(() => ({
    first: window.__opticon.game.watcher.bluff,
    armed: window.__opticon.armedSkill,
    hint: document.getElementById("hint").textContent,
  }));
  check(doubleArmed.first === 0, "first bluff is recorded before Double Bluff");
  check(doubleArmed.armed === "doubleBluff", "pressing 5 arms Double Bluff");
  check(doubleArmed.hint.includes("second claim"), "armed Double Bluff explains the next input");
  // The clickable chip uses the same activation path: click once to cancel,
  // once to re-arm, then use the on-screen direction control as the target.
  await page.click('[data-skill="doubleBluff"]');
  check(await page.evaluate(() => window.__opticon.armedSkill === null), "clicking the armed Double Bluff chip cancels it");
  await page.click('[data-skill="doubleBluff"]');
  check(await page.evaluate(() => window.__opticon.armedSkill === "doubleBluff"), "clicking the Double Bluff chip arms it");
  await page.click('#watcherControls [data-intent="bluff"][data-arg="0"]');
  const sameDirection = await page.evaluate(() => ({
    armed: window.__opticon.armedSkill,
    hint: document.getElementById("hint").textContent,
  }));
  check(sameDirection.armed === "doubleBluff", "an invalid same-direction target keeps Double Bluff armed");
  check(sameDirection.hint.includes("different second direction"), "same-direction feedback explains how to recover");
  await page.click('#watcherControls [data-intent="bluff"][data-arg="1"]');
  await page.waitForTimeout(100);
  const afterDouble = await page.evaluate(() => ({
    first: window.__opticon.game.watcher.bluff,
    second: window.__opticon.game.watcher.bluff2,
    cd: window.__opticon.game.watcher.skills.doubleBluff,
    armed: window.__opticon.armedSkill,
  }));
  check(afterDouble.first === 0 && afterDouble.second === 1, "Double Bluff preserves the first claim and adds the selected second claim");
  check(afterDouble.cd > 0, `Double Bluff goes on cooldown (${afterDouble.cd})`);
  check(afterDouble.armed === null, "Double Bluff clears its armed state after targeting");

  // Suspicion HUD: the same per-quadrant score watcherAI.js computes for
  // the AI opponent, surfaced so a human Watcher can aim informed instead
  // of guessing. Force a strong, unambiguous noise reading due north and
  // confirm that quadrant's bar actually reads highest.
  const rows = await page.$$eval("#suspicionHud .susp-row", (els) => els.length);
  check(rows === 4, `suspicion HUD renders one row per quadrant (got ${rows})`);
  await page.evaluate(() => {
    const g = window.__opticon.game;
    const { center } = g.map;
    g.noise = [{ x: center.x, y: center.y - 5, ttl: 6 }]; // due north
  });
  await page.waitForTimeout(250);
  const widths = await page.$$eval("#suspicionHud .susp-fill", (els) => els.map((e) => parseInt(e.style.width)));
  check(widths[0] === 100 && widths.slice(1).every((w) => w < 100), `north noise reads as the dominant quadrant (got ${JSON.stringify(widths)})`);
  await page.evaluate(() => { window.__opticon.game.noise = []; });

  // Wide scan is always usable — fire it with its key and confirm cooldown.
  await page.keyboard.press("Digit6");
  await page.waitForTimeout(250);
  const afterWide = await page.evaluate(() => {
    const w = window.__opticon.game.watcher;
    return { armed: w.wideScan, cd: w.skills.wideScan };
  });
  check(afterWide.armed === true, "pressing 6 arms the wide scan");
  check(afterWide.cd > 0, `wide scan went on cooldown (${afterWide.cd})`);
  await page.keyboard.press("Digit1");
  const bluffDuringWide = await page.evaluate(() => ({
    bluff: window.__opticon.game.watcher.bluff,
    hint: document.getElementById("hint").textContent,
  }));
  check(bluffDuringWide.bluff === null, "Wide Scan prevents a replacement bluff before the scan");
  check(bluffDuringWide.hint.includes("cannot be bluffed"), "blocked bluff explains Wide Scan's tradeoff");
  const cooling = await page.$$eval("#skillBar .skill-chip.cooling", (els) => els.length);
  check(cooling >= 1, "the spent skill renders as cooling down");

  // Echo becomes actionable once noise exists, refreshes it, and reports the
  // result. This exercises the same advertised key path as a real player.
  await page.evaluate(() => {
    const g = window.__opticon.game;
    const { center } = g.map;
    g.noise = [{ x: center.x, y: center.y - 3, ttl: 1, source: "test" }];
    g.watcher.skills.echo = 0;
  });
  await page.keyboard.press("Digit7");
  await page.waitForTimeout(100);
  const afterEcho = await page.evaluate(() => ({
    ttl: window.__opticon.game.noise[0].ttl,
    cd: window.__opticon.game.watcher.skills.echo,
    hint: document.getElementById("hint").textContent,
  }));
  check(afterEcho.ttl === 2 && afterEcho.cd > 0, `Echo refreshes noise and spends its cooldown (${JSON.stringify(afterEcho)})`);
  check(afterEcho.hint.includes("refreshed 1 noise trace"), "Echo confirms its visible result");

  // Remote Lock auto-selects an eligible open door. Open a real generated
  // door, ensure nobody occupies it, then use the advertised key.
  const openedDoorKey = await page.evaluate(() => {
    const g = window.__opticon.game;
    for (let y = 0; y < g.map.size; y++) {
      for (let x = 0; x < g.map.size; x++) {
        if (g.map.objects[y][x] !== 1) continue; // OBJ.DOOR
        if (g.prisoners.some((p) => p.x === x && p.y === y)) continue;
        const key = y * g.map.size + x;
        g.openedDoors.add(key);
        return key;
      }
    }
    return null;
  });
  check(openedDoorKey != null, "generated map provides an eligible door for Remote Lock");
  await page.keyboard.press("Digit8");
  await page.waitForTimeout(100);
  const afterLock = await page.evaluate((key) => ({
    open: window.__opticon.game.openedDoors.has(key),
    cd: window.__opticon.game.watcher.skills.lock,
    hint: document.getElementById("hint").textContent,
  }), openedDoorKey);
  check(afterLock.open === false && afterLock.cd > 0, `Remote Lock closes the door and spends its cooldown (${JSON.stringify(afterLock)})`);
  check(afterLock.hint.includes("sealed"), "Remote Lock confirms what it changed");

  // Dispatch guards: arm with 9, pick a quadrant with 1-4 (must wait out
  // wide scan's cooldown from above — dispatch has its own, separate one).
  const quadrant = await page.evaluate(() => {
    const g = window.__opticon.game;
    const { center } = g.map;
    const dx = g.map.exit.x - center.x, dy = g.map.exit.y - center.y;
    return Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 0 : 2) : (dx > 0 ? 1 : 3);
  });
  await page.keyboard.press("Digit9");
  await page.waitForTimeout(150);
  const armed = await page.evaluate(() => window.__opticon.armedSkill);
  check(armed === "dispatch", "pressing 9 arms dispatch");
  await page.keyboard.press(["Digit1", "Digit2", "Digit3", "Digit4"][quadrant]);
  await page.waitForTimeout(200);
  const afterDispatch = await page.evaluate(() => ({
    guards: window.__opticon.game.watcher.guards.length,
    meshes: window.__opticon.renderer.guardMeshes.size,
    armed: window.__opticon.armedSkill,
  }));
  check(afterDispatch.guards === 2, `dispatch spawns 2 guards (got ${afterDispatch.guards})`);
  check(afterDispatch.meshes === 2, `renderer builds a mesh per guard (got ${afterDispatch.meshes})`);
  check(afterDispatch.armed === null, "dispatch clears the armed flag once fired");

  check(errors.length === 0, `watcher scenario: no console errors (${errors.length} found)`);
  await page.close();

  // --- Hotseat: on the PRISONER's turn the bar must be empty, or the
  // prisoner's player reads the tower's readiness off a shared screen.
  const { page: p2, errs } = await (async () => {
    const errs = [];
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    p2.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    p2.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
    return { page: p2, errs };
  })();
  await startAs(p2, "#playHotseat");
  const hotseatTurn = await p2.evaluate(() => window.__opticon.game.turn);
  check(hotseatTurn === "Prisoner", "hotseat opens on the Prisoner's turn");
  await p2.waitForTimeout(300);
  const barHiddenForPrisoner = await p2.$eval("#skillBar", (el) => el.classList.contains("empty") && el.innerHTML === "");
  check(barHiddenForPrisoner, "skill bar is empty on the hotseat Prisoner's turn (no readiness leak)");
  const suspicionHiddenForPrisoner = await p2.$eval("#suspicionHud", (el) => el.classList.contains("empty") && el.innerHTML === "");
  check(suspicionHiddenForPrisoner, "suspicion HUD is empty on the hotseat Prisoner's turn too");

  check(errs.length === 0, `hotseat scenario: no console errors (${errs.length} found)`);
  errs.slice(0, 5).forEach((e) => console.log("    •", e));
  await p2.close(); // a still-open background tab throttles rAF, breaking the next hold-to-confirm

  // --- Gamepad: South had NO route to bluff/dispatch at all (face buttons
  // only cover Y/B/X — A is endTurn). The d-pad now dual-dispatches "bluff"
  // with the same index as "move", the same one-role-per-turn convention as
  // keyboard 1/2. Verify South (d-pad down) actually reaches DISPATCH.
  const errs3 = [];
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  p3.on("console", (m) => { if (m.type() === "error") errs3.push(m.text()); });
  p3.on("pageerror", (e) => errs3.push("PAGEERROR: " + e.message));
  await p3.addInitScript(() => {
    window.__pad = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0], index: 0, id: "fake", connected: true, mapping: "standard", timestamp: 0 };
    navigator.getGamepads = () => [window.__pad, null, null, null];
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  async function tap(page, i) {
    await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = true; }, i);
    await page.waitForTimeout(100);
    await page.evaluate((idx) => { window.__pad.buttons[idx].pressed = false; }, i);
    await page.waitForTimeout(100);
  }
  await p3.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await p3.waitForTimeout(300);
  // X hold-to-confirm dismisses the intro (same gesture as gamepad-menu-nav.mjs).
  await p3.evaluate(() => { window.__pad.buttons[2].pressed = true; });
  const padMenuOpened = await pollUntil(p3, () => !document.getElementById("menu").classList.contains("hidden"));
  await p3.evaluate(() => { window.__pad.buttons[2].pressed = false; });
  if (!padMenuOpened) throw new Error("gamepad intro hold did not open the menu");
  await p3.click('[data-diff="medium"]');
  await p3.waitForTimeout(150);
  await p3.click("#playWatcher");
  await p3.waitForTimeout(150);
  await p3.hover("#btnStart");
  await p3.mouse.down();
  const padGameStarted = await pollUntil(p3, () => !!window.__opticon?.game);
  await p3.mouse.up();
  if (!padGameStarted) throw new Error("gamepad scenario Start hold did not create a game");
  await p3.evaluate(() => window.__opticon.renderer.skipIntro());
  for (let i = 0; i < 40; i++) {
    const t = await p3.evaluate(() => window.__opticon.game.turn);
    if (t === "Watcher") break;
    await p3.waitForTimeout(200);
  }
  await tap(p3, 7); // RT: fire whichever skill the pad slot cursor is on (arms whatever it lands on)
  // Cycle LT until the slot cursor is on DISPATCH (index 4), then fire it.
  for (let i = 0; i < 5; i++) {
    const onDispatch = await p3.evaluate(() => window.__opticon.armedSkill === "dispatch");
    if (onDispatch) break;
    await tap(p3, 6); // LT: advance slot cursor
    await tap(p3, 7); // RT: fire the now-selected slot
  }
  const armedViaPad = await p3.evaluate(() => window.__opticon.armedSkill);
  check(armedViaPad === "dispatch", "gamepad LT/RT can arm dispatch");
  await tap(p3, 13); // d-pad DOWN — South, previously unreachable for bluff/dispatch
  await p3.waitForTimeout(150);
  const afterPadDispatch = await p3.evaluate(() => ({
    guards: window.__opticon.game.watcher.guards.map((g) => g.quadrant),
    armed: window.__opticon.armedSkill,
  }));
  check(afterPadDispatch.guards.length === 2 && afterPadDispatch.guards.every((q) => q === 2),
    `d-pad down dispatches to South/quadrant 2 (got ${JSON.stringify(afterPadDispatch.guards)})`);
  check(afterPadDispatch.armed === null, "armed flag clears after the gamepad dispatch");
  check(errs3.length === 0, `gamepad scenario: no console errors (${errs3.length} found)`);
  errs3.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ skills passed" : "\n✗ skills failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("SKILLS TEST FAILED:", e);
  process.exit(1);
});
