// Capture all camera views for visual review.
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 8202;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter"); await page.waitForTimeout(700);
  await page.click('[data-diff="medium"]');
  await page.waitForTimeout(200);
  await page.click("#playWatcher"); // human watcher => watcher view, reveals structure
  await page.waitForTimeout(200);
  await page.waitForTimeout(1000);

  // Force each view and screenshot.
  for (const view of ["overview", "watcher", "prisoner"]) {
    await page.evaluate((v) => window.__opticon && window.__opticon.renderer.setViewMode(v) || (window.__opticon.viewMode = v), view);
    await page.evaluate((v) => { window.__opticon.viewMode = v; window.__opticon.renderer.setViewMode(v); }, view);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(ROOT, "tests", `view-${view}.png`) });
  }
  console.log("errors:", errors.length, errors.slice(0,5));
  await browser.close();
  server.close();
})();
