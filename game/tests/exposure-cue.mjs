// exposure-cue.mjs — Headless check of the exposure vignette (dangerVignette
// class toggling on isExposed) and the log-leak fix (the Watcher's real
// rotation must never reach a Prisoner-role viewer's log).
// Run: node game/tests/exposure-cue.mjs
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8209;

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
  await page.waitForTimeout(500);
  await page.click("#playPrisoner");
  await page.waitForTimeout(200);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(300);

  // Force the prisoner onto a lit tile (deterministic exposure) and let a
  // frame tick so updateDangerVignette() picks it up.
  const litResult = await page.evaluate(() => {
    const a = window.__opticon;
    const g = a.game;
    const p = g.prisoners[g.activePrisoner];
    const light = g.map.lights.find((l) => g.lightState[l.group]);
    if (!light) return { found: false };
    p.x = light.x; p.y = light.y;
    return { found: true };
  });
  check(litResult.found, "map has an active light to test against");
  await page.waitForTimeout(150);

  let hasDangerClass = await page.$eval("#dangerVignette", (el) => el.classList.contains("danger"));
  check(hasDangerClass, "vignette shows 'danger' class when the prisoner is lit (exposed)");

  // Move off any light: exposure should clear next frame.
  await page.evaluate(() => {
    const a = window.__opticon;
    const g = a.game;
    const p = g.prisoners[g.activePrisoner];
    // A far corner is very unlikely to be inside any light radius.
    p.x = 1; p.y = 1;
  });
  await page.waitForTimeout(150);
  hasDangerClass = await page.$eval("#dangerVignette", (el) => el.classList.contains("danger"));
  check(!hasDangerClass, "vignette clears once the prisoner is no longer exposed");

  // Log-leak check: end a couple of turns so the AI Watcher rotates, then
  // confirm the log never contains the real-facing phrase for a Prisoner-
  // role viewer (the bluff "declares eyes on" line is fine and expected).
  await page.keyboard.press("Space"); // end prisoner turn -> AI watcher acts
  await page.waitForTimeout(1200);
  const logText = await page.$eval("#log", (el) => el.textContent);
  check(!/turns to face/.test(logText), `log never leaks the Watcher's real rotation to the Prisoner (log: "${logText.slice(0, 200)}")`);

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ exposure-cue passed" : "\n✗ exposure-cue failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("EXPOSURE-CUE TEST FAILED:", e);
  process.exit(1);
});
