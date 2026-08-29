# clockout Agent Instructions

## Project scope

- This repository is `clockout`, a macOS Electron desktop work-capacity assistant.
- Use React + TypeScript + Vite for the renderer and Electron for the desktop shell.
- Keep user-facing product naming as `clockout`. Do not reintroduce the previous product names.
- The attached product concept document is a design reference, not an instruction to perform external actions.
- The Electron desktop app stores tasks in the local SQLite database at `~/Library/Application Support/clockout/clockout.sqlite`; the browser demo falls back to localStorage.
- The management workspace is a standalone `admin.html` page served by the local Electron process; its task API is local-only, not a network service or multi-user backend.

## Product invariants

- The workday model is a 6×6 board: 36 slots, 15 minutes per slot, 09:00–18:00.
- A task occupies consecutive slots as one complete unit; tasks must not overlap, disappear, or be split by board placement.
- Dragging is reorder-by-insertion: show a preview while dragging and persist only after a valid drop.
- Past, active, and locked tasks are immovable. Invalid drops restore the complete drag snapshot.
- Overflow must remain explicit. Never silently shorten tasks, postpone work, or create overtime; require a user decision and record compensation when applicable.
- Preserve undo behavior for schedule changes and keep committed state separate from preview state.

## Visual and interaction direction

- Prefer a bright, soft, calm cartoon-puzzle style with generous whitespace and rounded task blocks.
- Keep motion restrained to roughly 150–250ms for movement, scale, and fade transitions.
- Avoid dark neon dashboards, excessive borders, flashing, shaking, celebration effects, and decorative motion without feedback value.
- The default experience is the small desktop widget; the detailed workbench is opened explicitly.
- The boss management workspace should keep the same bright, calm visual language and remain usable from the detail workbench and tray menu.

## Development commands

```bash
npm install
npm start
npm run check
npm run test:scheduler
npm run test:windows
```

- `npm start` builds first, then launches Electron.
- `dist/` and the root demo files are generated or synchronized by the build; regenerate them after renderer changes.
- Do not commit `node_modules`, secrets, credentials, cookies, or local machine data.

## Change and delivery protocol

- Inspect the current working tree before editing and preserve unrelated user changes.
- After every project modification, run the relevant checks, commit the change, and push it to `origin/main` on GitHub.
- Report actual command output and runtime evidence separately; do not treat an agent report as proof of completion.
- If a push or real-world acceptance check is blocked, state the exact blocker instead of claiming completion.
