# QuantClass MCP 工具暴露修复设计文档

## 1. 背景

在 `run-momentum-001` 策略研发闭环实践中，Agent 发现以下 MCP 工具无法通过 `mcp__quantclass__*` 调用：

- `list_strategies`
- `read_strategy_file`
- `write_strategy_file`
- `validate_strategy`
- `evaluate_backtest`
- `submit_strategy_for_review`

代码探索发现这些工具已在 `src/mcp-server/tools.ts` 中实现，但运行时未暴露给 MCP 客户端。本设计文档定位根因并规划修复方案。

## 2. 目标

1. 确保上述 6 个本地工具在 MCP Server 启动时正确注册。
2. 修复工具注册、构建打包、运行时加载链路中的阻断点。
3. 补充冒烟测试，防止回归。
4. 验证 Agent 可以仅通过 MCP 完成：列策略、读/写文件、校验、评估、提交候选报告。

## 3. 根因假设

按可能性从高到低：

1. **工具注册代码被跳过**：`src/mcp-server/tools.ts` 中这些工具的注册可能被包裹在条件分支、注释或早期 return 中。
2. **运行时 bundle 未更新**：开发源码已更新，但 `resources/mcp-server/` 或 `out/` 中的构建产物仍是旧版本，导致 Electron 启动的是旧 MCP Server。
3. **Schema 验证失败**：工具 handler 入参 Schema 与实现不匹配，注册时静默失败。
4. **MCP Server 连接的是 Hono 子集**：当前客户端可能只暴露了 `mcp__quantclass__*` 中经过 Hono 路由的工具，而本地工具未被桥接。

## 4. 设计方案

### 4.1 注册链路梳理

`src/mcp-server/index.ts` 启动流程：

```ts
const server = new McpServer({ name: "quantclass", version: "1.0.0" })
registerTools(server)
registerResources(server)
await server.connect(new StdioServerTransport())
```

所有工具应在 `registerTools` 中显式注册。修复方式：

- 在 `registerTools` 末尾统一注册本地工具，不依赖任何运行时开关。
- 增加 `console.log` 或 `logger.info` 输出已注册工具总数和名称，便于排查。

### 4.2 工具清单与校验点

| 工具名 | 主要依赖 | 关键检查点 |
|--------|---------|-----------|
| `list_strategies` | `strategy-files.ts` | workspace 路径、返回数组结构 |
| `read_strategy_file` | `strategy-files.ts` | 路径安全、文件存在性 |
| `write_strategy_file` | `strategy-files.ts` | 路径安全、目录自动创建 |
| `validate_strategy` | `strategy-validator.ts` | 调用 `parse_config.py`、返回错误数组 |
| `evaluate_backtest` | `backtest-evaluator.ts` | 读取策略评价 CSV、返回评估对象 |
| `submit_strategy_for_review` | `review-submitter.ts` | 生成 candidate-report.md |

### 4.3 构建打包检查

检查 `scripts/copy-mcp-bundle.cjs`（或等效脚本）是否把 `src/mcp-server/` 编译输出复制到 `resources/mcp-server/`。

修复方式：

- 如果存在构建步骤，确保 `pnpm build` 或 `npm run build:mcp` 会重新生成 MCP Server bundle。
- 在开发验证阶段，直接运行源码版 MCP Server，绕过打包缓存问题。

### 4.4 运行时验证脚本

新增/复用一个独立脚本 `scripts/verify-mcp-tool-registration.mjs`（若不存在则创建），它：

1. 启动 MCP Server 子进程（stdio 模式）。
2. 发送 `tools/list` 请求。
3. 断言返回列表包含 6 个目标工具名。
4. 对每个工具发送一次最小参数调用，断言返回 `code === 0`。

该脚本作为 CI/本地验证入口。

### 4.5 单元测试补充

在 `tests/mcp-server/tools.test.ts` 中增加：

