// Headless browser smoke test for MIRAGE. Boots the real page in Chromium,
// starts a run, drives it, and asserts on observable state.
// Run: node mirage/tests/smoke.mjs [scenario]
//   scenario: play (default) | hallucinate | phantomLog
//
// Two lessons are baked into this file:
//
// 1. NEVER ASSERT ON WALL-CLOCK TIME. Headless rAF runs at a fraction of real
//    speed, so "wait 3 seconds, expect ~3 seconds of drain" is a flake. Every
//    timing assertion below drives `window.__mirage.advance(seconds)`, which
//    steps the sim in fixed slices, and then reads the sim's own clock.
//
// 2. "IT LOADED AND NOTHING THREW" IS A FALSE GREEN FOR 3D. Software GL will
//    happily load a scene that draws nothing. So this asserts on Three's own
//    draw-call counter, and degrades gracefully (reporting SKIP, not PASS) if the
//    environment has no working WebGL at all.

import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, ".."); // served as the doc root: mirage/lib re-exports ../../game/lib
// The static server binds port 0 — the OS picks a free one. A hardcoded port
// fails with EADDRINUSE when an earlier run's server is still up, and that
// failure looks nothing like the game being broken; it just burns a debug cycle.
const SCENARIO = process.argv[2] || "play";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/mirage/index.html";
    const file = path.join(REPO, p);
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

// Screenshot options. Both parts matter under software GL:
//   animations: "disabled" — the hallucinating vignette runs an infinite CSS
//     animation, and a capture that waits for the page to settle never settles.
//   timeout — a 1280x800 readback with the full-screen overlay composited over a
//     live WebGL canvas measured ~5s here and occasionally blew the 30s default.
//     That is the environment being slow, not the game being wrong, so the fix is
//     a real timeout rather than a smaller assertion.
const SHOT = { animations: "disabled", timeout: 90000 };

