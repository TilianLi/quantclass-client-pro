# MCP 配置 — 让 AI 客户端 (MiniMax-CLI / Claude Desktop / Cursor) 操控 QuantClass

## 先决条件

1. **QuantClass 客户端必须先启动一次**。
   启动时主进程会在 `~/.quantclass/mcp-port` 写入 Hono server 实际绑定的端口（默认 `8787`）。
   第一次启动若没看到这个文件，运行 `pnpm dev:win` 或安装好的 `quantclass.exe` 跑一下就有了。

2. **`~/.quantclass/mcp-port` 内容格式**：纯端口号 ASCII，例如 `8787`。

---

## 方案 1：本地开发构建（推荐用于联调）

适用于还没安装正式发行包、本地有 worktree 编译产物的场景。

```json
{
  "mcpServers": {
    "quantclass": {
      "command": "node",
      "args": [
        "D:\\QuantClassSpace\\quantclass-client-pro\\.worktrees\\feature-mcp-support\\dist\\win-unpacked\\resources\\mcp-server\\index.js"
      ],
      "env": {
        "QUANTCLASS_PORT": "8787"
      }
    }
  }
}
```

> 注：`env.QUANTCLASS_PORT` 是兜底，**实际生效**的是 `~/.quantclass/mcp-port` 里的端口。
> `mcp-server/client.ts` 的优先级是 env > port file > 8787。

---

## 方案 2：正式安装包（生产用）

安装 `dist/QuantclassClient-3.6.6.exe` 后，路径变成：

```json
{
  "mcpServers": {
    "quantclass": {
      "command": "node",
      "args": [
        "C:\\Program Files\\QuantclassClient\\resources\\mcp-server\\index.js"
      ],
      "env": {
        "QUANTCLASS_PORT": "8787"
      }
    }
  }
}
```

> 实际安装路径可能因 NSIS `perMachine` 选项（`oneClick=false, perMachine=true`）落到 `Program Files` 或用户自定义目录，**以你的实际安装为准**。可以在 Windows 设置里查"QuantclassClient"看安装路径。

---

## 各种 AI 客户端的 config 路径

| 客户端 | 配置文件路径 |
|---|---|
| **MiniMax-CLI / Claude Code (国内版)** | `~/.minimax/mcp.json` 或 `~/.claude/mcp.json` (按 `~/.config` 风格落地) |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Cursor** | `%USERPROFILE%\.cursor\mcp.json` |
| **VS Code + Continue** | `~/.continue/config.json` (不同 schema) |

> **MiniMax-CLI 实际配置位置**：如果走 Anthropic 兼容中转，看你安装时的 wrapper 命名。常见位置 `%USERPROFILE%\.minimax\mcp.json` 或者 `%USERPROFILE%\.claude\mcp.json`（同一份 CLI 复用 claude 生态）。最稳的探测方式：装好后 `mavis mcp ls` 会列出当前 daemon 已知 server。

---

## 验证步骤（推荐先做）

1. **客户端先启动一次**，看到主窗口出现即可关闭（端口文件已经写出来了）。
2. **在 PowerShell 跑下面这条看端口文件**：
   ```powershell
   Get-Content $env:USERPROFILE\.quantclass\mcp-port
   ```
3. **手测 stdio server 能起来**（3 秒后 Ctrl-C 杀掉）：
   ```powershell
   node "D:\...\dist\win-unpacked\resources\mcp-server\index.js"
   ```
   应该看到 `MCP Server` 启动消息、无 panic。
4. **配 AI 客户端 → 重启 AI 客户端 → 让 AI 列出 MCP tools**。
   Claude Code / MiniMax-CLI 通常用 `/mcp` 命令或类似接口列出已注册 tools。
   当前共注册 **20 个 tools**，按功能分组如下：

   - **系统控制（7 个）**：`get_system_status` / `toggle_min_data_schedule` / `exec_min_data` /
     `get_trading_config` / `update_trading_config` / `toggle_auto_trading` / `toggle_history_update`
   - **实盘数据查询（5 个）**：`get_buy_signals` / `get_sell_signals` / `get_stock_timing_plans` /
     `get_account_info` / `get_trading_info`
   - **回测工具（6 个）**：`get_backtest_config` / `set_backtest_config` / `run_backtest` /
     `get_backtest_result` / `get_backtest_performance` / `get_backtest_equity_curve`
   - **策略开发（2 个）**：`get_strategy_template` / `import_strategy`

