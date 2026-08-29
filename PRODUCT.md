# Product

## Register

product

## Users

clockout serves two connected roles:

- Employees use the desktop widget to understand and rearrange their finite workday.
- Managers use the boss workspace to add, assign, prioritize, and monitor tasks without silently extending the workday.

## Product Purpose

clockout turns a workday into an explicit 6×6 capacity board: 36 fifteen-minute slots from 09:00 to 18:00. The product makes tradeoffs visible when work is added, preserves a clear distinction between preview and committed schedules, and records overtime or compensation decisions instead of hiding them in unpaid extra hours.

The manager workspace is a local, SQLite-backed operational surface for task intake and task lifecycle management. It should make the next decision obvious: add a task, assign it, change its priority or deadline, inspect its state, or acknowledge that capacity is exceeded.

## Brand Personality

Bright, calm, humane. The product can be playful, but its playfulness should clarify work capacity rather than pressure people to work faster.

## Anti-references

Avoid dark command consoles, enterprise admin sprawl, dense spreadsheet-like screens, neon game effects, flashing warnings, fake productivity scores, and any flow that quietly creates overtime or changes someone else's schedule without an explicit decision.

## Design Principles

- Make capacity and tradeoffs visible before they become surprises.
- Give managers efficient controls while preserving employee agency and schedule traceability.
- Keep committed data authoritative and previews reversible.
- Use familiar product patterns for filters, forms, tables, status, and feedback.
- Let gentle game-like visual language support comprehension, not urgency or coercion.

## Accessibility & Inclusion

- Support keyboard navigation, visible focus, readable contrast, and labels that describe the action.
- Do not rely on task color alone to communicate type or status; pair color with text or icons.
- Respect `prefers-reduced-motion` and keep transitions short and non-essential.
- Make overflow, overtime, and destructive actions explicit and understandable.
