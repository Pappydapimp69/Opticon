// hud-layout.mjs — Geometry assertions on the HUD, at several viewports.
//
// The HUD used to be a pile of independently-positioned pieces at hand-tuned
// `bottom:` offsets (122px / 130px / 150px / 210px) with the skill names
// absolutely positioned under fixed-width chips. The failure modes were all
// invisible to every existing test, because nothing asserted on geometry:
//   - "Remote lock" / "Dispatch guards" labels drew over each other;
//   - the status rail wrapped to three ragged rows on a phone and orphaned
//     the Restart button;
//   - later, over-correcting to `nowrap` let values paint over their
//     neighbours, then clipped them.
// So this checks the things a screenshot would show a person: nothing
// overlaps, nothing overflows the viewport, nothing is clipped.
// Run: node game/tests/hud-layout.mjs
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
const PORT = 8235;
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

async function pollUntil(page, predicate, timeoutMs = 15000, arg) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function start(page, role) {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height - 60);
  await page.mouse.down();
  const opened = await pollUntil(page, () => !document.getElementById("menu").classList.contains("hidden"), 6000);
  await page.mouse.up();
  if (!opened) throw new Error("intro hold did not open the menu");
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(100);
  await page.click(role === "Watcher" ? "#playWatcher" : "#playPrisoner");
  await page.waitForTimeout(100);
  const box = await (await page.$("#btnStart")).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const started = await pollUntil(page, () => !!window.__opticon?.game, 6000);
  await page.mouse.up();
  if (!started) throw new Error("Start hold did not create a game");
  await page.evaluate(() => window.__opticon.renderer.skipIntro());
  await pollUntil(page, (r) => {
    const t = document.getElementById("turnLabel").textContent.trim();
    return r === "Watcher" ? t === "Watcher" : t.startsWith("Prisoner");
  }, 20000, role);
  // The ability bars are rebuilt from loop(), a frame or two after the turn
  // label changes — measuring too early silently yields an empty skill bar
  // and a test that passes because it found nothing to check.
  await pollUntil(page, () =>
    document.querySelectorAll("#skillBar .item-chip, #prisonerControls .tbtn").length > 0, 8000);
  await page.waitForTimeout(400);
}

// Boxes of every VISIBLE hud element that owns screen space, plus the list
// of genuinely-colliding pairs. Overlap is computed IN the page so DOM
// nesting is available: a name label lives inside its own chip, so it always
// intersects it — that is containment, not a collision, and comparing
// serialized rectangles alone cannot tell the two apart.
const measure = (page) => page.evaluate(() => {
  const sel = [
    "#turnLabel", "#roundLabel", "#mpLabel", "#facingLabel", "#rosterLabel",
    "#zoneLabel", "#roleLabel", "#viewLabel",
    "#btnSound", "#btnMenu", "#btnRestart",
    "#commitBtn", ".viewbtn", "#hint",
    "#itemBar .item-chip", "#skillBar .item-chip",
    // The NAME labels, not just the chips: the original defect was labels
    // overflowing a fixed-width chip and drawing over each other, which a
    // chip-only measurement cannot see at all.
    "#itemBar .iname", "#skillBar .iname",
    "#prisonerControls .tbtn", "#watcherControls .tbtn",
  ];
  const items = [];
  for (const s of sel) {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
      let p = el, hidden = false;
      while (p && p !== document.body) {
        if (p.classList?.contains("hidden") || getComputedStyle(p).display === "none") { hidden = true; break; }
        p = p.parentElement;
      }
      if (hidden) continue;
      items.push({ el, sel: s, text: (el.textContent || "").trim().slice(0, 22), r });
    }
  }
  const hit = (a, b) =>
    a.r.left < b.r.right - 0.5 && b.r.left < a.r.right - 0.5 &&
    a.r.top < b.r.bottom - 0.5 && b.r.top < a.r.bottom - 0.5;
  const collisions = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue; // nesting, not collision
      if (hit(a, b)) collisions.push(`${a.sel}"${a.text}" ∩ ${b.sel}"${b.text}"`);
    }
  }
  return {
    collisions,
    boxes: items.map((it) => ({
      sel: it.sel, text: it.text,
      x: it.r.x, y: it.r.y, right: it.r.right, bottom: it.r.bottom,
      scrollW: it.el.scrollWidth, clientW: it.el.clientWidth,
    })),
  };
});

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const errors = [];

  const CASES = [
    { name: "desktop watcher", w: 1280, h: 800, role: "Watcher" },
    { name: "desktop prisoner", w: 1280, h: 800, role: "Prisoner" },
    { name: "phone watcher", w: 390, h: 844, role: "Watcher" },
    { name: "phone prisoner", w: 390, h: 844, role: "Prisoner" },
    { name: "small phone prisoner", w: 320, h: 640, role: "Prisoner" },
  ];

  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: c.w, height: c.h } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${c.name}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${c.name}: ${e.message}`));
    await start(page, c.role);

    const { boxes: bs, collisions: hits } = await measure(page);
    console.log(`  — ${c.name} (${bs.length} visible elements)`);
    // Guard against a vacuous pass: this test measured only 12 chrome
    // elements and zero chips on its first run, so it reported "no overlap"
    // about a HUD whose colliding parts had not rendered yet. Assert the
    // interactive parts are actually present rather than a raw total, which
    // legitimately varies (the smallest phone hides Crew and Zone).
    const controls = bs.filter((b) => /item-chip|iname|tbtn/.test(b.sel) ||
      b.sel === "#commitBtn" || b.sel === ".viewbtn").length;
    check(controls >= 5, `${c.name}: measured a populated HUD (${controls} controls, ${bs.length} total)`);

    // 1. Nothing overlaps anything else (nesting excluded, see measure()).
    check(hits.length === 0, `${c.name}: no HUD element overlaps another`);
    hits.slice(0, 4).forEach((h) => console.log("      •", h));

    // 2. Nothing sits outside the viewport.
    const out = bs.filter((b) => b.x < -0.5 || b.y < -0.5 || b.right > c.w + 0.5 || b.bottom > c.h + 0.5);
    check(out.length === 0, `${c.name}: every HUD element is inside the viewport`);
    out.slice(0, 4).forEach((b) => console.log(`      • ${b.sel}"${b.text}" x=${b.x.toFixed(0)} right=${b.right.toFixed(0)} bottom=${b.bottom.toFixed(0)}`));

    // 3. No text is clipped by its own box (the failure that replaced overlap).
    const clipped = bs.filter((b) => b.scrollW > b.clientW + 1);
    check(clipped.length === 0, `${c.name}: no stat value is cut off`);
    clipped.slice(0, 4).forEach((b) => console.log(`      • ${b.sel}"${b.text}" scrollW=${b.scrollW} clientW=${b.clientW}`));

    // 4. The status rail stays a single line — wrapping is what produced the
    //    three ragged rows and the orphaned button on a phone. Measured as the
    //    rail's own height, not by bucketing element tops: a stat is a
    //    two-line label+value column while a button is centred, so they
    //    legitimately have different tops on the SAME visual row.
    const railH = await page.evaluate(() => {
      const el = document.querySelector(".topbar");
      return Math.max(el.getBoundingClientRect().height, el.scrollHeight);
    });
    check(railH <= 58, `${c.name}: the status rail is a single row (height ${railH.toFixed(0)}px)`);

    await page.close();
  }

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 5).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ hud-layout passed" : "\n✗ hud-layout failed");
  process.exit(ok ? 0 : 1);
})();
