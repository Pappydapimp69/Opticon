// runner-coverage.mjs — every test file must actually be run by run-all.sh.
// 13 tests once sat unwired for weeks: a file that never runs never fails.
// Run: node game/tests/runner-coverage.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = new Set(["browser.mjs"]); // imported by tests, not tests themselves
const runner = fs.readFileSync(path.join(dir, "run-all.sh"), "utf8");
const missing = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".mjs") && !HELPERS.has(f))
  .filter((f) => !new RegExp(`node tests/${f.replace(".", "\\.")}\\b`).test(runner));

if (missing.length) {
  console.log("✗ not run by run-all.sh: " + missing.join(", "));
  process.exit(1);
}
console.log("✓ every test file is wired into run-all.sh");
