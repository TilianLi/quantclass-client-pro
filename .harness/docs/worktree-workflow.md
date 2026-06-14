# Worktree & Branch Workflow

This project uses Git worktrees for branch isolation. All reins MUST read
this before opening a branch — working directly on `main` is forbidden.

## What is a worktree (TL;DR)

A Git worktree is a separate working directory attached to the same `.git`
repo. Each worktree checks out one branch. Multiple worktrees let you work
on multiple branches in parallel without `git stash` hell.

## Current worktree layout

```
D:/QuantClassSpace/quantclass-client-pro                              # main worktree (v3.6.x)
D:/QuantClassSpace/quantclass-client-pro/.worktrees/feature-mcp-support  # feature branch
```

Inspect with:
```bash
git worktree list
```

## Branch naming convention

`<type>/<scope>` — lowercase, kebab-case. Examples:
- `feat/mcp-status-badge`
- `fix/scheduler-leak-on-quit`
- `refactor/strategy-status-pivot`

Match the conventional-commit `type` you plan to use in the merge.

## Creating a new worktree (per-feature)

From the main worktree (`D:/QuantClassSpace/quantclass-client-pro`):

```bash
git worktree add .worktrees/<branch-name> -b <type>/<scope>
```

Then `cd` (or open in your editor) into the new worktree and work there.
Don't `cd` between worktrees mid-task — pick one and stay.

## Before you start work

1. `git status` — clean tree, on the expected branch.
2. `git log --oneline -5` — recent commits look sane.
3. `pnpm install` — node_modules is per-worktree; don't symlink.
4. `pnpm download-python` — only needed once per machine, not per
   worktree, since the script writes to `resources/python/` (which is
   gitignored and shared). Skip if `resources/python/${arch}/python.exe`
   (or `bin/python3` on Unix) already exists.

## Verifying a change locally

```bash
pnpm typecheck                # both main and renderer
pnpm biome check --write     # lint + format
# then run:
pnpm dev:win                  # Windows dev server with react-scan
```

There is no `pnpm test` — see `code-standards.md` §9.

## What is NOT a worktree concern (don't conflate)

- **`resources/python/`** — gitignored, lives in the main worktree, shared
  across worktrees. If you add the python binary to `.worktrees/foo/`,
  it's wrong.
- **`node_modules/`** — per-worktree, don't share.
- **`out/`** — per-worktree build output, gitignored.
- **`drizzle/`** — per-worktree migration output, gitignored.
- **`.mavis/`, `.vscode/`, `.idea/`** — local-only state, gitignored.

## Commit hygiene

- **One logical change per commit.** Don't bundle MCP + scheduler fix + lint
  cleanup in a single commit.
- **Conventional Commits** (enforced by `commitlint.config.js` +
  `lefthook.yml` commit-msg hook).
- **Squash trivial WIP commits** before opening the MR — keep the history
  narratable.
- **Don't commit the worktree scaffolding** (`.worktrees/` is in
  `.gitignore`).

## When the user wants a "clean main"

If your work is the only thing in flight and you want a fast-forward merge:

1. From the main worktree: `git merge --ff-only <branch>`.
2. Remove the worktree: `git worktree remove .worktrees/<branch-name>`.
3. Delete the merged branch: `git branch -d <branch>`.

If multiple branches are in flight, the user (or a senior rein) decides
the merge order. Don't `git rebase` other people's work.

## Handoff to verifier / code-reviewer

When you finish a change in a worktree, the verifier / code-reviewer
session opens its OWN worktree on the same branch (or reads the diff
directly). Don't expect them to share your worktree — Git's branch model
is the handoff boundary, not the directory.

## Anti-patterns

- **Working on `main` directly** — never commit to `main` from a worktree.
  Use a feature branch.
- **Mixing two features in one worktree** — split if the work is for two
  different MRs.
- **Pushing force** to a shared branch — never `git push --force` to
  `main`/`master` or to anyone else's branch.
- **Skipping `pnpm typecheck` because Biome passed** — type errors are
  not lint errors. Run both.
