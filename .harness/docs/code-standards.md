# Code Standards & Quality Gates

This is the project-wide quality bar. The raw tool config files
(`biome.json`, `lefthook.yml`, `commitlint.config.js`, `.cursorrules`,
`.editorconfig`) are the source of truth — this doc just summarizes the
**rules reins must follow** when writing or modifying code.

## 1. TypeScript style

- **TypeScript only** — no `.js` source files (Biome lints only `.ts`/`.tsx`).
- **Prefer `interface` over `type`** for object shapes; use `type` only for
  unions, intersections, and utility types.
- **No `enum`** — use string-union maps (e.g.
  `const STATUS = { OK: "ok", ERROR: "error" } as const; type Status = typeof STATUS[keyof typeof STATUS];`).
- **No `any` lint error** (Biome `noExplicitAny: off`), but **avoid `any`
  in new code** — prefer `unknown` and narrow with type guards.
- **Strict mode on** for the renderer (`tsconfig.web.json`); `noImplicitAny`
  is `false` for the main side, so do not rely on implicit `any`.

## 2. React / component style

- **Functional components with named exports** — no default-exported
  components, no class components.
- **Minimize `useEffect`/`setState`** — favor Jotai atoms for shared state.
- **Use `React.lazy` + `Suspense`** for larger features (the app is
  long-running, memory matters).
- **Desktop-first responsive** Tailwind classes — this is a desktop app,
  not mobile.
- **Jotai `Provider` is layered** — there are two Jotai Providers in the
  tree (one in `providers.tsx`, one in `app.tsx`); the inner one is needed
  for `jotai-tanstack-query`. Don't collapse them.

## 3. Naming & organization

- **IPC channels**: `kebab-case` (e.g. `get-strategy-status`,
  `download-progress`).
- **File names**: `kebab-case` for files (`startup-check.ts`), `PascalCase`
  for React component files (`McpStatusBadge.tsx`).
- **Atoms**: `xxxAtom` suffix (e.g. `mcpServerInfoAtom`).
- **Hooks**: `useXxx` prefix.
- **Types/interfaces**: `PascalCase`, no `I` prefix.
- **One domain per folder** in `src/preload/`, `src/renderer/page/`.

## 4. Biome formatter rules (enforced by `lefthook` pre-commit)

| Setting | Value |
|---|---|
| `indentStyle` | `tab` |
| `indentWidth` | 2 |
| `lineEnding` | `lf` |
| `lineWidth` | 80 |
| `semicolons` | `asneeded` |
| `jsxQuoteStyle` | `double` |
| Import organization | on |

**`.editorconfig` says `indent_style = space`** — Biome wins on
TS/TSX. `.editorconfig` is the fallback for non-TS files (Markdown, JSON,
YAML, etc.) where Biome doesn't run.

## 5. Biome lint rules to be aware of

- `noNonNullAssertion`: off — `foo!.bar` is fine.
- `noUselessElse`: off — don't fight the formatter on `else { return }`.
- `noExplicitAny`: off — see TS style above.
- `noArrayIndexKey`: off — `key={i}` is allowed in tight loops.
- `useExhaustiveDependencies`: warn — add the dep, or document why you
  didn't.
- `useKeyWithClickEvents`: off — `onClick` on a `<div>` is allowed (we
  build a lot of custom click targets, not all of them are buttons).
- `useButtonType`: warn — prefer `<button type="button">` over
  bare `<button>`.
- `noUnusedImports`: info — clean these up before commit.

## 6. Git hooks (enforced by `lefthook`)

**Pre-commit** (parallel):
- `pnpm biome check --write` against staged `*.{js,ts,jsx,tsx}`.
- `pnpm biome format --write` against staged `*.{js,ts,jsx,tsx}`.

**Commit-msg**:
- `pnpm commitlint --edit {1}`.

## 7. Commit message format (Conventional Commits)

Allowed types: `feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert`.

Header and body length are capped at 200 (rule level 0 — soft cap, but
don't be silly).

Examples (good):
- `feat(mcp): add toggle_min_data_schedule tool to MCP server`
- `fix(renderer): prevent double-render on route change in realtime-data`
- `refactor(scheduler): extract node-schedule job registry into named map`

## 8. License header

Every new source file must start with the BUSL-1.1 license header. The
canonical block is at the top of `src/main/index.ts` (lines 1–9):

```ts
/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */
```

## 9. Testing — caveat

**There is no test runner.** `package.json` has no `test` script; no
Jest/Vitest; `src/test/*` is gitignored. The only quality gate beyond
typecheck + biome is the manual `pnpm dev:win` smoke test. **If you add
test infrastructure, you are taking on a project-wide change** — get
explicit owner consent first. For now, "tested" means:

- `pnpm typecheck` passes.
- The relevant `pnpm biome check` passes.
- You ran `pnpm dev:win` (or its subprocess) and exercised the changed
  surface area end-to-end. Document the smoke steps in the MR.

## 10. Code-review checklist (what `code-reviewer` will look for)

- **License header** present on new files.
- **TypeScript strictness**: no implicit `any` on the renderer side;
  `unknown` + narrowing preferred over `any`.
- **Jotai over `useState`**: shared state lives in atoms, not components.
- **One domain per folder**: don't mix concerns.
- **IPC channel naming**: kebab-case; `electronAPI` aggregation updated
  in `src/preload/index.ts`.
- **Renderer imports `electron`**: **rejection-level bug** — must not happen.
- **Conventional Commits**: correct type/scope; imperative present tense.
- **No secrets in diffs**: `.env*`, `certs/`, `*.p8`, `*.p12`, `*.key` are
  gitignored; never paste them in chat either.
- **Diff size sanity**: a 1000-line single-commit diff needs a justification
  in the MR body.

## 11. Anti-patterns observed in this codebase (don't copy these)

These are real patterns in the existing code that are documented as
intentional trade-offs but should NOT be copied into new work:

- `nodeIntegration: true, webSecurity: false` on the main window
  (`WindowManager.ts`) — legacy requirement, not a template for new windows.
- `archiver("zip", {zlib:{level:0}})` (store mode) in
  `real-trading-backup.ts` — intentional for `.pkl` payloads, not a
  general-purpose choice.
- Hard-coded DB path in `drizzle.config.ts`
  (`/Users/jiantianjianghui/.../FuelBinStat.db`) — pre-existing, do NOT
  copy the pattern; this needs a per-machine override before any
  migration-driven development.
- `isSafeRecycleName` requiring the `stock`/`coin` prefix
  (`data-recycle-bin.ts:27`) — the real path-traversal guard, do not
  loosen the regex in isolation.
