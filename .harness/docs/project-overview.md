# Project Overview

**QuantclassClient** is an Electron-based desktop application for quantitative
trading, built by 量化小讲堂. It integrates with the QMT (Quantitative Trading
Platform) kernel family (Fuel, Rocket, Aqua, Zeus) to provide stock data
download, real-time data center, strategy management, backtest, real-trading
self-check, and real-money execution.

This file is the canonical project description for reins working in this
harness. Read it before taking on any task.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Runtime | Electron 39 + Node.js ≥ 22 (ESM, `"type": "module"`) |
| Build | `electron-vite` 3.x (Vite-based three-process build) |
| Main process | TypeScript, IPC, native APIs, embedded Hono server, `node-schedule` |
| Renderer | React 18 + React Router 7 (HashRouter) + Jotai 2 + TanStack Query 5 (via `jotai-tanstack-query`) |
| UI | Tailwind CSS v3 + Radix UI primitives + HeroUI + shadcn-style components |
| Embedded HTTP | Hono 4.10 on a dynamic port (default 8787) |
| Persistence | `better-sqlite3` + Drizzle ORM + Drizzle Kit (SQLite) |
| Logging | `electron-log` (main) / `winston` + `winston-daily-rotate-file` (server) |
| MCP | `@modelcontextprotocol/sdk` 1.29 — in-app Hono `/mcp` API + standalone stdio MCP server (esbuild-bundled) |
| Code quality | Biome 1.9.4 (lint + format), Lefthook (pre-commit biome + commit-msg commitlint), Commitlint (Conventional Commits) |
| Packaging | `electron-builder` — Windows NSIS, macOS DMG (notarize off), Linux AppImage/snap/deb |

## Top-level layout

```
src/
├── main/              # Main process (Node.js)
│   ├── index.ts       # Entry: registers 16 IPC domains, boots Hono server, single-instance lock
│   ├── core/          # Kernel-facing business logic (strategy status, stock timing, data list, product, runpy)
│   ├── server/        # Embedded Hono server (controllers, middleware, schema, types)
│   ├── lib/           # WindowManager, db-manager, scheduler, startup-check, real-trading-backup, etc.
│   ├── migration/     # Drizzle migrations runner
│   ├── request/       # Backend HTTP client
│   ├── store/         # electron-store wrapper (persistent KV)
│   ├── utils/         # tools, winston, wecom-robot, request helpers
│   └── pythonRunner.ts# Embedded Python bridge (parses user config.py)
├── preload/           # contextBridge surface
│   ├── index.ts       # Aggregator: spreads each domain into window.electronAPI
│   └── <domain>/      # One module per IPC domain (auth, core, data, …, mcp)
│       ├── index.ts        # Renderer-facing object → ipcRenderer.invoke
│       └── <domain>-ipc.ts # Main-facing ipcMain.handle registration (bundled into MAIN, not preload)
├── renderer/          # React SPA (HashRouter)
│   ├── main.tsx, app.tsx, components/…, page/…, store/…, hooks/…
│   └── providers.tsx  # Jotai + next-themes + Tooltip
├── mcp-server/        # Standalone MCP stdio server (esbuild → resources/mcp-server/index.js)
└── shared/            # Types & lib shared between processes
```

## Subsystem map (which rein owns what)

| Subsystem | Primary owner | Backup |
|---|---|---|
| `src/main/index.ts` (lifecycle, IPC registration, server boot) | `electron-expert` | `developer` |
| `src/main/server/**` (Hono routes, middleware, error envelope) | `electron-expert` | `mcp-expert` (for `/mcp` only) |
| `src/main/lib/**` (WindowManager, scheduler, startup-check, real-trading-backup) | `electron-expert` | `developer` |
| `src/main/core/**` (strategy, dataList, runpy, product) | `electron-expert` | `developer` |
| `src/main/pythonRunner.ts` | `electron-expert` | `developer` |
| `src/main/migration/**` (Drizzle migrations) | `electron-expert` | `developer` |
| `src/preload/**` (one module per domain, two-file pattern) | `electron-expert` (main side `*-ipc.ts`) + `renderer-expert` (renderer side `index.ts`) | `developer` |
| `src/renderer/**` (React, Jotai, TanStack Query, HeroUI, Radix) | `renderer-expert` | `developer` |
| `src/mcp-server/**` + `src/main/server/controllers/mcp.ts` + `src/preload/mcp/**` + `src/renderer/components/McpStatusBadge.tsx` | `mcp-expert` | `electron-expert` (Hono side) + `renderer-expert` (UI side) |
| `electron-builder.yml`, `electron.vite.config.ts`, `tsconfig.*` | `electron-expert` | `developer` |
| `biome.json`, `lefthook.yml`, `commitlint.config.js`, `.cursorrules`, `.editorconfig` | `code-reviewer` (gate) / all reins (obey) | n/a |

## IPC domain inventory (16)

`auth`, `core`, `store`, `system`, `file-sys`, `kernel-log`, `data`, `strategy`,
`windows`, `user`, `migration`, `notification`, `real-trading-backup`,
`startup-check`, `mcp` (+ `emitter` for push events, no main registration).

## Quality gates (what every change must pass)

1. `pnpm typecheck` — both `typecheck:node` and `typecheck:web`
2. `pnpm biome check --write` on staged files (pre-commit hook)
3. `pnpm commitlint --edit <msg>` (commit-msg hook, conventional commits)
4. (No test runner — `src/test/*` is gitignored. Manual smoke via `pnpm dev:win` is the only end-to-end check.)

## Build & dev commands

| Command | Purpose |
|---|---|
| `pnpm install` | Install deps (Electron download is large; may need proxy) |
| `pnpm download-python` | **Required once** before first dev/build (populates `resources/python`) |
| `pnpm dev:win` | Windows dev (sets `chcp 65001`, `VITE_XBX_ENV=development`, runs `react-scan`) |
| `pnpm build` | Build only (electron-vite) |
| `pnpm build:win` | Windows installer |
| `pnpm build:mcp` | Bundle standalone MCP stdio server → `resources/mcp-server/index.js` (run after editing `src/mcp-server/`) |
| `pnpm typecheck` | Type-check both main and renderer |

## Licensing

All source files start with the BUSL-1.1 license header (see `src/main/index.ts`
for the canonical block). New files must include it. The product auto-relicenses
to GPL-3.0-or-later on 2028-08-22.
