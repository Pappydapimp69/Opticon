// t25-role-direction.mjs — Does the difficulty label point the right way for
// EACH role after routing it per role? Companion to t25-difficulty-semantics.
// Seeded PRNG (never a constant — a constant collapses probability knobs).
// Run: node sandbox/t25-role-direction.mjs
// Does the fix make difficulty mean "harder for the human" in BOTH roles?
import { generateMap, MAP_DEFAULTS } from "../game/src/map.js";
import { createGame, endPrisonerTurn, isOver } from "../game/src/rules.js";
import { playWatcherTurn } from "../game/src/watcherAI.js";
import { prisonerAITurn } from "../game/src/prisonerAI.js";
const N = 240, TIERS = ["easy","medium","hard"];
// Seeded, NON-constant rng: a constant collapses probability thresholds and
// makes tiers that differ only by probability look identical.
function seeded(seed){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);
 t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
// Watcher-role human: prisoner skill = tier, exposure pinned to medium.
function watcherRole(tier){let cap=0;for(let i=0;i<N;i++){const seed=(i*2654435761)>>>0||1;
 const map=generateMap(seed,{...MAP_DEFAULTS,prisonerCount:3});const g=createGame(map,{watcherFacing:seed%4,prisoners:map.spawns});const rng=seeded(seed^0x9e3779b9);
 let guard=200;while(!isOver(g)&&guard-->0){prisonerAITurn(g,rng,tier);if(isOver(g))break;endPrisonerTurn(g);if(isOver(g))break;
 playWatcherTurn(g,"medium",seed,"medium");}if(g.status==="captured")cap++;}return cap/N*100;}
// Prisoner-role human: exposure = tier (unchanged behaviour).
function prisonerRole(tier){let cap=0;for(let i=0;i<N;i++){const seed=(i*2654435761)>>>0||1;
 const map=generateMap(seed,{...MAP_DEFAULTS,prisonerCount:3});const g=createGame(map,{watcherFacing:seed%4,prisoners:map.spawns});const rng=seeded(seed^0x9e3779b9);
 let guard=200;while(!isOver(g)&&guard-->0){prisonerAITurn(g,rng,"medium");if(isOver(g))break;endPrisonerTurn(g);if(isOver(g))break;
 playWatcherTurn(g,tier,seed,tier);}if(g.status==="captured")cap++;}return cap/N*100;}
console.log("HUMAN = WATCHER (goal: capture rate should FALL as difficulty rises — prey gets better)");
for(const t of TIERS) console.log(`  ${t.padEnd(7)} capture ${watcherRole(t).toFixed(0)}%`);
console.log("\nHUMAN = PRISONER (goal: capture rate should RISE as difficulty rises)");
for(const t of TIERS) console.log(`  ${t.padEnd(7)} capture ${prisonerRole(t).toFixed(0)}%`);
