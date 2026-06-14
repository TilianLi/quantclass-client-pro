# IPC + Preload Architecture

This project uses the standard three-process Electron model plus an embedded
Hono server. Reins working on any cross-process code MUST read this doc.

## Three processes

| Process | What runs | Entry |
|---|---|---|
| **Main** | Node.js main thread. Owns: window lifecycle, tray, FS, native APIs, IPC `handle` registration, embedded Hono server, electron-store, scheduled jobs, Python runner, kernel process spawn. | `src/main/index.ts` |
| **Preload** | Isolated context-isolated bridge. Bundles TWO kinds of files: (a) renderer-facing domain objects (exposed via `contextBridge`), and (b) main-facing `*-ipc.ts` registration modules (the bundler emits them into the MAIN bundle despite living under `src/preload/`). | `src/preload/index.ts` |
| **Renderer** | Chromium React SPA. No Node globals. Reaches main only via `window.electronAPI.<domain>.<method>(...)`. | `src/renderer/main.tsx` → `src/renderer/app.tsx` |

## The two-file pattern in `src/preload/`

For each IPC domain:

```
src/preload/<domain>/
├── index.ts            # Runs in PRELOAD context. Exports an object literal mapping
│                       #   methodName → ipcRenderer.invoke("channel", ...args)
│                       # Consumed via window.electronAPI.<domain>.<method>
└── <domain>-ipc.ts     # Bundled into MAIN context (not preload). Exports
                        #   reg<Domain>IPC() — registers all ipcMain.handle()
                        #   channels for this domain. Called from
                        #   src/main/index.ts inside app.on("ready", ...).
```

**Why two files in the same directory?** Convention, not technical necessity.
The build tool splits them by file convention (renderer-facing files use
`ipcRenderer`, main-facing files use `ipcMain`). When adding a new domain,
follow the same split.

## Adding a new cross-process API — the 6-step checklist

1. **Main side**: implement the handler in `src/main/...` (or an existing
   module). The handler returns a plain serializable value or throws.
2. **Main side**: register the IPC in `src/preload/<domain>/<domain>-ipc.ts`
   via `ipcMain.handle("channel", async (_e, ...args) => {...})`.
3. **Main side**: call the domain's `reg<Domain>IPC()` from `src/main/index.ts`
   inside `app.on("ready", ...)` (currently 16 registrations in order, lines
   117–131).
4. **Preload renderer side**: expose the API in
   `src/preload/<domain>/index.ts` as
   `methodName: (...args) => ipcRenderer.invoke("channel", ...args)`.
5. **Aggregator**: spread the domain into `electronAPI` in
   `src/preload/index.ts` (note: import the `*IPC` object, not the
   `reg*IPC()` function).
6. **Type surface**: type the new method in the renderer's `.d.ts` (under
   `src/renderer/types/` or wherever existing domain types live) so renderer
   code is fully typed when calling `window.electronAPI.<domain>.<method>`.
7. **Consume**: renderer calls `window.electronAPI.<domain>.<method>(...)`.

## Event push channels (one-way main → renderer)

For streamed events (download progress, power status, Python stdout), use
`webContents.send("channel", payload)` from the main side and
`ipcRenderer.on("channel", (_e, ...args) => cb(...args))` on the renderer
side. The renderer side lives in `src/renderer/ipc/Listener.ts` (the directory
name is now a misnomer — all other renderer-side IPC goes through
`window.electronAPI.*`).

Pre-`window.electronAPI` aggregations: domains like `emitter` only carry
event subscriptions.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false` for all windows except the
  main window (which uses `nodeIntegration: true, webSecurity: false` for
  legacy reasons — see `WindowManager.ts:27-95`).
- Permission requests are gated to `["media", "openExternal"]`
  (`WindowManager.ts:49-58`).
- `setWindowOpenHandler` routes `${BACKEND_ORIGIN}/user/login-page` to an
  embedded 480×640 child window; everything else goes to
  `shell.openExternal` (`WindowManager.ts:61-91`).
- Renderer is forbidden from importing `electron` or any Node module —
  TypeScript's `tsconfig.web.json` enforces this via the `types` array.

## Hono server (in-app HTTP API, separate from IPC)

The main process also embeds a Hono server (`src/main/server/index.ts`).
This is for **external clients** (kernels like Fuel/Rocket/Aqua, and the
standalone MCP server) to push data into the app over HTTP. Routes:

- `POST /notify` — kernel → UI notification entry
- `POST /error` — error reporting
- `GET /product-status` — product status query
- `POST /toast` — toast message
- `GET /heartbeat` — Windows-only watchdog
- `GET /mcp/*` and friends — MCP API (see mcp-expert scope)

Middleware order is significant: `honoLogger` → `DB()` (Drizzle init + FS
watcher on `FuelBinStat.db`) → `errorHandler` (wraps every successful
response in `{code:200, message:"成功", data}`) → `prettyJSON`.

The server boots **only if** `store.getSetting("all_data_path")` is non-empty.
Port starts at 8787 and is persisted as `server_port` in electron-store.

## Anti-patterns to avoid

- Adding a new channel **without** also exposing it in
  `src/preload/<domain>/index.ts` and `src/preload/index.ts`. The
  `electronAPI` aggregator is the only thing the renderer can see.
- Putting domain logic in `*-ipc.ts` files. Those are wiring; the
  implementation belongs in `src/main/core/` or `src/main/lib/`.
- Importing `electron` from `src/renderer/`. The bundler will not catch it;
  the renderer will fail at runtime with `module not found`.
- Forgetting the BUSL-1.1 license header on new files. See
  `src/main/index.ts` lines 1–9 for the canonical block.
