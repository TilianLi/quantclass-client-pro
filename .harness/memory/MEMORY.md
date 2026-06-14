# QuantclassClient Team Memory

This is shared team memory across all reins of the QuantclassClient
`.harness/`. Project-specific facts that don't change per project
live here; cross-project lessons live in each agent's personal
`~/.mavis/agents/<name>/memory/MEMORY.md`; user-preference facts live
in the user memory.

This file is currently empty by design. The bootstrap report
(`.harness/BOOTSTRAP_REPORT.md`) captures the design decisions
inline; future reins should add entries here only when a lesson is
durable enough to be worth re-reading at the start of every task.

## How to add an entry

- Keep entries to 1–3 lines. If you need more, the lesson is
  project-specific and belongs in the relevant doc under
  `.harness/docs/`.
- Use the three-question test (narrowest first):
  1. Only true in this repo? → put it here.
  2. Still true on a different project? → put it in the agent's
     personal memory.
  3. True for any user? → put it in user memory.
- Date the entry (`### <topic> (YYYY-MM-DD)`) and tag it
  (`Type: <fact|workflow|anti-pattern|gotcha>`).
