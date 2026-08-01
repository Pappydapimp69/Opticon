#!/usr/bin/env node
// brain-viz.mjs — Opticon's own view of its Brain-linked knowledge.
//
// The generic `brain viz` command (see Brain/bin/brain) renders a
// project-agnostic HTML page. This is a from-scratch alternative styled
// after Opticon itself: a tower at the center, a slow gaze sweep, and the
// project's memory/tension/idea entries laid out in rings around it — the
// same visual grammar (wedges, quadrants, the cyan/red/green palette from
// css/style.css) the game already uses to represent watching something.
//
// Reads directly from the linked Brain cache (never edits it) and writes
// one self-contained static HTML file. No dependencies, no build step.
//
// Run: node tools/brain-viz.mjs [--out docs/brain-viz.html]
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function cachePath() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".brain", "config.json"), "utf8"));
    if (cfg && cfg.cache) return cfg.cache;
  } catch {
    /* fall through to default */
  }
  return path.join(process.env.HOME || "/root", ".brain");
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// ---- Memory: .brain/memory/projects/pappydapimp69__opticon.md ------------
// Format (see .brain/memory/incoming/TEMPLATE.md):
//   ## E<id> — <title>
//   - Date: YYYY-MM-DD
//   - Tags: [a][b][c]
//   - What: ...
//   - ... more "- Field: value" lines ...
function parseMemory(text) {
  const chunks = text.split(/\n(?=## E\d+)/);
  const entries = [];
  for (const chunk of chunks) {
    const header = chunk.match(/^## (E\d+) — (.+)$/m);
    if (!header) continue;
    const fields = {};
    for (const line of chunk.split("\n")) {
      const m = line.match(/^- ([A-Za-z][\w \/()]*?): (.*)$/);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }
    const tags = [...(fields.tags || "").matchAll(/\[([\w-]+)\]/g)].map((m) => m[1]);
    entries.push({
      id: header[1],
      title: header[2].trim(),
      date: fields.date || "",
      tags,
      what: fields.what || "",
      rule: fields["rule of thumb"] || "",
      verified: /^verified/i.test(fields["provenance (verified/assumed)"] || ""),
    });
  }
  entries.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return entries;
}

// ---- Tensions: Tension/tension-ledger.md, the Opticon section only -------
// Section boundaries are the ledger's own "## Project: X" headers — more
// reliable than keyword-matching prose (which is exactly the false-positive
// failure mode Tension T27, filed this same session, is about).
function parseTensions(text) {
  const start = text.indexOf("## Project: Opticon");
  if (start === -1) return [];
  const nextSection = text.indexOf("\n## ", start + 1);
  const section = nextSection === -1 ? text.slice(start) : text.slice(start, nextSection);
  const chunks = section.split(/\n(?=### T\d)/);
  const entries = [];
  for (const chunk of chunks) {
    const header = chunk.match(/^### T(\d+) · ([\w-]+) · (.+)$/m);
    if (!header) continue;
    const [, num, kind, rest] = header;
    const markerMatch = rest.match(/[✅🔴🟡🟢]/u);
    let title = rest;
    let statusText = "";
    if (markerMatch) {
      title = rest.slice(0, markerMatch.index).replace(/[\s—-]+$/, "").trim();
      statusText = rest.slice(markerMatch.index).trim();
    } else {
      const leanLine = chunk.match(/^Lean: (.+)$/m);
      if (leanLine) statusText = leanLine[1].trim();
    }
    const marker = (statusText.match(/[✅🔴🟡🟢]/u) || [])[0] || "🔴";
    const status = marker === "✅" || marker === "🟢" ? "resolved" : marker === "🟡" ? "leaning" : "open";

    const bodyEnd = chunk.search(/\n(Poles:|Lean:|Updates:|Source:)/);
    const body = (bodyEnd === -1 ? chunk : chunk.slice(0, bodyEnd))
      .split("\n")
      .slice(1) // drop the header line itself
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    entries.push({
      id: `T${num}`,
      kind,
      title,
      status,
      statusText: statusText || (status === "open" ? "open" : status),
      summary: body.length > 320 ? body.slice(0, 317) + "…" : body,
    });
  }
  entries.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return entries;
}

// ---- Ideas: ideas/idea-repository.md, kernels that cite Opticon ----------
// Header: "## [DOMAIN / subdomain / slug / detail]". Idea kernels have no
// per-project field the way memory entries do, so inclusion is "the kernel
// mentions Opticon anywhere" — a false positive here just decorates one
// extra dot rather than blocking a commit, so the bar is lower than T27's.
function parseIdeas(text) {
  const chunks = text.split(/\n(?=## \[)/);
  const entries = [];
  for (const chunk of chunks) {
    const header = chunk.match(/^## \[(.+)\]\s*$/m);
    if (!header) continue;
    if (!/opticon/i.test(chunk)) continue;
    const parts = header[1].split("/").map((s) => s.trim());
    const sourceLine = chunk.match(/^Source: (.+)$/m);
    const bodyEnd = chunk.search(/\n(Source:)/);
    const body = (bodyEnd === -1 ? chunk : chunk.slice(0, bodyEnd))
      .split("\n")
      .slice(1)
      .join(" ")
      .replace(/<!--.*?-->/gs, "")
      .replace(/\s+/g, " ")
      .trim();
    entries.push({
      domain: parts[0] || "SYSTEM",
      slug: parts[2] || parts[1] || parts[0],
      title: parts[parts.length - 1] || parts[0],
      summary: body.length > 300 ? body.slice(0, 297) + "…" : body,
      source: sourceLine ? sourceLine[1].trim() : "",
    });
  }
  return entries;
}

const cache = cachePath();
const memory = parseMemory(readIfExists(path.join(cache, "memory", "projects", "pappydapimp69__opticon.md")));

// Tensions come from the sibling Tension checkout, NOT the Brain cache, if
// it's available. Discovered building this: the tension ledger has no
// promote-to-main step the way memory/ideas do (their steward pushes
// straight to main regardless of which branch triggered `brain sync`) — a
// tension edited and pushed to a feature branch, as this whole session's
// work on T25/T27 was, sits there until someone opens and merges a PR for
// the Tension repo specifically, which nothing in this workflow ever does.
// `brain update` reported success but the cache stayed on an old T25 and
// never saw T27 at all. Preferring the actual working copy sidesteps that
// gap rather than rendering a visualization that contradicts what was just
// shipped this session.
const siblingLedger = path.join(REPO_ROOT, "..", "Tension", "tension-ledger.md");
const ledgerPath = fs.existsSync(siblingLedger) ? siblingLedger : path.join(cache, "Tension", "tension-ledger.md");
const tensions = parseTensions(readIfExists(ledgerPath));

const ideas = parseIdeas(readIfExists(path.join(cache, "ideas", "idea-repository.md")));

if (!memory.length && !tensions.length && !ideas.length) {
  console.error(`No data found under Brain cache "${cache}" — is this project linked (\`brain link\`)?`);
  process.exit(1);
}

const data = { memory, tensions, ideas, generated: new Date().toISOString().slice(0, 10) };

// ---- Render ---------------------------------------------------------------
const TEMPLATE = fs.readFileSync(path.join(__dirname, "brain-viz.template.html"), "utf8");
const html = TEMPLATE.replace("/*__DATA__*/", JSON.stringify(data));

const outArg = process.argv.indexOf("--out");
const outPath = path.resolve(REPO_ROOT, outArg !== -1 ? process.argv[outArg + 1] : "docs/brain-viz.html");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(
  `wrote ${path.relative(REPO_ROOT, outPath)} — ${memory.length} memory, ${tensions.length} tensions, ${ideas.length} ideas`
);
