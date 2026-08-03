// no-conflict-markers.mjs — Refuse to ship unresolved merge conflict markers.
//
// This exists because they DID ship. A merge left `<<<<<<< HEAD` in
// index.html along with two <script type="module"> tags for the same file at
// different ?v= strings; the resolution pass only grepped the two files the
// merge output happened to name, not the whole tree. Nothing caught it: the
// markers are inert text to an HTML parser, so the page still rendered, the
// browser tests still passed, and the duplicate script tag loaded main.js
// TWICE as two separate module instances (two rAF loops, two input handlers,
// two audio graphs) without throwing anything a test was looking at.
//
// Also checks that each real asset is referenced exactly once, since the
// duplicate-script half of that failure would survive a marker-only check.
// Run: node game/tests/no-conflict-markers.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const EXTS = new Set([".js", ".mjs", ".html", ".css", ".sh", ".md", ".json", ".yml", ".yaml"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".brain"]);

// Anchored to line start: a bare "=======" is also a legal markdown heading
// underline, and "<<<" can appear inside prose, so match the exact shapes git
// writes rather than anything that merely contains them.
const MARKER = /^(<{7} |={7}$|>{7} |\|{7} )/;

let ok = true;
function check(cond, label) {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`);
  if (!cond) ok = false;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const offenders = [];
for (const file of files) {
  // This test necessarily contains marker-shaped strings in its own source.
  if (path.resolve(file) === path.resolve(__dirname, "no-conflict-markers.mjs")) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (MARKER.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.slice(0, 60)}`);
  });
}
check(offenders.length === 0, `no unresolved merge markers in ${files.length} tracked files`);
offenders.slice(0, 10).forEach((o) => console.log("    •", o));

// A merge can also duplicate a whole line cleanly, with no markers left over.
// The game's entry points must each appear exactly once: two module script
// tags for the same file at different ?v= strings load it twice.
const html = fs.readFileSync(path.join(ROOT, "game", "index.html"), "utf8");
const scriptTags = html.match(/<script[^>]*src="src\/main\.js/g) || [];
const styleTags = html.match(/<link[^>]*href="css\/style\.css/g) || [];
check(scriptTags.length === 1, `main.js is loaded exactly once (found ${scriptTags.length})`);
check(styleTags.length === 1, `style.css is linked exactly once (found ${styleTags.length})`);

// And every cache-buster must agree with the build the code reports, or a
// stale asset ships next to a fresh one.
const build = (fs.readFileSync(path.join(ROOT, "game", "src", "main.js"), "utf8")
  .match(/const BUILD = "([^"]+)"/) || [])[1];
const versions = [...new Set((html.match(/\?v=([\w.\-]+)/g) || []).map((v) => v.slice(3)))];
check(!!build, `main.js declares a BUILD string (got ${JSON.stringify(build)})`);
check(versions.length === 1 && versions[0] === build,
  `every ?v= cache-buster matches BUILD ${JSON.stringify(build)} (found ${JSON.stringify(versions)})`);

console.log(ok ? "\n✓ no-conflict-markers passed" : "\n✗ no-conflict-markers failed");
process.exit(ok ? 0 : 1);
