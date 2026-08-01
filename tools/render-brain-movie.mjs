#!/usr/bin/env node
// render-brain-movie.mjs — pre-renders the animated, narrated view of the
// whole Brain archive to an actual video file, instead of simulating the
// animation live in a viewer's browser.
//
// The first version of "movie mode" ran the whole thing live: 1100+ SVG
// nodes in the DOM, a per-frame viewBox mutation forcing layout every
// frame, dozens of simultaneous CSS keyframe animations with drop-shadow
// filters on the biggest reveal days, and JS-scheduled Web Audio oscillators
// — reported back as "very demanding on the processor." A browser is very
// good at one thing here: decoding a video, in hardware, for free. So this
// renders the SAME animation (identical math to brain-viz-render.template
// .html, itself ported from the live version) frame-by-frame to PNGs with
// Playwright, renders the SAME drone/riser/stinger audio on an
// OfflineAudioContext (which can run faster than real time, since nothing
// here depends on a wall clock), and muxes both with ffmpeg into one MP4.
// A plain <video> tag costs the viewer nothing until they press play.
//
// Requires: ffmpeg on PATH.
// Run: node tools/render-brain-movie.mjs [--preview]
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { buildBrainData } from "./brain-data.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PREVIEW = process.argv.includes("--preview");

function assertFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    console.error("ffmpeg not found on PATH — install it first (apt-get install ffmpeg).");
    process.exit(1);
  }
}
assertFfmpeg();

const data = buildBrainData(REPO_ROOT);
if (data.omitted) console.log(`(${data.omitted} entries had no usable date and were omitted from the movie)`);

const TEMPLATE = fs.readFileSync(path.join(__dirname, "brain-viz-render.template.html"), "utf8");
// Function replacer — see brain-viz.mjs's own comment on this: a plain
// string replacement lets $&/$`/$'/$$ inside the JSON act as substitution
// tokens, which the corpus is large enough to trigger by accident.
const renderPageHtml = TEMPLATE.replace("/*__DATA__*/", () => JSON.stringify(data));

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-movie-"));
const renderPagePath = path.join(workDir, "render.html");
fs.writeFileSync(renderPagePath, renderPageHtml);
const framesDir = path.join(workDir, "frames");
fs.mkdirSync(framesDir);

const outDir = path.join(REPO_ROOT, "docs");
fs.mkdirSync(outDir, { recursive: true });
const mp4Path = path.join(outDir, "brain-viz-movie.mp4");
const webmPath = path.join(outDir, "brain-viz-movie.webm");
const posterPath = path.join(outDir, "brain-viz-poster.png");
const vttPath = path.join(outDir, "brain-viz-movie.vtt");