const failures = [];
const notes = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: [
      "--use-gl=swiftshader",
      // Note the spelling: `--enable-unsafe-swiftshader`, not `--allow-...`.
      // Without it, newer Chromium refuses the software path and getContext
      // returns null, which looks exactly like a broken game.
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(`http://localhost:${PORT}/mirage/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__mirage, null, { timeout: 15000 });

  const build = await page.$eval("#buildLabel", (el) => el.textContent);
  assert(build && build !== "—", `build label never populated (got ${JSON.stringify(build)})`);

  // Is there usable WebGL here at all? If not, the 3D assertions are skipped
  // rather than reported as passing.
  const glOk = await page.evaluate(() => {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  });
  if (!glOk) notes.push("SKIP: no WebGL in this environment — 3D assertions not run");

  // Start a run on a fixed seed so the basin is the same every time.
  await page.click('[data-diff="standard"]');
  await page.fill("#seedInput", "1234");
  await page.click("#startBtn");
  await page.waitForFunction(() => !!window.__mirage.sim, null, { timeout: 10000 });

  const start = await page.evaluate(() => {
    const s = window.__mirage.sim;
    return {
      party: s.party.length,
      companions: s.companions.length,
      monoliths: s.monoliths.length,
      pylons: s.pylons.length,
      doses: s.doses,
      seed: s.seed,
      status: s.status,
      hudVisible: !document.getElementById("hudLayer").classList.contains("hidden"),
      // No meter may be rendered anywhere in the HUD.
      hudText: document.getElementById("hudLayer").innerText,
    };
  });
  assert(start.party === 6, `expected 6 in the party, got ${start.party}`);
  assert(start.companions === 5, `expected 5 NPC companions, got ${start.companions}`);
  assert(start.monoliths === 6 && start.pylons === 5, "world features missing");
  assert(start.seed === 1234, `seed not honoured: ${start.seed}`);
  assert(start.hudVisible, "HUD did not appear");
  assert(!/\b\d{2}\s*\/\s*100\b/.test(start.hudText), "the HUD appears to render a lucidity value");

  // A frame from the opening position, for visual review: the party in
  // formation, in daylight, before any of the test's teleports.
  await page.screenshot({ path: path.join(ROOT, "tests", "shot-start.png"), ...SHOT });

  // --- drive the sim on ITS OWN CLOCK -------------------------------------
  const walked = await page.evaluate(() => {
    const before = { x: window.__mirage.sim.player.x, z: window.__mirage.sim.player.z };
    const t = window.__mirage.advance(8, { move: { x: 0, z: -1 }, run: true });
    const s = window.__mirage.sim;
    return {
      simTime: t,
      moved: Math.hypot(s.player.x - before.x, s.player.z - before.z),
      lucidity: s.player.lucidity,
      companionSpread: s.companions.map((c) => Math.hypot(c.x - s.player.x, c.z - s.player.z)),
    };
  });
  assert(walked.simTime >= 7.9, `sim clock only reached ${walked.simTime}s after advancing 8s`);
  assert(walked.moved > 3, `player barely moved (${walked.moved.toFixed(2)} units in 8 sim-seconds)`);
  assert(walked.lucidity < 100, "nobody drained over 8 sim-seconds");
  assert(walked.companionSpread.filter((d) => d < 22).length >= 3, `party did not keep up: ${walked.companionSpread}`);

  if (glOk) {
    const drew = await page.evaluate(() => {
      const info = window.__mirage.renderer.renderer.info;
      return { calls: info.render.calls, triangles: info.render.triangles };
    });
    assert(drew.calls > 0, "the renderer made zero draw calls — the scene is not being drawn");
    assert(drew.triangles > 1000, `suspiciously few triangles drawn: ${drew.triangles}`);
    notes.push(`drew ${drew.calls} calls / ${drew.triangles} triangles`);
  }

  // --- the hallucination path ---------------------------------------------
  const gone = await page.evaluate(() => {
    const M = window.__mirage;
    M.drain("you", 0.05);
    M.advance(1);
    const s = M.sim;
    const p = M.percept;
    M.advance(4); // let the distortion ramp
    return {
      hallucinating: s.player.hallucinating,
      kind: s.player.hallucination,
      perceptActive: p.active,
      intensity: p.intensity,
      // The INLINE target opacity, not getComputedStyle: the vignette has a
      // 0.6s CSS transition, so the computed value right after the change is
      // still mid-fade and reads ~0. Asserting on it tests the transition, not
      // the game.
      vignette: Number(document.getElementById("vignette").style.opacity || 0),
      vignetteLost: document.getElementById("vignette").classList.contains("lost"),
      rosterText: document.getElementById("roster").innerText,
      // The sim's own record must be untouched by the lie layer.
      realMonoliths: s.monoliths.length,
    };
  });
  assert(gone.hallucinating, "the player did not begin hallucinating at zero lucidity");
  assert(gone.perceptActive, "the perception layer did not activate");
  assert(gone.intensity > 0.1, `distortion never ramped (${gone.intensity})`);
  assert(gone.vignette > 0.05, `vignette stayed invisible (opacity ${gone.vignette})`);
  assert(/can't tell/.test(gone.rosterText), `the roster should stop claiming to know: ${JSON.stringify(gone.rosterText.slice(0, 120))}`);
  assert(gone.vignetteLost, "the vignette did not switch to its hallucinating variant");
  assert(gone.realMonoliths === 6, "perception contaminated the sim's own record");

  // A frame from inside a hallucination, for visual review.
  await page.screenshot({ path: path.join(ROOT, "tests", "shot-gone.png"), ...SHOT });

  // Whatever kind was drawn, the perceived world must diverge from the real one
  // in the way that kind promises.
  const divergence = await page.evaluate(() => {
    const M = window.__mirage;
    const p = M.percept;
    const s = M.sim;
    return {
      kind: p.kind,
      phantomMarkers: p.phantomMonoliths.length,
      phantomCompanions: p.phantomCompanions.length,
      phantomPylons: p.phantomPylons.length,
      compassOffset: p.compassOffset,
      deadLookLive: p.deadPylonsLookLive.size,
      whisper: p.whisper,
      realCompanions: s.companions.length,
    };
  });
  const diverged =
    divergence.phantomMarkers > 0 ||
    divergence.phantomCompanions > 0 ||
    divergence.phantomPylons > 0 ||
    Math.abs(divergence.compassOffset) > 0.5 ||
    divergence.whisper !== null;
  assert(diverged, `hallucination kind ${divergence.kind} produced no perceptual divergence`);
  assert(divergence.realCompanions === 5, "a phantom companion leaked into the sim");
  notes.push(`hallucination kind: ${divergence.kind}`);

  // --- recovery -----------------------------------------------------------
  const recovered = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    const p = s.pylons.find((x) => x.charge > 50) || s.pylons[0];
    p.charge = 100;
    M.teleport(p.x, p.z);
    M.advance(5);
    return { hallucinating: s.player.hallucinating, lucidity: s.player.lucidity, perceptActive: M.percept.active };
  });
  assert(!recovered.hallucinating, "sustained pylon contact did not bring the lead back");
  assert(!recovered.perceptActive, "the perception layer stayed active after recovery");
  assert(recovered.lucidity > 20, `recovered to a suspicious level: ${recovered.lucidity}`);

  // --- verbs --------------------------------------------------------------
  const verbs = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    const before = s.doses;
    M.act(M.ACTIONS.DOSE, 0);
    const afterDose = s.doses;
    M.act(M.ACTIONS.CHECK_IN, 1);
    const subtitles = document.getElementById("subtitles").innerText;
    // Walk to a marker and survey it for real.
    const m = s.monoliths[0];
    M.teleport(m.x + 1, m.z + 1);
    M.advance(0.5);
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.2); // the HUD repaints on the frame loop, so give it a frame
    return {
      doseSpent: before - afterDose,
      subtitles,
      logged: s.monoliths.filter((x) => x.logged).length,
      entries: s.logEntries.length,
      surveyPill: document.getElementById("surveyCount").textContent,
      foundPill: document.getElementById("foundCount").textContent,
    };
  });
  assert(verbs.doseSpent === 1, `dose was not consumed (${verbs.doseSpent})`);
  assert(verbs.subtitles.trim().length > 0, "check-in produced no visible line");
  assert(verbs.logged === 1, `survey did not log the marker (${verbs.logged})`);
  assert(/1 \/ 6/.test(verbs.surveyPill), `log counter did not update: ${verbs.surveyPill}`);
  assert(/[1-6] \/ 6/.test(verbs.foundPill), `found counter never moved: ${verbs.foundPill}`);

  // --- pause really stops the world ---------------------------------------
  const paused = await page.evaluate(async () => {
    const M = window.__mirage;
    M.act(M.ACTIONS.PAUSE);
    const t0 = M.sim.time;
    const l0 = M.sim.player.lucidity;
    await new Promise((r) => setTimeout(r, 400));
    const res = { pausedDuring: M.paused, dt: M.sim.time - t0, dl: l0 - M.sim.player.lucidity };
    M.act(M.ACTIONS.PAUSE);
    res.pausedAfter = M.paused;
    return res;
  });
  assert(paused.pausedDuring === true, "pause did not engage");
  assert(paused.pausedAfter === false, "pause did not toggle back off");
  assert(paused.dt === 0, `the sim advanced ${paused.dt}s while paused`);
  assert(paused.dl === 0, `the party drained ${paused.dl} while paused`);

  const shot = path.join(ROOT, "tests", `shot-${SCENARIO}.png`);
  await page.screenshot({ path: shot, ...SHOT });

  // Console errors are checked LAST so a functional failure is reported first.
  assert(errors.length === 0, `console errors: ${errors.slice(0, 5).join(" | ")}`);

  await browser.close();
  server.close();

  for (const n of notes) console.log("  · " + n);
  console.log(`SCREENSHOT: ${shot}`);
  if (failures.length) {
    console.log("\nSMOKE FAILED:");
    for (const f of failures) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log("mirage smoke: OK");
})().catch((e) => {
  console.error("SMOKE CRASHED:", e);
  process.exit(1);
});
