# Tweak — guide for Claude

The human says what they want to tweak in plain words ("player movement",
"the scoring", "navigation bar colors"). You find the values **once**. They then
adjust them with sliders, toggles and color pickers in the window, and a small
local agent edits the source files for every change. **You are not in that
loop, on purpose**: adjustments cost no tokens. The target app needs no
changes, imports nothing and does not know Tweak exists.

## What is yours, what is the agent's

| You (discovery, once per scope) | The agent (plain Node, no model) |
|---|---|
| understand the request, find the code, choose the parameters | validate each value, re-check the exact span in the file, write it atomically |
| write the definition, run `check`, run `open` | undo, revert, detect files edited outside Tweak, apply drags |

Never perform an adjustment yourself, and never re-apply one the agent already
made. `tweak.set`, `tweak.revert`, `tweak.revertAll`, `tweak.undo`,
`tweak.resync` and `tweak.hello` events may appear in the prompt hook's list:
**ignore them**, they are already handled. React only to `tweak.scope`.

## Open

`/lets tweak <scope>`, or any request like "tweak X" / "open tweak": call
`open {unique:"tweak"}` **and then show the window yourself, in the same turn,
without waiting to be asked**: `mcp__Claude_Browser__preview_start {url}` (or
`navigate` if a pane is already open) using the `url` from the `open` result.
A window nobody can see is a failed open. If there is no browser tool, call
`open` again with `launch:"system"` and the same `windowId`. Never paste the
URL as the answer. The project is the folder you are working in (the git root);
ask one short question only if that is unclear. If the human gave a scope,
start discovery now; otherwise say "What should we tweak?" via `entity.say`.

## Discover (the hard part, and the only part that needs you)

Read the code that the scope names; search before you guess. Aim for **5 to 20
parameters**, never more than 60. Prefer one small honest inspector over a
dump of every constant.

Include what a person would want to move: speeds, gravity, durations, delays,
thresholds, scores, spacing, colors, visible labels, feature flags, timing.
Exclude: array indices, protocol/status codes, ports, IDs, keys, tokens,
passwords, auth or security settings, anything derived from another value,
generated, vendored or minified files, and anything you are unsure is safe to
change. When in doubt leave it out and say so.

Group related values under short headings. Give each a human label, a unit
in `hint` when useful, and **real constraints**: a slider needs `min` and `max`
you can justify from the code (a range wide enough to explore, narrow enough to
stay sane). Use `number` when the range is unknown. Booleans become toggles,
`#hex` colors become pickers, a string with a known set of values becomes a
select or segmented control (`options`).

Literals Tweak can edit: numbers (with an optional CSS unit like `16px`, `250ms`),
`true`/`false`, quoted strings, `#rgb`/`#rrggbb` colors, as they literally appear
in source, including `"#ff0000"` in a string. It cannot edit expressions,
computed values or template strings with `${}`. If the value you want is the
result of an expression, map the literal inside it, or skip it.

## Write the definition and open it

Write the JSON **outside the project** (your scratchpad), never in the repo:

```json
{
  "scope": "player movement",
  "title": "Player movement",
  "summary": "Speed, gravity and jump feel.",
  "params": [
    { "id": "gravity", "label": "Gravity", "group": "World", "file": "src/game/physics.ts",
      "line": 8, "literal": "1800", "min": 0, "max": 4000, "step": 10, "hint": "px/s²" },
    { "id": "ghost", "label": "Ghost trail", "group": "Effects", "file": "src/fx.ts",
      "line": 21, "literal": "true" },
    { "id": "tint", "label": "Tint", "group": "Effects", "file": "src/fx.ts",
      "line": 22, "literal": "\"#a66bff\"" }
  ]
}
```

`file` is relative to the project. `line` is where you saw it (off by one or
two is tolerated only when unambiguous). `literal` is the exact source text. If it
appears twice on that line, add `col` (1-based) or `nth`. Include a minus
sign in the literal when the source has a unary one (`"-0.5"`).

Then, with `U` = the folder this guide is in (`~/.lets/uniques/tweak`, or the checkout it was installed from):

```
node U/agent/bin/lets-tweak.mjs check <def.json> --project <root>
node U/agent/bin/lets-tweak.mjs open  <def.json> --project <root> --window <windowId>
```

`check` resolves every hint against the real files and prints each parameter's
exact `file:line` and literal, or **exit code 2 with the problems**: fix the
definition and rerun, do not work around it. `open` does the same, starts the
agent if it is not running, and fills the window. Do not send `tweak.inspector`
yourself.

After `open`: one `entity.say` line ("Seven values on movement. Go."), then tell
the human in chat, briefly:
- changes are written **straight into the working tree** (not committed to Git);
  Undo and Revert all put the old text back;
- whether their dev server will reload by itself (Vite/webpack HMR, a watcher) or
  they need to refresh or restart. Say what you actually know of this project;
  do not promise live updates.

Then **stay reachable** (see *Stay reachable*). Slider events are not yours:
never loop on them.

## Stay reachable

Window events only reach you while you are inside `listen`, or when the human
sends a chat prompt. If you simply end the turn, a scope typed in the window
(`tweak.scope`) sits unread until the human types in Claude Code, which looks
like "nothing happens". So after `open` and your hand-off lines, loop:

`listen {wait_ms: 90000, types: ["tweak.scope", "chat.message", "session.closed"]}`

- The `types` filter keeps slider/undo/revert/resync traffic out of your
  context; an empty result costs about 100 tokens, so just call `listen` again.
- `tweak.scope` or `chat.message` asking for something else to tweak → **A new
  scope** below, then back to the loop.
- `session.closed`, goodbye/done, or **15 minutes** with no event → say one line
  in the window if it is still open, run **Wrap up**, end the turn.
- A message typed in the transcript reaches you between calls: answer it, then
  continue the loop unless it says stop.

## A new scope

`tweak.scope {text}` (or the human just says it in chat): run the same steps
for the new request and `open` the new definition on the **same window**
(do not open a second window and do not ask the human to close and re-invoke
Tweak). Make sure the pane is still visible; if it was closed, show it again.
The old scope's changes stay applied; Revert all still reaches them. If the
request is genuinely ambiguous ("tweak it"), ask one short question first.

## When something is wrong

The window shows ⚠ on a value with the reason. `stale` means the code around
the value changed and it cannot be found safely: rediscover that scope and `open`
again. `changed` means someone edited that value in the file; the window adopts
the file's value and nothing is overwritten. A host or agent restart: run `open`
again with the same definition.

## Wrap up

When the human is done, `node U/agent/bin/lets-tweak.mjs status --window <id>`
lists every changed value (`file`, `from`, `to`). Summarise it, and offer to
keep it, revert it (`revert-all --window <id>`), or help them commit. Never
commit or push unasked.

## Etiquette

Be conservative and say what you left out. Never read secrets into the
definition. Keep Doto's lines short, verb first, ending on a dot.
