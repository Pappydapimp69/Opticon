#!/usr/bin/env node
// brain-viz.mjs — the static, interactive view of the whole Brain cognitive
// system: every memory lesson, tension, idea kernel, and exploration entry
// across every linked project, laid out on one time spiral (day one at the
// tower, today at the rim). Hover for detail, filter by project, click a
// legend swatch to hide a type.
//
// This is the EXPLORE view — cheap to render, no continuous animation, safe
// to leave open. For the narrated, animated version, see
// render-brain-movie.mjs, which pre-renders an actual video file instead of
// running the animation live in the browser (see that file's own header for
// why: a live 1000+-node simulation was too demanding to run continuously).
//
// Run: node tools/brain-viz.mjs [--out docs/brain-viz.html]
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildBrainData } from "./brain-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const data = buildBrainData(REPO_ROOT);
if (data.omitted) console.log(`(${data.omitted} entries had no usable date and were omitted from the spiral)`);

if (process.env.BRAIN_VIZ_DEBUG_DATA) fs.writeFileSync(process.env.BRAIN_VIZ_DEBUG_DATA, JSON.stringify(data));

// ---- Render ---------------------------------------------------------------
const TEMPLATE = fs.readFileSync(path.join(__dirname, "brain-viz.template.html"), "utf8");
// A function replacer, NOT a string one: String.replace(pattern, str) treats
// $&/$`/$'/$$ in `str` as special substitution tokens, and the corpus is
// large enough to contain them by accident — e.g. an idea entry discussing
// the regex `(a+)+$` followed by a markdown code-span backtick produces the
// literal substring "$`", which means "insert everything before the match"
// and spliced this whole template's own <head> into the middle of a JSON
// string when passed as a plain string replacement. A function's return
// value is inserted verbatim, with no token interpretation.
const html = TEMPLATE.replace("/*__DATA__*/", () => JSON.stringify(data));

const outArg = process.argv.indexOf("--out");
const outPath = path.resolve(REPO_ROOT, outArg !== -1 ? process.argv[outArg + 1] : "docs/brain-viz.html");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(
  `wrote ${path.relative(REPO_ROOT, outPath)} — ${data.entries.length} entries ` +
    `(${data.counts.memory} memory, ${data.counts.tension} tensions, ${data.counts.idea} ideas, ${data.counts.exploration} exploration) ` +
    `across ${data.projects.length} projects, ${data.minDate} -> ${data.maxDate}`
);