function vttTimestamp(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + sec.toFixed(3).padStart(6, "0");
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });

  await page.goto("file://" + renderPagePath);
  await page.waitForFunction(() => window.__READY__ === true, { timeout: 15000 });

  if (PREVIEW) {
    await page.evaluate(() => { window.MOVIE_CONFIG.durationMs = 4000; window.MOVIE_CONFIG.fps = 10; });
    console.log("--preview: rendering a short, low-fps pass to sanity-check the pipeline.");
  }

  const config = await page.evaluate(() => window.MOVIE_CONFIG);
  const totalFrames = Math.round((config.durationMs / 1000) * config.fps);
  console.log(`rendering ${totalFrames} frames at ${config.fps}fps (${config.width}x${config.height}, ${config.durationMs}ms)...`);

  const canvas = await page.$("#c");
  const t0 = Date.now();
  // The poster is a still someone sees before pressing play, not a frame
  // that has to exist mid-sequence — frame 0 is mid-fade-in-from-black by
  // design (every scene starts that way), so it makes a black square.
  // Grab the moment 2s into the movie instead, near where the title
  // card's own logo/text fade has settled.
  const posterFrame = Math.min(totalFrames - 1, Math.round(2 * config.fps));
  for (let i = 0; i < totalFrames; i++) {
    const progress = totalFrames > 1 ? i / (totalFrames - 1) : 1;
    await page.evaluate((p) => window.renderFrame(p), progress);
    const framePath = path.join(framesDir, `frame_${String(i).padStart(5, "0")}.png`);
    await canvas.screenshot({ path: framePath });
    if (i === posterFrame) fs.copyFileSync(framePath, posterPath);
    if (i % 100 === 0 || i === totalFrames - 1) {
      process.stdout.write(`\r  frame ${i + 1}/${totalFrames}`);
    }
  }
  process.stdout.write("\n");
  console.log(`frames captured in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- Captions (WebVTT) — one per scene, running for that scene's whole
  // duration (unlike the earlier spiral version, these are few and
  // well-separated, so there's no need to cap a caption short to avoid
  // colliding with the next one).
  const beats = await page.evaluate(() => window.getBeatsTiming());
  const durationS = config.durationMs / 1000;
  const vttLines = ["WEBVTT", ""];
  beats.forEach((b, i) => {
    const end = i < beats.length - 1 ? beats[i + 1].seconds : durationS;
    vttLines.push(String(i + 1), `${vttTimestamp(b.seconds)} --> ${vttTimestamp(Math.max(end, b.seconds + 1))}`, b.caption, "");
  });
  fs.writeFileSync(vttPath, vttLines.join("\n"));

  // ---- Audio (OfflineAudioContext, base64 WAV out) --------------------------
  console.log("rendering audio...");
  const audioB64 = await page.evaluate(() => window.renderAudio());
  const wavPath = path.join(workDir, "audio.wav");
  fs.writeFileSync(wavPath, Buffer.from(audioB64, "base64"));

  await browser.close();

  const realErrors = pageErrors.filter((e) => !/favicon/i.test(e));
  if (realErrors.length) {
    console.error("Errors during rendering:", realErrors);
    process.exit(1);
  }

  // ---- Mux with ffmpeg --------------------------------------------------------
  // Two outputs, not one: open-source Chromium builds (including the one
  // Playwright bundles, and some Linux distros' packaged Chromium) ship
  // WITHOUT the licensed H.264 decoder, so an mp4-only page silently fails
  // to play there (`networkState` reports NO_SOURCE, no error event at
  // all) — caught by testing this locally, which real end-user Google
  // Chrome/Edge would have hidden since those DO bundle H.264. WebM/VP9 has
  // no such licensing gap and is the primary source; the H.264 mp4 stays
  // as a fallback for Safari, which doesn't support WebM.
  console.log("encoding video (webm/vp9)...");
  runFfmpeg([
    "-y", "-framerate", String(config.fps), "-i", path.join(framesDir, "frame_%05d.png"), "-i", wavPath,
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1",
    "-c:a", "libopus", "-b:a", "96k", "-shortest", webmPath,
  ]);
  console.log("encoding video (mp4/h264, Safari fallback)...");
  runFfmpeg([
    "-y", "-framerate", String(config.fps), "-i", path.join(framesDir, "frame_%05d.png"), "-i", wavPath,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest", mp4Path,
  ]);

  function runFfmpeg(args) {
    const result = spawnSync("ffmpeg", args, { stdio: "inherit" });
    if (result.status !== 0) {
      console.error("ffmpeg failed:", args.join(" "));
      process.exit(1);
    }
  }

  fs.rmSync(workDir, { recursive: true, force: true });

  const mp4Stat = fs.statSync(mp4Path);
  const webmStat = fs.statSync(webmPath);
  console.log(
    `wrote ${path.relative(REPO_ROOT, webmPath)} (${(webmStat.size / 1024 / 1024).toFixed(1)} MB), ` +
      `${path.relative(REPO_ROOT, mp4Path)} (${(mp4Stat.size / 1024 / 1024).toFixed(1)} MB), ` +
      `${path.relative(REPO_ROOT, vttPath)} (${beats.length} captions), ` +
      `${path.relative(REPO_ROOT, posterPath)}`
  );
})();
