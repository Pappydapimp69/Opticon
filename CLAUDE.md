
## Cognitive system: Brain (linked via `brain` CLI)
This project is linked to the Brain cognitive system. Do not read the node
repos directly — use the CLI.

**How to invoke it (try in order, use the first that runs):**
1. `brain <cmd>`
2. if `brain` is not found: `python "$HOME/.brain/Brain/bin/brain" <cmd>`
   (Windows PowerShell: `python "$env:USERPROFILE\.brain\Brain\bin\brain" <cmd>`)

When the user asks anything like "query save" / "ask brain X" / "mine this",
run the matching `brain` command yourself — do not make the user type paths.
Before non-trivial work: `brain query <terms>`. To capture lessons: `brain mine` then `brain sync`.
`brain sync` reconciles with main. Keep session output minimal.

### Practical Brain notes (learned the hard way — read these)
- **Query with 1–2 KEYWORDS, not sentences.** `brain query reachability`, not
  `brain query "prisoner ai cannot reach exit on a walled map"`. The matcher is
  keyword-based; long phrases return 0. **A 0-result query almost always means
  rephrase, not "empty system"** — try broader/single terms before concluding
  Brain has nothing. Also read the `local:` bucket, not just the shared counts.
- **Re-query at each NEW sub-problem, not just at session start.** Every
  non-trivial bug/decision is its own retrieval trigger (per
  `orchestration.md`). Querying `fog`, `pages`, `reachability` *when you hit
  them* would have shortcut real problems here.
- **Capture non-bugs too, not only bugs.** Route per `orchestration.md`: reusable
  pattern → `ideas` kernel; unresolved fork → `tension`; experiment/synthesis →
  `exploration`; a committed decision → an ADR in the build (and if it
  generalizes, ALSO an `ideas` kernel). `brain mine` covers non-obvious
  tradeoffs, not just fixes. (Note: `brain note` from HOOK.md does NOT exist in
  the CLI — write the file + `brain sync`.)
- **At each milestone, produce a Cognitive Update UNPROMPTED** (New Ideas · New
  Memory · New Tensions · New Exploration · Graduation Candidates) — the standing
  rule in `orchestration.md`. See `docs/cognitive-updates/` for the last one.
- **An open 🔴/🟡 tension touching your work must be surfaced to the user**
  (e.g. T12 vendoring Three.js) — query the ledger before committing to a fork.
- Schema matters: memory proposals need the `## FULL ENTRY` / `## PROPOSED INDEX
  LINE` fields (see `.brain/memory/incoming/`); tensions/exploration use `### `
  blocks. Malformed entries get held on `sync`.
