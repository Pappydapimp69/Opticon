// tutorial-lessons.mjs — lessons 2-6 played start to finish by a robot that
// presses only the controls each card names (keyboard scheme). Every step must
// pass on the real input path, each Prisoner lesson must end on LESSON
// COMPLETE without the eye catching anyone, and the Watcher lesson must teach
// every skill. Lesson 1 and the pure table checks live in tutorial.mjs.
// Run: node game/tests/tutorial-lessons.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, chromiumPath } from "./browser.mjs";
import { LESSONS } from "../src/tutorial.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8232;
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

const SCREEN_KEYS = ["KeyW", "KeyD", "KeyS", "KeyA"];

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

  const press = async (k, ms = 200) => { await page.keyboard.press(k); await page.waitForTimeout(ms); };
  const stepId = () => page.evaluate(() => window.__opticon.tutorial?.step?.id ?? null);
  const myTurn = (role) => page.waitForFunction((r) => {
    const a = window.__opticon;
    if (!a.game || a.aiThinking || a.input.mode !== "game" || a.game.turn !== r) return false;
    return r === "Watcher" || a.game.activePrisoner === 0;
  }, role, { timeout: 25000 }).then(() => true).catch(() => false);
  // The screen key that walks/aims in world direction d from where the
  // prisoner stands, after letting the camera settle (keys are screen-relative).
  const keyFor = (d) => page.evaluate((dir) => {
    const a = window.__opticon, p = a.game.prisoners[0];
    for (let i = 0; i < 240; i++) a.renderer.updateCamera(a.game, p, 0.1);
    for (let sd = 0; sd < 4; sd++) if (a.renderer.screenDirToWorld(sd, { x: p.x, y: p.y }) === dir) return ["KeyW", "KeyD", "KeyS", "KeyA"][sd];
    return null;
  }, d);
  // World direction of the adjacent tile matching `what`.
  const dirTo = (what) => page.evaluate(async (w) => {
    const { DIR_VEC, OBJ } = await import("./src/map.js");
    const { isDoorOpen, objAt } = await import("./src/rules.js");
    const g = window.__opticon.game, p = g.prisoners[0];
    for (let d = 0; d < 4; d++) {
      const x = p.x + DIR_VEC[d].dx, y = p.y + DIR_VEC[d].dy, o = objAt(g, x, y);
      if (w === "door" && o === OBJ.DOOR && !isDoorOpen(g, x, y)) return d;
      if (w === "switch" && o === OBJ.SWITCH) return d;
      if (w === "glass" && o === OBJ.GLASS) return d;
      if (w === "item" && o === OBJ.ITEM) return d;
    }
    return -1;
  }, what);
  const itemsLeft = () => page.evaluate(() => window.__opticon.game.prisoners[0].items.length);
  // Arm slot 1 and aim it: at a known direction, or each in turn until spent.
  async function useAimed(dirs) {
    const start = await stepId();
    for (const d of dirs) {
      await press("Digit1", 150);
      const k = await keyFor(d);
      if (k) await press(k, 250);
      // Judged by the step moving on, not the belt: the next step refills it.
      if ((await stepId()) !== start) return true;
      await page.evaluate(() => { window.__opticon.stagedPath = []; });
    }
    return false;
  }
  async function overlayTitle() {
    for (let i = 0; i < 30; i++) {
      const t = await page.evaluate(() => {
        const o = document.getElementById("overlay");
        return o.classList.contains("hidden") ? null : document.getElementById("overlayTitle").textContent;
      });
      if (t) return t;
      await page.waitForTimeout(150);
    }
    return null;
  }
  async function startLesson(n) {
    await page.evaluate(() => document.getElementById("btnMenu").click());
    await page.waitForTimeout(200);
    await page.click("#playTutorial");
    await page.click(`[data-lesson="${n}"]`);
    await page.hover("#btnStart");
    await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__opticon.renderer.skipIntro());
    await page.waitForTimeout(200);
  }
  const caughtNow = () => page.evaluate(() => {
    const g = window.__opticon.game;
    return g.log.some((l) => /gaze locks on/.test(l.msg));
  });

  // Boot to the menu.
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  await page.click("#playTutorial");
  check(await page.evaluate(() => !document.getElementById("lessonRow").classList.contains("hidden")), "selecting Tutorial shows the lesson picker");
  check((await page.$$("[data-lesson]")).length === LESSONS.length, `the picker lists all ${LESSONS.length} lessons`);
  await page.click('[data-lesson="1"]');
  check((await page.textContent("#startLabel")).includes("Lesson 2"), "picking a lesson names it on Start");
  await page.hover("#btnStart");
  await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());

  // ---- Lesson 2: the yard
  await myTurn("Prisoner");
  const done = [];
  const drivePrisonerStep = async (id) => {
    if (id === "door" || id === "switch") { const k = await keyFor(await dirTo(id)); if (k) await press(k, 300); }
    else if (id === "window") {
      const d = await dirTo("glass"), k = await keyFor(d);
      if (k) { await page.keyboard.down("Shift"); await press(k, 300); await page.keyboard.up("Shift"); }
      else console.log(`    (window: no glass beside the prisoner, dir=${d})`);
    }
    else if (id === "pickup") { const k = await keyFor(await dirTo("item")); if (k) { await press(k, 150); await press("Space", 900); } }
    else if (id === "clock" || id === "loose" || id === "zone") {
      await press("Space", 300); await myTurn("Prisoner");
    }
    else if (id === "distract" || id === "flare" || id === "bar") await useAimed([0, 1, 2, 3]);
    else if (id === "lockpick") await useAimed([await dirTo("door")]);
    else if (id === "cutters") await useAimed([await dirTo("switch")]);
    else if (id === "muffle" || id === "feather" || id === "transfer" || id === "shim") await press("Digit1", 250);
    else if (id === "held") await press("KeyF", 250);
  };
  async function playPrisonerLesson(label) {
    let guard = 0, last = null;
    for (let id = await stepId(); id && guard < 20; id = await stepId(), guard++) {
      if (id === last && guard > 0) { /* retrying the same step */ }
      last = id;
      const before = id;
      await myTurn("Prisoner");
      await drivePrisonerStep(id);
      const after = await stepId();
      if (after !== before) done.push(`${label}/${before}`);
    }
    return overlayTitle();
  }
  let title = await playPrisonerLesson("yard");
  check(title === "LESSON COMPLETE", `lesson 2 ends on LESSON COMPLETE (got ${title})`);
  for (const s of LESSONS[1].steps) check(done.includes(`yard/${s.id}`), `yard/${s.id} passed by its named control`);
  check((await page.textContent("#btnRestart2")) === "Next lesson", "the result screen offers Next lesson");

  // ---- Lessons 3-5 via Next lesson
  for (const n of [2, 3, 4]) {
    const L = LESSONS[n];
    await page.click("#btnRestart2");
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__opticon.renderer.skipIntro());
    check((await page.evaluate(() => window.__opticon.tutorial.lesson.id)) === L.id, `Next lesson opens "${L.title}"`);
    title = await playPrisonerLesson(L.id);
    check(title === "LESSON COMPLETE", `${L.id} ends on LESSON COMPLETE (got ${title})`);
    for (const s of L.steps) check(done.includes(`${L.id}/${s.id}`), `${L.id}/${s.id} passed by its named control`);
  }
  check(!(await caughtNow()), "the eye never caught anyone during the Prisoner lessons");

  // ---- Lesson 6: the Watcher
  await page.click("#btnRestart2");
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  check((await page.evaluate(() => window.__opticon.config.humanRole)) === "Watcher", "the last lesson seats you as the Watcher");
  const bluffSet = () => page.evaluate(() => window.__opticon.game.watcher.bluff != null);
  const driveWatcherStep = async (id) => {
    if (id === "aim") await press("KeyQ");
    else if (id === "rotate") await press("Space");
    else if (id === "bluff") { for (const k of ["Digit1", "Digit2", "Digit3", "Digit4"]) { await press(k, 150); if (await bluffSet()) break; } }
    else if (id === "scan" || id === "noise") { await press("Space", 300); await myTurn("Watcher"); }
    else if (id === "double") {
      for (const k of ["Digit1", "Digit2", "Digit3", "Digit4"]) { if (await bluffSet()) break; await press(k, 150); }
      await press("Digit5", 150);
      for (const k of ["Digit1", "Digit2", "Digit3", "Digit4"]) { await press(k, 150); if ((await stepId()) !== "double") break; }
    }
    else if (id === "wide") await press("Digit6");
    else if (id === "echo") await press("Digit7");
    else if (id === "lock") await press("Digit8");
    else if (id === "dispatch") { await press("Digit9", 150); await press("Digit1", 250); }
  };
  await myTurn("Watcher");
  let guard = 0;
  for (let id = await stepId(); id && id !== "hunt" && guard < 30; id = await stepId(), guard++) {
    await myTurn("Watcher");
    await driveWatcherStep(id);
    const after = await stepId();
    if (after !== id) done.push(`watcher/${id}`);
  }
  for (const s of LESSONS[5].steps.filter((s) => s.id !== "hunt")) check(done.includes(`watcher/${s.id}`), `watcher/${s.id} passed by its named control`);
  const awake = await page.evaluate(() => ({ id: window.__opticon.tutorial.step?.id, grace: window.__opticon.game.graceRounds }));
  check(awake.id === "hunt" && awake.grace === 0, "the hunt step wakes the eye");
  check(await page.evaluate(() => window.__opticon.game.status === "playing"), "the hidden prisoner never walked out while you learned");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));
  await browser.close();
  server.close();
  console.log(ok ? "\n✓ tutorial-lessons passed" : "\n✗ tutorial-lessons failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("TUTORIAL-LESSONS TEST FAILED:", e);
  process.exit(1);
});
