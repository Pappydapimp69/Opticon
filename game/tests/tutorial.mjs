// tutorial.mjs — the guided first game, checked two ways.
//  1. Pure: every step's text names the exact control that passes it, in every
//     control scheme, and only the pinned event passes it (Brain demo-disc#E51).
//  2. In the browser, a robot that presses ONLY what the card says plays the
//     whole tutorial: the eye cannot catch it while lessons run, wakes at the
//     last step, the escape ends on "Tutorial complete", the record is never
//     touched, and Skip always gets you out.
// Run: node game/tests/tutorial.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, chromiumPath } from "./browser.mjs";
import { driveEscape } from "./escape.mjs";
import { Tutorial, LESSONS, KEYS } from "../src/tutorial.js";
import { ITEM_KINDS } from "../src/map.js";
import { SKILLS } from "../src/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8231;
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

// ---- 1. Pure -------------------------------------------------------------
// Every step that names a control must name the one in its own `key`, in every
// scheme, or the player is told to do something other than what passes it.
for (const [scheme, k] of Object.entries(KEYS)) {
  for (const L of LESSONS) {
    for (const s of L.steps) {
      if (!s.key) continue;
      check(typeof k[s.key] === "string" && s.text(k).includes(k[s.key]), `[${scheme}] ${L.id}/${s.id} names its control (${k[s.key]})`);
    }
  }
}
{
  const t = new Tutorial(0);
  check(!t.emit("committed") && t.step.id === "plan", "an event for a later step does not pass the current one");
  t.emit("planned"); t.emit("committed"); t.emit("turnEnded", { noisy: false, lit: true });
  check(t.step.id === "noise", "plan → commit → end turn reaches the noise lesson");
  check(!t.emit("turnEnded", { noisy: false, lit: false }) && t.step.id === "noise", "a quiet turn does not pass the noise lesson");
  check(t.emit("turnEnded", { noisy: true, lit: true }), "a noisy turn passes it");
  check(!t.emit("turnEnded", { noisy: false, lit: true }), "ending a turn lit does not pass the shadow lesson");
  check(t.emit("turnEnded", { noisy: false, lit: false }), "ending a turn in shadow does");
  check(t.calm, "the eye is still asleep before the last basics step");
  t.emit("view");
  check(t.step.id === "gate" && !t.calm, "reaching the escape step wakes the eye");
  const u = new Tutorial(2);
  check(!u.emit("item", { kind: "muffle" }) && u.step.id === "distract", "using the wrong item does not pass an item step");
  check(u.emit("item", { kind: "distract" }) && u.step.id === "muffle", "using the right one does");
  const v = new Tutorial(3);
  v.skip();
  check(v.done && v.skipped, "skip leaves a lesson from any step");
  // Every item the game has is taught, and every Watcher skill.
  const taughtItems = new Set(LESSONS.flatMap((L) => L.steps.filter((s) => s.on === "item").flatMap((s) => s.setup?.give || [])));
  for (const kind of Object.values(ITEM_KINDS)) check(taughtItems.has(kind), `item "${kind}" has a lesson step that uses it`);
  const taughtSkills = new Set(LESSONS.flatMap((L) => L.steps.filter((s) => s.on === "skill").map((s) => s.setup?.ready)));
  for (const skill of Object.values(SKILLS)) check(taughtSkills.has(skill), `skill "${skill}" has a lesson step that uses it`);
}