```ts
it("should expose local strategy development tools", async () => {
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)
  expect(names).to.include.members([
    "list_strategies",
    "read_strategy_file",
    "write_strategy_file",
    "validate_strategy",
    "evaluate_backtest",
    "submit_strategy_for_review",
  ])
})
```

## 5. 验收标准

1. 运行 `scripts/verify-mcp-tool-registration.mjs` 后，6 个工具全部出现在 `tools/list` 结果中。
2. 每个工具的最小参数调用返回 `code: 0` 且数据结构符合预期。
3. `submit_strategy_for_review` 能在 `workspace/agent-strategies/{runId}/candidate-report.md` 生成非空报告。
4. 现有测试 `pnpm test` 全部通过（或至少 `tests/mcp-server/` 相关测试通过）。

## 6. 非目标

- 不修改 Hono 控制器 `src/main/server/controllers/mcp.ts` 中的已有路由。
- 不改写 zeus/aqua 回测内核。
- 本次不涉及 `run_backtest` 异步化改造。

## 7. 风险

1. **Electron 主进程缓存**：即使源码修复，已安装的客户端仍可能使用旧 bundle。验证时需确认启动的是最新构建。
2. **权限问题**：`write_strategy_file` 和 `submit_strategy_for_review` 受 workspace 路径限制，验证时需提供正确工作区根目录。
3. **测试环境依赖**：`validate_strategy` 依赖 `resources/parse_config.py`，测试环境需确保 Python 可用。

## 8. 实施后发现与变更记录

### 8.1 工具实际已注册

代码审阅与运行时验证均确认，`src/mcp-server/tools.ts` 中已显式注册本节涉及的 6 个工具。进一步检查 `resources/mcp-server/index.js` bundle 后，也确认这些工具名出现在打包产物中。因此不存在“源码未注册”或“bundle 丢失工具”的问题。

### 8.2 源码与 bundle 不同步的风险

实施过程中发现的主要风险点是：开发（dev）模式实际运行的是 `resources/mcp-server/index.js` bundle，而非 `src/mcp-server/` 源码。当开发者直接修改源码但未执行 `pnpm build:mcp` 时，运行时的工具集与源码会出现滞后，表现为“改了代码不生效”或旧逻辑仍在运行。

修复措施：通过 `scripts/ensure-mcp-bundle.mjs` 在 dev 启动前自动同步 bundle。该脚本会在 `pnpm dev` / `pnpm dev:win` 等开发入口前执行，若检测到源码比 bundle 新，则自动调用 esbuild 重新打包 MCP Server，从而消除源码与 bundle 之间的不一致。

### 8.3 `evaluate_backtest` 回撤阈值判断修正

在验证 `evaluate_backtest` 时，发现其对 `max_drawdown_pct` 的判断逻辑存在语义错误。原实现为：

```ts
numericValue <= threshold
```

该逻辑会把“回撤 20%（优于 30% 阈值）”错误判定为失败，因为 `-20 <= -30` 为 `false`。

已修正为：

```ts
Math.abs(numericValue) <= Math.abs(threshold)
```

新逻辑按绝对值比较，符合“回撤越小越好”的金融语义，同时兼容用户以正数或负数两种形式书写阈值的场景。

### 8.4 验证覆盖

为确认修复效果，新增了以下验证手段：

- 新增 `scripts/verify-mcp-tool-registration.mjs`：启动 MCP Server stdio 子进程，调用 `tools/list` 并断言 6 个目标工具均存在，再对每个工具执行一次最小参数调用，验证返回 `code === 0`。
- 扩展 `tests/mcp-server/tools.test.ts`：补充对全部 27 个已注册工具的名单断言，并覆盖 6 个目标工具的调用路径。

上述测试已确认：MCP Server 共注册 27 个工具，且 `list_strategies`、`read_strategy_file`、`write_strategy_file`、`validate_strategy`、`evaluate_backtest`、`submit_strategy_for_review` 均可被正常调用。
