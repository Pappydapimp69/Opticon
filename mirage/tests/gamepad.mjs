// gamepad.mjs — Headless check that MIRAGE is fully playable on a gamepad
// alone: title menu, starting a run, every in-run verb, pause, and the debrief
// screen. Run: node mirage/tests/gamepad.mjs
//
// Playwright has no hardware gamepad emulation, so — same technique as
// Opticon's tests/gamepad-menu-nav.mjs — `navigator.getGamepads` is overridden
// via `page.addInitScript` to return one fake, mutable Gamepad object BEFORE
// navigation, so the game's own poll loop (which never trusts
// `gamepadconnected` alone — Chrome hides pad state until a real button press)
// picks it up from frame one exactly as it would a real controller.
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "..");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/mirage/index.html";
    const file = path.join(REPO, p);
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

const failures = [];
function assert(cond, msg) { if (!cond) failures.push(msg); }

// Xbox-style button indices, named for readability in the test body below.
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, L3: 10, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  // Inject the fake pad before any of the game's JS runs, so the very first
  // poll (on the title screen, before a run exists) already sees it.
  await page.addInitScript(() => {
    window.__pad = {
      buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
      axes: [0, 0, 0, 0],
      index: 0, id: "fake", connected: true, mapping: "standard", timestamp: 0,
    };
    navigator.getGamepads = () => [window.__pad, null, null, null];
  });

  await page.goto(`http://localhost:${PORT}/mirage/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__mirage, null, { timeout: 15000 });

  // Hold/settle durations are generous on purpose. The game's own poll loop is
  // rAF-driven, and measured elsewhere in this repo at 8-10 fps under headless
  // SwiftShader (~100-125ms/frame) — a 90ms button hold can end up SHORTER than
  // a single frame under load, so the edge is never sampled and the tap is
  // silently missed. Never assert on wall-clock timing in this harness either;
  // these delays exist only to guarantee the fake pad's state is visible to at
  // least one real poll, not to imply anything about elapsed game time.
  async function tap(btn) {
    await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, btn);
    await page.waitForTimeout(220);
    await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, btn);
    await page.waitForTimeout(180);
  }
  async function hold(btn, ms) {
    await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, btn);
    await page.waitForTimeout(ms);
    await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, btn);
    await page.waitForTimeout(150);
  }
  async function stick(x, y, ms = 260) {
    await page.evaluate(([sx, sy]) => { window.__pad.axes[0] = sx; window.__pad.axes[1] = sy; }, [x, y]);
    await page.waitForTimeout(ms);
    await page.evaluate(() => { window.__pad.axes[0] = 0; window.__pad.axes[1] = 0; });
    await page.waitForTimeout(150);
  }

  // ---- title screen: reachable, and scheme-adaptive, on gamepad alone -----
  // Nudge a button first so the pad "connects" (Chrome-hides-until-pressed) and
  // the game's scheme detector notices, before asserting on scheme-driven UI.
  await tap(BTN.A);
  const scheme1 = await page.evaluate(() => document.body.dataset.scheme);
  assert(scheme1 === "gamepad", `body scheme did not flip to gamepad from a button press (got ${scheme1})`);
  const touchHidden = await page.evaluate(() => getComputedStyle(document.querySelector(".touch-buttons")).display === "none");
  assert(touchHidden, "touch buttons should stay hidden once a gamepad is the active scheme");
  const menuHintText = await page.evaluate(() => document.getElementById("menuHints").innerText);
  assert(/select/i.test(menuHintText), `title menu hint didn't switch to a gamepad-appropriate line: ${JSON.stringify(menuHintText)}`);
  assert(/A/.test(menuHintText), `expected an [A] badge in the menu hint, got: ${JSON.stringify(menuHintText)}`);

  // D-pad down should walk focus from the difficulty row down to Start.
  const focusRowBefore = await page.evaluate(() => document.querySelector("#title .gpfocus")?.dataset.row);
  assert(focusRowBefore === "0", `expected initial gamepad focus on row 0 (difficulty), got ${focusRowBefore}`);
  await tap(BTN.DOWN);
  const focusRowAfterOne = await page.evaluate(() => document.querySelector("#title .gpfocus")?.dataset.row);
  assert(focusRowAfterOne === "1", `dpad-down did not move focus to row 1 (Start), got ${focusRowAfterOne}`);

  // Left stick should do the SAME thing D-pad does (debounced into one pulse),
  // moving focus on to "How to play".
  await stick(0, 1);
  const focusRowAfterStick = await page.evaluate(() => document.querySelector("#title .gpfocus")?.dataset.row);
  assert(focusRowAfterStick === "2", `left stick down did not advance focus to row 2 (How to play), got ${focusRowAfterStick}`);

  // Back up to the difficulty row and pick "Bleak" with dpad-right + A, purely
  // on the gamepad, then confirm it actually took (no mouse ever touched this).
  await tap(BTN.UP);
  await tap(BTN.UP);
  await tap(BTN.RIGHT);
  await tap(BTN.RIGHT);
  await tap(BTN.A);
  const pickedDiff = await page.evaluate(() => document.querySelector('[data-diff].sel')?.dataset.diff);
  assert(pickedDiff === "bleak", `gamepad-only difficulty pick failed, got ${pickedDiff}`);

  // Now walk down to Start and confirm — this must actually launch a run.
  await tap(BTN.DOWN);
  await tap(BTN.A);
  await page.waitForFunction(() => !!window.__mirage.sim, null, { timeout: 10000 });
  const started = await page.evaluate(() => ({
    difficulty: window.__mirage.sim.difficulty,
    hudVisible: !document.getElementById("hudLayer").classList.contains("hidden"),
  }));
  assert(started.difficulty === "bleak", `run started with the wrong difficulty: ${started.difficulty}`);
  assert(started.hudVisible, "HUD did not appear after a gamepad-only Start");

  // ---- in-run verbs, gamepad only ------------------------------------------
  const hint = await page.evaluate(() => document.getElementById("hints").innerText);
  assert(/survey/i.test(hint) && /check in/i.test(hint) && /dose/i.test(hint), `in-run hint missing a verb: ${JSON.stringify(hint)}`);
  assert(/A/.test(hint) && /X/.test(hint) && /Y/.test(hint), `in-run hint missing gamepad badges: ${JSON.stringify(hint)}`);

  // Left stick moves the player (through the real rAF loop this time, not
  // window.__mirage.advance(), so this exercises input.poll() end to end).
  const before = await page.evaluate(() => ({ x: window.__mirage.sim.player.x, z: window.__mirage.sim.player.z }));
  await page.evaluate(() => { window.__pad.axes[1] = -1; }); // stick forward
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.__pad.axes[1] = 0; });
  const after = await page.evaluate(() => ({ x: window.__mirage.sim.player.x, z: window.__mirage.sim.player.z }));
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  assert(moved > 0.4, `left stick did not move the player through the real frame loop (moved ${moved.toFixed(2)})`);

  // RB/LB cycle the selected companion; X checks in on WHICHEVER one that
  // left selected — this is the exact bug class fixed for gamepad support
  // (X/Y used to act on a selection index that only ever updated from
  // keyboard digit presses, never from LB/RB).
  await tap(BTN.RB);
  await tap(BTN.RB);
  const selAfterCycle = await page.evaluate(() => window.__mirage.selected);
  assert(selAfterCycle === 2, `RB x2 should select companion index 2, got ${selAfterCycle}`);
  const subtitlesBefore = await page.evaluate(() => document.getElementById("subtitles").innerText);
  await tap(BTN.X);
  const subtitlesAfter = await page.evaluate(() => document.getElementById("subtitles").innerText);
  const companionName = await page.evaluate(() => window.__mirage.sim.companions[2].name);
  assert(
    subtitlesAfter !== subtitlesBefore && subtitlesAfter.includes(companionName),
    `X (check-in) did not report on the RB-selected companion (${companionName}): ${JSON.stringify(subtitlesAfter)}`,
  );

  // Y spends a dose on that same selection.
  const dosesBefore = await page.evaluate(() => window.__mirage.sim.doses);
  await tap(BTN.Y);
  const dosesAfter = await page.evaluate(() => window.__mirage.sim.doses);
  assert(dosesAfter === dosesBefore - 1, `Y (dose) did not spend a dose (before ${dosesBefore}, after ${dosesAfter})`);

  // Start pauses, and the pause screen is itself gamepad-navigable.
  await tap(BTN.START);
  const pausedState = await page.evaluate(() => ({
    paused: window.__mirage.paused,
    pauseVisible: !document.getElementById("pauseLayer").classList.contains("hidden"),
  }));
  assert(pausedState.paused && pausedState.pauseVisible, "Start did not open the pause screen via gamepad");

  const pauseFocusRow = await page.evaluate(() => document.querySelector("#pauseLayer .gpfocus")?.dataset.row);
  assert(pauseFocusRow === "0", `pause screen should focus the volume row first, got ${pauseFocusRow}`);
  await tap(BTN.RIGHT); // Off -> Low
  await tap(BTN.RIGHT); // Low -> Medium
  await tap(BTN.A);
  const volPicked = await page.evaluate(() => document.querySelector('[data-vol].sel')?.dataset.vol);
  assert(volPicked === "0.7", `gamepad volume-row pick landed wrong, got ${volPicked}`);

  // B on the pause screen should resume, same as Escape/Resume button.
  await tap(BTN.B);
  const resumedState = await page.evaluate(() => ({
    paused: window.__mirage.paused,
    hudVisible: !document.getElementById("hudLayer").classList.contains("hidden"),
  }));
  assert(!resumedState.paused && resumedState.hudVisible, "B on the pause screen did not resume play");

  // ---- debrief screen is reachable purely on gamepad -----------------------
  // Force a fast finish so the debrief screen actually appears: drop every
  // companion (dissolution) rather than waiting out a real run.
  await page.evaluate(() => {
    const s = window.__mirage.sim;
    for (const c of s.party) c.lucidity = 0;
  });
  // advance(11) drives ~330 sim steps synchronously in-page, each with a full
  // Three.js render pass — under this sandbox's occasional heavy load that can
  // itself take real wall-clock seconds, so the wait below gets real headroom
  // rather than a tight timeout that reads as "broken" when it is just "slow".
  await page.evaluate(() => window.__mirage.advance(11)); // > DISSOLVE_TIME
  // A manual Node-side poll, not page.waitForFunction(): that helper's default
  // "raf" polling mode runs ITS check via requestAnimationFrame inside the page,
  // which can be starved for many seconds behind the backlog `advance()` just
  // generated (330 synchronous steps, each a full Three.js render, under this
  // sandbox's occasional heavy CPU contention) — the DOM had already flipped by
  // the time a fixed evaluate-based check confirmed it, so the condition was
  // never actually false, only unobserved. Polling from outside the page
  // sidesteps that starvation entirely.
  let debriefShown = false;
  for (let i = 0; i < 100 && !debriefShown; i++) {
    debriefShown = await page.evaluate(() => !document.getElementById("debriefLayer").classList.contains("hidden"));
    if (!debriefShown) await page.waitForTimeout(100);
  }
  assert(debriefShown, "debrief screen never appeared after forcing dissolution");
  const debriefFocus = await page.evaluate(() => document.querySelector("#debriefLayer .gpfocus")?.id);
  assert(debriefFocus === "againBtn", `debrief screen's New-basin button was not gamepad-focused, got ${debriefFocus}`);
  await tap(BTN.A);
  const backAtTitle = await page.evaluate(() => !document.getElementById("title").classList.contains("hidden"));
  assert(backAtTitle, "confirming on the debrief screen via gamepad did not return to the title screen");

  assert(errors.length === 0, `console errors: ${errors.slice(0, 8).join(" | ")}`);

  await browser.close();
  server.close();

  if (failures.length) {
    console.log("GAMEPAD TEST FAILED:");
    for (const f of failures) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log("mirage gamepad: OK");
})().catch((e) => {
  console.error("GAMEPAD TEST CRASHED:", e);
  process.exit(1);
});
