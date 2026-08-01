// brain-data.mjs — parses the whole Brain cognitive system (every memory
// lesson, tension, idea kernel, and exploration entry across every linked
// project) into one flat, dated entry list. Shared by both brain-viz.mjs
// (the static/interactive page) and render-brain-movie.mjs (the pre-rendered
// video) so the two never drift apart on what "the archive" actually contains.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export function cachePath(repoRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, ".brain", "config.json"), "utf8"));
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

// Most entries (memory) carry their own `- Date:` field. Tensions,
// exploration, and idea kernels don't — they're free-form prose files with
// no per-entry timestamp — so their date is instead the date the header
// LINE was introduced, via `git blame`. One blame call per file (not per
// entry) keeps this cheap even at hundreds of entries.
function blameDatesByLine(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    const out = execFileSync("git", ["blame", "--date=short", "-e", base], {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8");
    const dates = [];
    for (const line of out.split("\n")) {
      const m = line.match(/(\d{4}-\d{2}-\d{2})\s+\d+\)/);
      dates.push(m ? m[1] : null);
    }
    return dates; // dates[0] is line 1, etc.
  } catch {
    return [];
  }
}
function dateAtLine(blame, lineNum) {
  return blame[lineNum - 1] || null;
}
function lineNumberOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// ---- Memory: every file under <cache>/memory/projects/ --------------------
function parseMemoryFile(text, fallbackProject) {
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
      kind: "memory",
      id: header[1],
      title: header[2].trim(),
      date: fields.date || "",
      project: fields.project || fallbackProject,
      tags,
      what: fields.what || "",
      rule: fields["rule of thumb"] || "",
      verified: /^verified/i.test(fields["provenance (verified/assumed)"] || ""),
    });
  }
  return entries;
}

function parseAllMemory(cache) {
  const dir = path.join(cache, "memory", "projects");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const all = [];
  for (const f of files) {
    const fallback = f.replace(/\.md$/, "").replace(/__/g, "/");
    all.push(...parseMemoryFile(readIfExists(path.join(dir, f)), fallback));
  }
  return all;
}

