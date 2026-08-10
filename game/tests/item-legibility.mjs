// item-legibility.mjs — An icon and a noun are not a rule.
//
// Reported from play: "Items exist and have icons, but they have no description
// or clear use case. Like the scissors for example. I picked up a pair, but had
// no idea what it was used for." Pickup is automatic — you walk over a thing
// and now you carry it — so there is no inspect step where the rule could have
// been read. The chip said "✂️ Cutters" and that was the whole briefing.
//
// Every item must therefore carry its own copy, and that copy must reach the
// screen: a caption under the chips saying what the highlighted item does and
// what to press next, and a hint bar that changes when an item is armed (the
// step that previously looked like a dead button, since arming a targeted item
// has no visible effect until a direction follows).
// Run: node game/tests/item-legibility.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ITEM_INFO, ITEM_KINDS } from "../src/map.js";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8213;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}

// ---- 1. The data itself: no item may ship without its rule ---------------
// Cheap, and it is the part that actually prevents a repeat: a new item added
// with only a label and an icon fails here before anyone has to play it.
for (const kind of Object.values(ITEM_KINDS)) {
  const info = ITEM_INFO[kind];
  const named = `${info?.icon || "?"} ${info?.label || kind}`;
  check(!!info?.blurb && info.blurb.length > 25, `${named}: says what it DOES (${info?.blurb?.length || 0} chars)`);
  check(!!info?.use && info.use.length > 8, `${named}: says how to USE it`);
  check(typeof info?.targeted === "boolean", `${named}: declares whether it needs a direction`);
}
// A targeted item is the one that looks broken without instructions, so its
// `use` has to actually mention aiming rather than just restating the effect.
for (const kind of Object.values(ITEM_KINDS)) {
  const info = ITEM_INFO[kind];
  if (!info.targeted) continue;
  check(/direction/i.test(info.use), `${info.icon} ${info.label}: its instruction names the direction step`);
}

const serve = () =>
  http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });

const server = serve();
await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.keyboard.down("Space");
await page.waitForTimeout(800);
await page.keyboard.up("Space");
await page.waitForTimeout(300);
await page.click('[data-diff="medium"]');
await page.waitForTimeout(200);
await page.click("#playPrisoner");
await page.waitForTimeout(200);
await page.hover("#btnStart");
await page.mouse.down();
await page.waitForTimeout(800);
await page.mouse.up();
await page.waitForTimeout(500);
await page.evaluate(() => window.__opticon.renderer.skipIntro());
await page.waitForFunction(() => window.__opticon?.game, null, { timeout: 15000 });

const give = async (items) => {
  await page.evaluate((items) => {
    const g = window.__opticon.game;
    g.turn = "Prisoner";
    g.activePrisoner = 0;
    g.prisoners[0].items = items;
  }, items);
  await page.waitForTimeout(300); // the bar repaints on the next animation frame
};
const read = () =>
  page.evaluate(() => ({
    caption: document.getElementById("itemCaption")?.textContent || "",
    captionHidden: !!document.getElementById("itemCaption")?.classList.contains("empty"),
    hint: document.getElementById("hint")?.textContent || "",
  }));

// ---- 2. Carrying nothing shows no caption --------------------------------
{
  await give([]);
  const r = await read();
  check(r.captionHidden, "with empty hands the caption is hidden, not blank furniture");
}

// ---- 3. The caption explains the item you are holding --------------------
// The reported case, verbatim: pick up scissors, learn what scissors do.
{
  await give([ITEM_KINDS.CUTTERS, ITEM_KINDS.LOCKPICK]);
  const r = await read();
  const info = ITEM_INFO[ITEM_KINDS.CUTTERS];
  check(!r.captionHidden, "carrying something shows the caption");
  check(r.caption.includes(info.label), `the caption names the item (${info.label})`);
  check(r.caption.includes(info.blurb), "the caption states what it does, not just its name");
  check(r.caption.includes(info.use), "the caption states what to press next");
}