// ---- 2. Browser ----------------------------------------------------------
const MOVE_KEYS = ["KeyW", "KeyD", "KeyS", "KeyA"];
const OPP = { KeyW: "KeyS", KeyS: "KeyW", KeyA: "KeyD", KeyD: "KeyA" };

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

  const card = () => page.evaluate(() => {
    const el = document.getElementById("tutorialCard");
    const t = window.__opticon.tutorial;
    return { visible: !el.classList.contains("hidden"), text: document.getElementById("tutorialText").textContent, id: t?.step?.id ?? null };
  });
  const humanTurn = () => page.waitForFunction(() => {
    const a = window.__opticon;
    return a.game && !a.aiThinking && a.game.turn === "Prisoner" && a.game.activePrisoner === 0 && a.input.mode === "game";
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  const staged = () => page.evaluate(() => window.__opticon.stagedPath.length);
  const press = async (k, ms = 220) => { await page.keyboard.press(k); await page.waitForTimeout(ms); };
  // Plan `n` tiles in one straight line, trying each direction; undo dead ends.
  async function plan(n) {
    for (const k of MOVE_KEYS) {
      for (let i = 0; i < n; i++) await press(k, 120);
      if (await staged() >= n) return true;
      while (await staged() > 0) await press(OPP[k], 120);
    }
    return false;
  }
  async function commitAndEnd() {
    await press("Space", 900); // commit — walk animation
    await press("Space", 300); // end turn
    await humanTurn();
  }

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const recordBefore = await page.evaluate(() => localStorage.getItem("opticon.record.v1"));
  await page.keyboard.down("Space"); await page.waitForTimeout(750); await page.keyboard.up("Space");
  await page.waitForTimeout(500);
  await page.click("#playTutorial");
  check((await page.textContent("#startLabel")).includes("Lesson 1"), "Start button names the lesson it will launch");
  await page.hover("#btnStart");
  await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await humanTurn();

  const setup = await page.evaluate(() => {
    const g = window.__opticon.game;
    return { prisoners: g.prisoners.length, grace: g.graceRounds };
  });
  check(setup.prisoners === 1, "the tutorial runs alone (no AI companions)");
  check(setup.grace === null || setup.grace > 1e9, "the eye is asleep while lessons run"); // Infinity serialises to null

  // Card position: under the rail, above the dock, on screen.
  const layout = async () => page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const c = r("tutorialCard"), top = document.querySelector(".topbar").getBoundingClientRect(), dock = r("touchControls");
    return { inView: c.left >= 0 && c.right <= innerWidth && c.top >= 0, clearTop: c.top >= top.bottom - 1, clearDock: c.bottom <= dock.top + 1 };
  });
  let L = await layout();
  check(L.inView && L.clearTop && L.clearDock, "card sits between the top rail and the dock (desktop)");

  let c = await card();
  check(c.visible && c.id === "plan", "step 1 card is shown");

  // Robot: press what the card names, step by step.
  let caught = false;
  const watchCaught = async () => { if (await page.evaluate(() => window.__opticon.game.prisoners[0].custody > 0)) caught = true; };

  check(c.text.includes(KEYS.keyboard.move), "card says which keys plan a move");
  await plan(1);
  c = await card();
  check(c.id === "commit", "planning a step passes 'plan'");

  check(c.text.includes(KEYS.keyboard.commit), "card names the commit key");
  await press("Space", 900);
  c = await card();
  check(c.id === "end", "committing passes 'commit'");

  await press("Space", 300);
  await humanTurn(); await watchCaught();
  c = await card();
  check(c.id === "noise", "ending the turn passes 'end'");

  let tries = 0;
  while ((await card()).id === "noise" && tries++ < 4) {
    if (!(await plan(2))) await plan(1);
    await commitAndEnd(); await watchCaught();
  }
  check((await card()).id === "shadow", "a 2+ tile turn passes 'noise'");

  tries = 0;
  while ((await card()).id === "shadow" && tries++ < 8) {
    await plan(1);
    await commitAndEnd(); await watchCaught();
  }
  check((await card()).id === "view", "ending a turn in shadow passes 'shadow'");
  check(!caught, "the eye caught nobody while lessons ran");

  c = await card();
  check(c.text.includes(KEYS.keyboard.view), "card names the view key");
  await press("KeyV", 300);
  c = await card();
  const awake = await page.evaluate(() => window.__opticon.game.graceRounds);
  check(c.id === "gate" && awake === 0, "changing the view reaches the escape lesson, and the eye wakes");

  const esc = await driveEscape(page);
  check(esc.ok, `escape setup ran (${esc.reason || "ok"})`);
  let over = null;
  for (let i = 0; i < 40 && !over; i++) {
    over = await page.evaluate(() => {
      const o = document.getElementById("overlay");
      return o.classList.contains("hidden") ? null : document.getElementById("overlayText").textContent;
    });
    if (!over) await page.waitForTimeout(150);
  }
  check(!!over && over.includes("Lesson complete"), "escaping ends lesson 1 on 'Lesson complete'");
  check((await page.textContent("#btnRestart2")) === "Next lesson", "the result screen offers Next lesson");
  check(!(await card()).visible, "the card is gone once the tutorial is finished");
  check((await page.evaluate(() => localStorage.getItem("opticon.record.v1"))) === recordBefore, "the W/L record is untouched");

  // Skip: restart into a fresh tutorial and leave at once.
  await page.evaluate(() => document.getElementById("btnRestart").click());
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await humanTurn();
  check((await page.evaluate(() => window.__opticon.tutorial.lesson.id)) === "yard", "Next lesson starts lesson 2");
  await press("Escape", 300);
  const afterSkip = await page.evaluate(() => ({ grace: window.__opticon.game.graceRounds, hidden: document.getElementById("tutorialCard").classList.contains("hidden") }));
  check(afterSkip.hidden, "Esc skips the lesson: card gone, game carries on");

  // Phone width: card still fits and clears the rail.
  await page.evaluate(() => document.getElementById("btnRestart").click());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  L = await layout();
  check(L.inView && L.clearTop && L.clearDock, "card sits between the top rail and the dock (phone)");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));
  await browser.close();
  server.close();
  console.log(ok ? "\n✓ tutorial passed" : "\n✗ tutorial failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("TUTORIAL TEST FAILED:", e);
  process.exit(1);
});