---

## 故障排查

| 症状 | 可能原因 | 修法 |
|---|---|---|
| AI 客户端说 "spawn ENOENT" | `node` 不在 PATH | 改成 `"command": "C:\\Program Files\\nodejs\\node.exe"` 绝对路径 |
| "ECONNREFUSED 127.0.0.1:8787" | 客户端没启动 / 端口文件不存在 | 启动一次 QuantClass 客户端 |
| "EACCES ~/.quantclass/" | HOME 目录权限 | 用管理员 PowerShell 跑一次 QuantClass |
| 客户端启动后端口文件存在但连接拒绝 | 端口文件过期（旧端口） | 删除 `~/.quantclass/mcp-port` 重启客户端 |
| AI 客户端列出 tools 但调用全失败 | 客户端主进程没在 listen 那个端口 | 确认客户端 GUI 在跑（最小化也算） |
| Windows Defender 拦截 node.exe | Defender 误报 | 把 QuantClass 安装目录加白名单 |

---

## 20 个 Tool + 2 个 Resource 速查

### Tools

| Name | 参数 | 说明 |
|---|---|---|
| `get_system_status` | (none) | 调度器状态 / 网络 / 自动任务 |
| `toggle_min_data_schedule` | `{ isOn: bool, mode?: 'fast'\|'stable', autoAccurate?: bool, autoFuzzy?: bool }` | 启停分钟线数据定时任务 |
| `exec_min_data` | `{ type: 'accurate'\|'fuzzy', mode?: 'fast'\|'stable' }` | 手动触发一次数据获取 |
| `get_trading_config` | (none) | 读交易配置 |
| `update_trading_config` | `{ field: string, value: string\|number\|boolean }` | 更新交易配置（field 是 dot-key） |
| `toggle_auto_trading` | `{ isOn: bool }` | 启停自动交易 |
| `toggle_history_update` | `{ isOn: bool }` | 启停历史数据更新 |
| `get_buy_signals` | (none) | 查询实盘买入信号列表 |
| `get_sell_signals` | (none) | 查询实盘卖出信号列表 |
| `get_stock_timing_plans` | `{ type: 'buy'\|'sell' }` | 查询个股择时买入/卖出计划 |
| `get_account_info` | (none) | 查询实盘账户信息 |
| `get_trading_info` | (none) | 查询 Aqua 交易信息 |
| `get_backtest_config` | (none) | 查询当前回测配置 |
| `set_backtest_config` | `{ initial_cash?, start_date?, end_date?, filter_kcb?, filter_cyb?, filter_bj? }` | 设置回测配置 |
| `run_backtest` | (none) | 执行策略回测 |
| `get_backtest_result` | (none) | 查询回测选股结果 |
| `get_backtest_performance` | (none) | 查询回测绩效指标 |
| `get_backtest_equity_curve` | `{ step?: number }` | 查询回测资金曲线 |
| `get_strategy_template` | (none) | 获取策略开发模板 |
| `import_strategy` | `{ configFilePath: string, capWeight?: number }` | 导入策略到 QuantClass |

### Resources

| URI | 内容 |
|---|---|
| `quantclass://status` | 系统状态快照（等价 `get_system_status`） |
| `quantclass://config/trading` | 交易配置快照（等价 `get_trading_config`） |

---

## 安全提示

- 这套 MCP server **只支持 stdio**，并且**完全只听本地** `127.0.0.1`。
- 不要把 `~/.quantclass/mcp-port` 暴露给非本机进程 —— 它是单端口发现文件，跨机器用会落到 fallback `8787`，但实际绑在主进程上的端口可能不一样。
- `/mcp/status` 之外的所有路由都需要 `Authorization: Bearer <token>`，token 由主进程启动时生成并写入 `~/.quantclass/mcp-token`；独立 MCP Server 进程会读取该文件并自动携带。