// ---- Tensions: the whole ledger, sectioned by "## Project: X" -------------
// Tensions have no promote-to-main step the way memory/ideas do (their
// steward pushes straight to main regardless of source branch); a tension
// edited on a feature branch just sits there until someone opens and merges
// a PR for the Tension repo specifically, which nothing in this workflow
// ever does. Discovered building the Opticon-only version of this tool:
// `brain update` reported success but the canon cache stayed on an old T25
// and never saw T27. There's no fixing that for every OTHER project's
// tensions from here — this session only has this project's own checkouts
// — so the honest move is: read canon as the base (best available for
// everything this session didn't touch), then overlay this project's own
// section from its own sibling checkout, which is verifiably current.
function parseTensionsFromLedger(text, blame) {
  const entries = [];
  let project = null;
  const sectionRe = /^## Project: (.+)$/gm;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(text))) sections.push({ index: m.index, name: m[1].trim() });
  function projectAt(index) {
    let name = null;
    for (const s of sections) {
      if (s.index <= index) name = s.name;
      else break;
    }
    return name;
  }
  const chunks = text.split(/\n(?=### T)/);
  let cursor = 0;
  for (const chunk of chunks) {
    const idx = text.indexOf(chunk, cursor);
    cursor = idx + chunk.length;
    const header = chunk.match(/^### (T[\w-]+(?: recurrence)?) · ([\w-]+) · (.+)$/m);
    if (!header) continue;
    const [, id, kind, rest] = header;
    project = projectAt(idx);
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
      .slice(1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    entries.push({
      kind: "tension",
      id,
      title,
      status,
      statusText: statusText || status,
      project: project || "Brain",
      date: dateAtLine(blame, lineNumberOf(text, idx)),
      summary: body.length > 320 ? body.slice(0, 317) + "…" : body,
    });
  }
  return entries;
}

// ---- Ideas: kernels, no per-entry project field ----------------------------
function parseIdeas(text, blame) {
  const chunks = text.split(/\n(?=## \[)/);
  const entries = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const header = chunk.match(/^## \[(.+)\]\s*$/m);
    if (!header) continue;
    const idx = text.indexOf(chunk, cursor);
    cursor = idx + chunk.length;
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
      kind: "idea",
      id: parts[2] || parts[1] || parts[0],
      domain: parts[0] || "SYSTEM",
      title: parts[parts.length - 1] || parts[0],
      project: sourceLine ? sourceLine[1].trim().split(/[ ,]/)[0] : null,
      summary: body.length > 300 ? body.slice(0, 297) + "…" : body,
      date: dateAtLine(blame, lineNumberOf(text, idx)),
    });
  }
  return entries;
}

// ---- Exploration: same "## Project: X" sectioning as tensions -------------
function parseExploration(text, blame) {
  const entries = [];
  const sectionRe = /^## Project: (.+)$/gm;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(text))) sections.push({ index: m.index, name: m[1].trim() });
  function projectAt(index) {
    let name = null;
    for (const s of sections) {
      if (s.index <= index) name = s.name;
      else break;
    }
    return name;
  }
  const chunks = text.split(/\n(?=### )/);
  let cursor = 0;
  for (const chunk of chunks) {
    const idx = text.indexOf(chunk, cursor);
    cursor = idx + chunk.length;
    const header = chunk.match(/^### ([\w-]+) · (experiment|synthesis|speculation) · (.+?) · \*\*([^*]+)\*\*/m);
    if (!header) continue;
    const [, id, type, title, state] = header;
    const bodyEnd = chunk.search(/\n\n/);
    const body = (bodyEnd === -1 ? chunk : chunk.slice(0, bodyEnd))
      .split("\n")
      .slice(1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    entries.push({
      kind: "exploration",
      id,
      type,
      title: title.trim(),
      state: state.trim(),
      project: projectAt(idx) || "Brain",
      summary: body.length > 300 ? body.slice(0, 297) + "…" : body,
      date: dateAtLine(blame, lineNumberOf(text, idx)),
    });
  }
  return entries;
}

// ---- Assemble ---------------------------------------------------------------
export function buildBrainData(repoRoot) {
  const cache = cachePath(repoRoot);
  const memory = parseAllMemory(cache);

  const canonLedgerPath = path.join(cache, "Tension", "tension-ledger.md");
  const canonTensions = parseTensionsFromLedger(readIfExists(canonLedgerPath), blameDatesByLine(canonLedgerPath));

  const siblingLedgerPath = path.join(repoRoot, "..", "Tension", "tension-ledger.md");
  let tensions = canonTensions;
  if (fs.existsSync(siblingLedgerPath)) {
    const siblingAll = parseTensionsFromLedger(readIfExists(siblingLedgerPath), blameDatesByLine(siblingLedgerPath));
    const siblingOpticon = siblingAll.filter((t) => /opticon/i.test(t.project || ""));
    const overrideIds = new Set(siblingOpticon.map((t) => t.id));
    tensions = canonTensions.filter((t) => !overrideIds.has(t.id)).concat(siblingOpticon);
  }

  const ideasPath = path.join(cache, "ideas", "idea-repository.md");
  const ideas = parseIdeas(readIfExists(ideasPath), blameDatesByLine(ideasPath));

  const explorationPath = path.join(cache, "ideas", "exploration.md");
  const exploration = parseExploration(readIfExists(explorationPath), blameDatesByLine(explorationPath));

  const combined = [...memory, ...tensions, ...ideas, ...exploration];
  const all = combined.filter((e) => e.date);
  const omitted = combined.length - all.length;
  if (!all.length) {
    throw new Error(`No dated entries found under Brain cache "${cache}" — is this project linked (\`brain link\`)?`);
  }

  const projects = [...new Set(all.map((e) => e.project).filter(Boolean))].sort();
  const dates = all.map((e) => e.date).sort();
  const countOf = (kind) => all.filter((e) => e.kind === kind).length;
  return {
    entries: all,
    projects,
    minDate: dates[0],
    maxDate: dates[dates.length - 1],
    generated: new Date().toISOString().slice(0, 10),
    counts: { memory: countOf("memory"), tension: countOf("tension"), idea: countOf("idea"), exploration: countOf("exploration") },
    omitted,
  };
}
