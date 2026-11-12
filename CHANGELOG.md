# Changelog

## 0.1.1

- GUIDE: Claude now shows the window itself right after `open` (it used to wait to be asked).
- GUIDE: Claude stays in a filtered `listen` loop (`tweak.scope`, `chat.message`, `session.closed`) after opening, so a new scope typed
  in the window is picked up without closing and re-invoking Tweak.
- UI: submitting a scope while Claude is not listening shows a note with how to continue (send a message in Claude Code, or start a new
  instance with `/lets tweak <scope>`); Claude says the same in the window before it stops listening.

## 0.1.0

- First release: a natural-language inspector for existing code. Claude discovers parameters once from a plain-language scope; sliders,
  toggles, color pickers, text and dropdowns then edit the literals in the source files through a small zero-dependency agent, with no
  further AI calls. Undo, per-value reset, Revert all, stale and outside-edit detection, coalesced drags, atomic writes.
