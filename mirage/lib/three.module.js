// Three.js for MIRAGE — a re-export shim, not a second copy.
//
// Three's ESM build is 1.3 MB. Opticon already vendors it at
// `game/lib/three.module.js`, and duplicating it here would double that cost in
// the repo for zero benefit (see the open tension T12: "vendoring Three.js
// (repo bloat) vs a build step / CDN"). MIRAGE is a separate GAME — separate
// world, rules, renderer, tests — but it does not need a separate copy of a
// third-party library that already sits one directory over.
//
// All of MIRAGE imports Three through THIS file, so the coupling lives in
// exactly one line. To make `mirage/` standalone-deployable (e.g. publishing it
// as its own Pages site, where `../game/` will not exist), replace this file
// with the real vendored build:
//
//   cp ../game/lib/three.module.js mirage/lib/three.module.js
//
// Nothing else has to change.
export * from "../../game/lib/three.module.js";
