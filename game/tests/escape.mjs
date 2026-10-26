// Shared harness: put the human's prisoner next to the exit and walk it in
// through the REAL input path (stage + commit), so checkOver() fires the way
// it does in play. Extracted from wincheck.mjs after overlay-gamepad.mjs,
// which had its own copy, kept all three bugs wincheck had already fixed:
//  1. the turn race — the game opens on an AI companion, and keys pressed
//     while it is active are ignored, so wait for prisoner 0 to hold the turn;
//  2. the neighbour filter — the exit is on the map edge and its usable
//     neighbours are often a door or object, not plain floor; accept any
//     non-wall, non-moat tile, and re-seed if a map has none;
//  3. screen-relative movement — keys are SCREEN directions, so look up which
//     key points at the exit after letting the camera settle on the teleport.
// Returns { ok: true } or { ok: false, reason } for a setup that never
// happened (callers should exit 2, not report a feature failure).
const TILE_WALL = 1, TILE_MOAT = 2;

async function waitHumanTurn(page) {
  return page.waitForFunction(() => {
    const a = window.__opticon;
    return a && a.game && !a.aiThinking && a.game.turn === "Prisoner" && a.game.activePrisoner === 0;
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
}

export async function driveEscape(page) {
  if (!(await waitHumanTurn(page))) return { ok: false, reason: "the human's prisoner never got the turn within 20s" };

  let dir = -1;
  for (let attempt = 0; attempt < 8 && dir < 0; attempt++) {
    if (attempt > 0) {
      await page.click("#btnRestart").catch(() => {});
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__opticon.renderer.skipIntro());
      await waitHumanTurn(page);
    }
    dir = await page.evaluate(([WALL, MOAT]) => {
      const g = window.__opticon.game, m = g.map, p = g.prisoners[0];
      const ex = m.exit;
      const N = [[0, -1, 0], [1, 0, 1], [0, 1, 2], [-1, 0, 3]];
      for (const [dx, dy, stepDir] of N) {
        const nx = ex.x - dx, ny = ex.y - dy;
        if (!m.tiles[ny] || m.tiles[ny][nx] === undefined) continue;
        const t = m.tiles[ny][nx];
        if (t === WALL || t === MOAT) continue;
        p.x = nx; p.y = ny; p.startTurnPos = { x: nx, y: ny }; p.mp = 3;
        p.custody = 0; p.alive = true; p.escaped = false;
        g.turn = "Prisoner"; g.activePrisoner = 0;
        return stepDir; // direction to step FROM the neighbour INTO the exit
      }
      return -1;
    }, [TILE_WALL, TILE_MOAT]);
  }
  if (dir < 0) return { ok: false, reason: "no reachable neighbour of the exit after 8 seeds" };

  // The camera eases toward a teleported prisoner over several frames; asking
  // screenDirToWorld mid-ease projects the new tile through the old framing
  // and can return the wrong cardinal. Settle it first.
  await page.evaluate(() => {
    const a = window.__opticon;
    for (let i = 0; i < 240; i++) a.renderer.updateCamera(a.game, a.game.prisoners[0], 0.1);
  });
  const key = await page.evaluate((d) => {
    const app = window.__opticon;
    const p = app.game.prisoners[0];
    for (let sd = 0; sd < 4; sd++) {
      if (app.renderer.screenDirToWorld(sd, { x: p.x, y: p.y }) === d) return ["KeyW", "KeyD", "KeyS", "KeyA"][sd];
    }
    return null;
  }, dir);
  if (!key) return { ok: false, reason: "no screen direction resolves to the world direction needed" };

  await page.keyboard.press(key); // stage the move
  await page.waitForTimeout(200);
  await page.keyboard.press("Space"); // commit — actually steps onto the exit
  return { ok: true };
}
