// Shared browser resolution for the headless tests. Every browser test used to
// hardcode /opt/pw-browsers/chromium-1194/..., so the whole suite went red the
// day the container shipped a newer Chromium. Resolve it instead:
//   playwright: $PLAYWRIGHT_PATH, else a normal require, else the global install
//   chromium:   $CHROMIUM_PATH, else a pre-installed /opt/pw-browsers build,
//               else undefined (Playwright's own bundled browser)
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright"];
  try { candidates.push(path.join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")); } catch {}
  candidates.push("/opt/node22/lib/node_modules/playwright");
  for (const c of candidates.filter(Boolean)) {
    try { return require(c); } catch {}
  }
  throw new Error("playwright not found: set PLAYWRIGHT_PATH or install playwright");
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = "/opt/pw-browsers";
  const found = [path.join(root, "chromium")];
  try {
    for (const d of fs.readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const sub of ["chrome-linux64", "chrome-linux"]) found.push(path.join(root, d, sub, "chrome"));
    }
  } catch {}
  return found.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

export const { chromium } = loadPlaywright();
export const chromiumPath = findChromium();