// ---- 4. Untargeted items say so instead of implying a missing step -------
{
  await give([ITEM_KINDS.MUFFLE, ITEM_KINDS.FEATHER]);
  const r = await read();
  check(r.caption.includes(ITEM_INFO[ITEM_KINDS.MUFFLE].blurb), "Muffle explains itself too");
  check(/spends the moment/i.test(r.caption), "and says it resolves immediately, with no direction to give");
}

// ---- 5. Arming a targeted item visibly changes the instructions ----------
// The dead-button moment: arming Cutters does nothing on screen until a
// direction follows, so the hint bar has to admit the game is waiting.
{
  await give([ITEM_KINDS.CUTTERS, ITEM_KINDS.DISTRACT]);
  const before = await read();
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(350);
  const after = await read();
  check(after.hint !== before.hint, "arming an item changes the hint bar");
  check(/armed/i.test(after.hint), `the hint says the item is armed (got "${after.hint}")`);
  check(after.hint.includes(ITEM_INFO[ITEM_KINDS.CUTTERS].label), "and names which item is waiting");
  check(/cancel/i.test(after.hint), "and says how to back out");
  check(/armed/i.test(after.caption), "the caption switches to its armed phrasing as well");
  // Cancel restores the ordinary hint — arming must not be a one-way door.
  await page.keyboard.press("Digit1");
  await page.waitForTimeout(350);
  const cancelled = await read();
  check(!/armed/i.test(cancelled.hint), "pressing it again cancels and restores the normal hint");
}

// ---- 6. The caption follows the gamepad's selected slot -------------------
// On a pad there is no pointer, so the highlighted chip is the only "which one
// am I about to use" signal — the caption has to track it.
{
  await give([ITEM_KINDS.DISTRACT, ITEM_KINDS.LOCKPICK]);
  const first = await read();
  check(first.caption.includes(ITEM_INFO[ITEM_KINDS.DISTRACT].label), "slot 1 described by default");
  await page.evaluate(() => window.__opticon.game && window.dispatchEvent(new Event("blur")));
  await page.keyboard.press("Digit2");
  await page.waitForTimeout(350);
  const second = await read();
  check(second.caption.includes(ITEM_INFO[ITEM_KINDS.LOCKPICK].label),
    "arming slot 2 moves the description to that item");
}

// ---- 7. The caption must not break the dock layout -----------------------
// It is a new element in a column that already fits three others; a wrapped
// caption that pushes the hint bar off-screen would trade one problem for
// another. Checked at a phone width, where the copy is longest relative to
// the viewport.
{
  await page.setViewportSize({ width: 390, height: 760 });
  await give([ITEM_KINDS.CUTTERS, ITEM_KINDS.DISTRACT]);
  await page.waitForTimeout(400);
  const box = await page.evaluate(() => {
    const cap = document.getElementById("itemCaption");
    const hint = document.getElementById("hint");
    const c = cap.getBoundingClientRect();
    const h = hint.getBoundingClientRect();
    return {
      capRight: c.right, capLeft: c.left, capBottom: c.bottom, capTop: c.top,
      hintTop: h.top, w: window.innerWidth, hInner: window.innerHeight,
    };
  });
  check(box.capLeft >= 0 && box.capRight <= box.w + 0.5, `the caption stays inside a 390px viewport (${box.capLeft.toFixed(0)}-${box.capRight.toFixed(0)})`);
  check(box.capBottom <= box.hInner + 0.5, "and does not run off the bottom of the screen");
  check(box.capBottom <= box.hintTop + 0.5, "and does not overlap the hint bar below it");
  await page.setViewportSize({ width: 1280, height: 800 });
}

check(errors.length === 0, `no console errors (${errors.length} found)`);
if (errors.length) console.log(errors.slice(0, 5));

await browser.close();
server.close();
console.log(ok ? "\n✓ item-legibility passed" : "\n✗ item-legibility failed");
process.exit(ok ? 0 : 1);
