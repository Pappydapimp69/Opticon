// fkey-passthrough.mjs — Headless check that function keys (F1-F12, incl.
// F11 fullscreen) are never captured by the game's keyboard handler, in any
// input mode. Before this fix, "intro" and "pass" modes called
// e.preventDefault() unconditionally on every keydown, which silently ate
// F11 and blocked the browser's native fullscreen toggle whenever the intro
// splash or a hotseat pass-device screen was up.
// Run: node game/tests/fkey-passthrough.mjs
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

async function f11IsUnprevented(page) {
  return page.evaluate(() => {
    const ev = new KeyboardEvent("keydown", { code: "F11", key: "F11", cancelable: true, bubbles: true });
    window.dispatchEvent(ev);
    return !ev.defaultPrevented;
  });
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

  // Mode: intro (the splash screen used to eat every key unconditionally).
  check(await f11IsUnprevented(page), "F11 is not preventDefault()'d during the intro splash");
  const introHidden = await page.$eval("#intro", (el) => el.classList.contains("hidden"));
  check(!introHidden, "F11 does not dismiss the intro splash");

  // Mode: menu.
  await page.keyboard.down("Space");
  await page.waitForTimeout(750);
  await page.keyboard.up("Space");
  await page.waitForTimeout(700);
  check(await f11IsUnprevented(page), "F11 is not preventDefault()'d on the menu screen");

  // Mode: game.
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(150);
  await page.click("#playPrisoner");
  await page.waitForTimeout(150);
  await page.hover("#btnStart");
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(await f11IsUnprevented(page), "F11 is not preventDefault()'d during gameplay");

  check(errors.length === 0, `no console errors (${errors.length} found)`);
  errors.slice(0, 10).forEach((e) => console.log("    •", e));

  await browser.close();
  server.close();
  console.log(ok ? "\n✓ fkey-passthrough passed" : "\n✗ fkey-passthrough failed");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("FKEY-PASSTHROUGH TEST FAILED:", e);
  process.exit(1);
});
