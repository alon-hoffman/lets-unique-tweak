# tweak — an inspector for any codebase

A [lets](https://github.com/offensiveadhd/lets) unique. Say what you want to tweak in plain words —
*"player movement"*, *"the scoring"*, *"the navigation bar colors"* — and Claude finds the values **once**.
You then adjust them with sliders, toggles, color pickers and dropdowns in a small inspector window, and the
numbers change **in your source files**, with no further AI calls. Undo or revert any time.

Two rules shaped it:

1. **The app adapts to nothing.** The target project imports no library, registers nothing, gets no annotation and no config
   object. It is edited with ordinary file edits, so whatever your dev server already does (Vite/webpack HMR, a watcher) is the live feedback.
2. **Claude discovers once; plain code does the rest.** Moving a slider never calls a model. Claude only comes back when you ask for a
   different scope, or when the code under a value changed so much that it cannot be found safely.

```
 you: "let's tweak player movement"
   │
   ▼  (Claude, once)                          (no AI from here on)
 read code → pick 5–20 values ─► lets-tweak open ─► inspector window ──drag──► agent ──► edits the literal in the file
        definition.json              check + resolve        tweak.set {id,value}         undo / revert / stale checks
```

## Try it

Needs [lets](https://github.com/offensiveadhd/lets) ≥ 0.7 and Node ≥ 20.

```
/lets store tweak        # inspect, then confirm the install
/lets tweak player movement
```

Claude opens the window, reads the code your scope names, and fills the inspector. Open the folder you are working in first:
that is the project Tweak edits.

Without the store (for development), point lets at a checkout:

```bash
git clone https://github.com/offensiveadhd/lets && git clone <this repo>
LETS_UNIQUES_DIRS=$PWD node lets/engine/bin/lets.mjs serve --open lets-unique-tweak --verbose
```

(the unique's folder must be named like the manifest, `tweak`, or live inside a parent folder that has a `tweak/` entry).

## What you get

- **A focused inspector**, grouped under headings. Each value has a label, its `file:line`, a control that fits (slider, number, toggle,
  text, color, select, segmented), the constraints Claude could justify from the code, a ↺ per-value reset and clear ✓ / ⚠ feedback.
- **Undo** (a whole drag is one step), **Revert all** (across scopes), and an honest note that changes go to the working tree, **not to Git**.
- **A new scope any time**: type it into the window; that one message is the only thing that reaches Claude.
- **Safe edits**: a value is replaced where it sits, byte for byte; neighbouring code, formatting, line endings and BOM stay.

## How it is built

| Part | Where | Job |
|---|---|---|
| The window | `ui/` (static ES modules, SDK shell) | renders the inspector; sends `tweak.set {id, value}`; never sees or names a path |
| The discovery | Claude, following `GUIDE.md` | the only AI step: a *definition* (file, line, literal, control, range) |
| The resolver | `agent/lib/definition.mjs`, `source.mjs`, `literal.mjs` | validates the definition against the real files, pins each literal to an exact span with anchors |
| The session | `agent/lib/session.mjs` | set / revert / undo / revert-all, stale and outside-edit detection, atomic writes, journal |
| The agent | `agent/lib/daemon.mjs`, `agent/bin/lets-tweak.mjs` | plain Node, reads `tweak.*` events from its **own** LIP cursor and answers with `tweak.*` commands |

The agent is the one thing here that is not static, and it is why this unique declares an `agent` block in `unique.json` (the host ignores
unknown keys). It speaks only the documented LIP routes (`/lip/listen?cursor=…`, `/lip/command`) on loopback with the host token, has no
dependencies and no model access, and exits on its own when no window is left. Claude starts it through `lets-tweak open`.

### Why the adjustments cost no tokens

The window's events go to the agent on a **named cursor** of the LIP bus, not through Claude. They are also marked `"quiet": true` in the
manifest, so hosts that support it keep them off the `listen` tool and the prompt hook entirely. `tests/integration.test.mjs` proves it
with the real engine: it counts every MCP tool call and watches the `claude` and `hook` cursors while it applies 200+ adjustments.

### Safety model

- The window sends an **id and a value**, nothing else. Which file and which span is decided by the resolved definition on the agent's side.
- A value is **validated against its literal** (number, unit, `true`/`false`, `#hex`, quoted text with the quote escaped) and printed by
  Tweak. Nothing the window sends is spliced in as code; nothing is evaluated.
- Before every write the span is **re-read from disk** and verified. If the file moved, anchors find the literal again only when that is
  unambiguous; if someone edited the literal by hand, Tweak **adopts their value as the new baseline and writes nothing**.
- Refuses `node_modules`, build output, lock files, minified, generated and secret files, absolute and `..` paths, and symlinks that leave the project.
- Writes are atomic (temp file + rename); one writer per file; identical values are not rewritten; drags are coalesced.

## Develop

```bash
npm test             # unit + window logic + end-to-end against a real lets engine (../lets or LETS_REPO)
npm run validate     # manifest and guide checks
node demo/run-demo.mjs   # request → discovery → inspector → 40 adjustments → source diff → undo/revert, headless
```

The demo uses a small app (`demo/arcade/`) that knows nothing about Tweak, and the recorded discovery in `demo/arcade.definition.json`.
To see it in a browser, run the lets host as above, `lets-tweak open demo/arcade.definition.json --project demo/arcade --window <id>`
and open the window URL.

## Known limits

- **Literals only.** Numbers (with CSS units), booleans, quoted strings and `#hex` colors in JS/TS, CSS/SCSS, JSON, HTML, YAML and a
  few other text formats. No expressions, no computed values, no template placeholders. Editing is text-anchored, not AST-based, on purpose:
  it works across languages and fails closed.
- **Live feedback is your dev server's.** Vite HMR updated the demo game on every change; a project without a watcher needs a refresh or a restart.
  Some edits reset app state. Tweak does not promise live runtime editing.
- **Working tree only.** Nothing is committed. Undo works while the agent's journal lasts (`~/.lets/tweak/`); git is the long-term undo.
- **Discovery quality is Claude's.** `check` proves each value exists exactly where claimed, not that it was the right value to expose.
- **Hosts without `quiet` support** show `tweak.set` lines in the prompt hook's list (a few hundred bytes per change, never a model turn).
- Tested on Windows; macOS and Linux paths follow Node's portable APIs but are covered only by CI.

MIT licensed.
