# QuantClass MCP 工具暴露修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 QuantClass MCP 策略开发闭环工具在运行时不可见/不可靠的问题，使 Agent 能通过 MCP 调用 `list_strategies`、`read/write_strategy_file`、`validate_strategy`、`evaluate_backtest`、`submit_strategy_for_review`。

**Architecture:** 源码侧工具已实现并注册，但 dev/打包运行时均依赖 `resources/mcp-server/index.js` bundle，bundle 未随源码自动更新会导致 Agent 看到旧工具列表。本计划通过 (1) dev 模式启动前自动同步 bundle，(2) 增加注册日志，(3) 增加端到端验证脚本和测试，确保工具始终可被发现和调用。

**Tech Stack:** TypeScript, Node.js 22, esbuild, native `node:test`, MCP SDK, Electron.

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/mcp-server/tools.ts` | 注册所有 MCP 工具；本次增加注册日志。 |
| `src/preload/mcp/mcp-ipc.ts` | 返回 MCP Server 启动路径；本次增加 dev 模式下 bundle 过期检测与自动 rebuild。 |
| `scripts/verify-mcp-tool-registration.mjs` | 新增：stdio 启动 MCP Server，调用 `tools/list` 和每个目标工具，输出验证报告。 |
| `tests/mcp-server/tools.test.ts` | 新增/扩展：断言 6 个目标工具出现在 `tools/list` 结果中，并做最小参数调用。 |
| `package.json` | 可能新增 `dev:mcp` 或调整脚本，保持现有 `build:mcp` 不变。 |

---

## Task 1: Add registration logging to `registerTools`

**Files:**
- Modify: `src/mcp-server/tools.ts`

- [ ] **Step 1: Write the failing test (existing behavior)**

Run:
```bash
pnpm build:mcp
node -e "
const { spawn } = require('child_process');
const cp = spawn('node', ['resources/mcp-server/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
cp.stdout.on('data', d => out += d.toString());
setTimeout(() => { cp.kill(); console.log(out.includes('registered') ? 'HAS_LOG' : 'NO_LOG'); }, 2000);
"
```
Expected: `NO_LOG` (currently no startup log).

- [ ] **Step 2: Add registration count log at end of `registerTools`**

Insert at the end of `registerTools` (before closing brace):

```typescript
console.log(
  `[mcp-server] registered ${Object.keys(server.server?._registeredTools ?? {}).length ?? "unknown"} tools`,
)
```

Note: MCP SDK 1.x public API may not expose `_registeredTools`. If unavailable, replace with a static count:

```typescript
console.log("[mcp-server] MCP tools registered successfully")
```

- [ ] **Step 3: Rebuild and verify log appears**

Run:
```bash
pnpm build:mcp
node -e "
const { spawn } = require('child_process');
const cp = spawn('node', ['resources/mcp-server/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
cp.stdout.on('data', d => out += d.toString());
setTimeout(() => { cp.kill(); console.log(out.includes('registered') || out.includes('MCP tools registered') ? 'HAS_LOG' : 'NO_LOG'); console.log(out); }, 2000);
"
```
Expected: `HAS_LOG` and stdout contains the registration message.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/tools.ts
pnpm build:mcp
git add resources/mcp-server/index.js
git commit -m "feat(mcp): add registration startup log"
```

---

## Task 2: Auto-rebuild MCP bundle in dev mode when stale

**Files:**
- Modify: `src/preload/mcp/mcp-ipc.ts`
- Create: `scripts/ensure-mcp-bundle.mjs`

- [ ] **Step 1: Create `scripts/ensure-mcp-bundle.mjs`**

```javascript
#!/usr/bin/env node
/**
 * 在 dev 模式下启动 MCP Server 前，检查 resources/mcp-server/index.js
 * 是否比 src/mcp-server/ 源码旧。如果是，自动运行 pnpm build:mcp。
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const srcDir = resolve(process.cwd(), "src", "mcp-server")
const bundlePath = resolve(process.cwd(), "resources", "mcp-server", "index.js")

function newestMtime(dir) {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const mtime = statSync(join(entry.parentPath ?? dir, entry.name)).mtimeMs
    if (mtime > max) max = mtime
  }
  return max
}

const bundleMtime = existsSync(bundlePath) ? statSync(bundlePath).mtimeMs : 0
const srcMtime = newestMtime(srcDir)

if (srcMtime > bundleMtime) {
  console.log("[ensure-mcp-bundle] MCP bundle is stale, rebuilding...")
  execFileSync("pnpm", ["build:mcp"], { stdio: "inherit", shell: true })
} else {
  console.log("[ensure-mcp-bundle] MCP bundle is up to date")
}
```

- [ ] **Step 2: Modify `src/preload/mcp/mcp-ipc.ts` to call ensure script in dev mode**

Locate `getMcpServerInfoHandler` and insert before returning the path:

```typescript
if (!app.isPackaged) {
  const ensureScript = join(app.getAppPath(), "scripts", "ensure-mcp-bundle.mjs")
  if (existsSync(ensureScript)) {
    try {
      execFileSync("node", [ensureScript], { stdio: "inherit" })
    } catch (error) {
      logger.warn(`[mcp] 自动同步 bundle 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
```

Add imports at top of file:

```typescript
import { execFileSync, existsSync } from "node:fs"
```

Wait — `existsSync` is from `node:fs`, `execFileSync` is from `node:child_process`. Correct imports:

```typescript
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
```

(`join` is already imported.)

- [ ] **Step 3: Test stale-bundle rebuild**

Run:
```bash
touch src/mcp-server/tools.ts
node scripts/ensure-mcp-bundle.mjs
```
Expected: console prints "MCP bundle is stale, rebuilding..." and `pnpm build:mcp` runs.

- [ ] **Step 4: Test up-to-date bundle**

Run again:
```bash
node scripts/ensure-mcp-bundle.mjs
```
Expected: console prints "MCP bundle is up to date".

- [ ] **Step 5: Commit**

```bash
git add scripts/ensure-mcp-bundle.mjs src/preload/mcp/mcp-ipc.ts
pnpm build:mcp
git add resources/mcp-server/index.js
git commit -m "feat(mcp): auto-rebuild stale mcp bundle in dev mode"
```

---

## Task 3: Create `scripts/verify-mcp-tool-registration.mjs`

**Files:**
- Create: `scripts/verify-mcp-tool-registration.mjs`

- [ ] **Step 1: Write the verification script**

```javascript
#!/usr/bin/env node
/**
 * 启动 MCP Server（stdio），验证策略开发闭环工具是否已注册且可调用。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REQUIRED_TOOLS = [
  "list_strategies",
  "read_strategy_file",
  "write_strategy_file",
  "validate_strategy",
  "evaluate_backtest",
  "submit_strategy_for_review",
]

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "qc-verify-"))
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(process.cwd(), "resources", "mcp-server", "index.js")],
    env: { ...process.env, QUANTCLASS_AGENT_WORKSPACE: workspace },
  })
  const client = new Client({ name: "verify", version: "1.0.0" })
  await client.connect(transport)

  const toolsResult = await client.listTools()
  const names = toolsResult.tools.map((t) => t.name)
  const missing = REQUIRED_TOOLS.filter((n) => !names.includes(n))

  console.log("Registered tools count:", names.length)
  console.log("Required tools present:", missing.length === 0)
  if (missing.length > 0) {
    console.error("Missing tools:", missing)
    await client.close()
    rmSync(workspace, { recursive: true, force: true })
    process.exit(1)
  }

  // Minimal call tests
  await client.callTool({ name: "list_strategies", arguments: {} })
  await client.callTool({ name: "write_strategy_file", arguments: { runId: "run1", variantId: "v1", filename: "config.py", content: "backtest_name = 'x'\nstrategy_list = []\n" } })
  await client.callTool({ name: "read_strategy_file", arguments: { runId: "run1", variantId: "v1", filename: "config.py" } })
  await client.callTool({ name: "validate_strategy", arguments: { configFilePath: join(workspace, "run1", "v1", "config.py") } })
  await client.callTool({ name: "evaluate_backtest", arguments: { performances: [{ variantId: "v1", annual_return_pct: 10, max_drawdown_pct: -20 }], thresholds: { annual_return_pct: 0, max_drawdown_pct: -30 } } })
  await client.callTool({ name: "submit_strategy_for_review", arguments: { runId: "run1", variantId: "v1", evaluation: { passed: true, score: 1, details: { annual_return_pct: { value: 10, threshold: 0, passed: true } } }, strategyPath: "run1/v1/config.py", summary: "test" } })

  console.log("All required tools callable.")
  await client.close()
  rmSync(workspace, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Add script to `package.json`**

Add under `scripts`:

```json
"verify:mcp-tools": "node scripts/verify-mcp-tool-registration.mjs"
```

- [ ] **Step 3: Run verification script**

```bash
pnpm verify:mcp-tools
```
Expected:
```
Registered tools count: >= 6
Required tools present: true
All required tools callable.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-mcp-tool-registration.mjs package.json
pnpm build:mcp
git add resources/mcp-server/index.js
git commit -m "feat(mcp): add tool registration verification script"
```

---

## Task 4: Expand `tests/mcp-server/tools.test.ts`

**Files:**
- Modify: `tests/mcp-server/tools.test.ts`

- [ ] **Step 1: Replace/extend test file**

```typescript
import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

describe("mcp tools integration", () => {
  const TMP = mkdtempSync(join(tmpdir(), "qc-tools-"))
  let client: Client
  let transport: StdioClientTransport

  before(async () => {
    process.env.QUANTCLASS_AGENT_WORKSPACE = TMP
    transport = new StdioClientTransport({
      command: "node",
      args: [join(process.cwd(), "resources", "mcp-server", "index.js")],
      env: { ...process.env, QUANTCLASS_AGENT_WORKSPACE: TMP },
    })
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(transport)
  })

  after(async () => {
    await client.close()
    rmSync(TMP, { recursive: true, force: true })
  })

  it("workspace root is set", async () => {
    const { getWorkspaceRoot } = await import(
      "../../src/mcp-server/strategy-files.ts"
    )
    assert.strictEqual(getWorkspaceRoot(), TMP)
  })

  it("exposes strategy development tools", async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    assert.ok(names.includes("list_strategies"))
    assert.ok(names.includes("read_strategy_file"))
    assert.ok(names.includes("write_strategy_file"))
    assert.ok(names.includes("validate_strategy"))
    assert.ok(names.includes("evaluate_backtest"))
    assert.ok(names.includes("submit_strategy_for_review"))
  })

  it("writes and reads strategy file via MCP", async () => {
    const content = "backtest_name = 'test'\nstrategy_list = []\n"
    const writeRes = await client.callTool({
      name: "write_strategy_file",
      arguments: { runId: "run1", variantId: "v1", filename: "config.py", content },
    })
    assert.ok(JSON.stringify(writeRes).includes("success"))

    const readRes = await client.callTool({
      name: "read_strategy_file",
      arguments: { runId: "run1", variantId: "v1", filename: "config.py" },
    })
    const text = readRes.content.find((c) => c.type === "text")?.text
    assert.strictEqual(text, content)
  })

  it("validates strategy config via MCP", async () => {
    const configPath = join(TMP, "run1", "v1", "config.py")
    const res = await client.callTool({
      name: "validate_strategy",
      arguments: { configFilePath: configPath },
    })
    const text = res.content.find((c) => c.type === "text")?.text ?? ""
    const parsed = JSON.parse(text)
    assert.strictEqual(parsed.valid, true)
  })

  it("evaluates backtest via MCP", async () => {
    const res = await client.callTool({
      name: "evaluate_backtest",
      arguments: {
        performances: [{ variantId: "v1", annual_return_pct: 10, max_drawdown_pct: -20 }],
        thresholds: { annual_return_pct: 0, max_drawdown_pct: -30 },
      },
    })
    const text = res.content.find((c) => c.type === "text")?.text ?? ""
    const parsed = JSON.parse(text)
    assert.strictEqual(parsed.passed, true)
    assert.strictEqual(parsed.bestVariantId, "v1")
  })

  it("submits strategy for review via MCP", async () => {
    const res = await client.callTool({
      name: "submit_strategy_for_review",
      arguments: {
        runId: "run1",
        variantId: "v1",
        evaluation: {
          passed: true,
          score: 1,
          details: { annual_return_pct: { value: 10, threshold: 0, passed: true } },
        },
        strategyPath: "run1/v1/config.py",
        summary: "test summary",
      },
    })
    const text = res.content.find((c) => c.type === "text")?.text ?? ""
    const parsed = JSON.parse(text)
    assert.ok(parsed.reportPath.endsWith("candidate-report.md"))
  })
})
```

- [ ] **Step 2: Run MCP tests**

```bash
pnpm test:mcp
```
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-server/tools.test.ts
pnpm build:mcp
git add resources/mcp-server/index.js
git commit -m "test(mcp): add integration tests for strategy development tools"
```

---

## Task 5: Update design doc with any deviations

**Files:**
- Modify: `docs/superpowers/specs/2026-06-28-quantclass-mcp-tool-exposure-design.md`

- [ ] **Step 1: Append findings**

Add a section:

```markdown
## 8. 实施后发现

- 源码中的 6 个工具实际已注册；`resources/mcp-server/index.js` bundle 也包含这些工具名。
- 主要风险点是 dev 模式使用 bundle 而非源码，源码修改后若未 `pnpm build:mcp` 会导致运行时工具集滞后。
- 通过 `scripts/ensure-mcp-bundle.mjs` 在 dev 启动前自动同步 bundle，可消除此类不一致。
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-28-quantclass-mcp-tool-exposure-design.md
git commit -m "docs: update mcp tool exposure design with implementation findings"
```

---

## Self-Review Checklist

- [x] Spec coverage: each requirement in design doc maps to a task.
- [x] No placeholders: every step has actual code/commands.
- [x] Type consistency: `Client`, `StdioClientTransport`, `QUANTCLASS_AGENT_WORKSPACE` used consistently.
- [x] File paths exact: all paths match project structure.

## Verification Commands

After all tasks:

```bash
pnpm build:mcp
pnpm test:mcp
pnpm verify:mcp-tools
```

All three should exit 0.
