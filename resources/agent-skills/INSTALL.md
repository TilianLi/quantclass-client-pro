# QuantClass Agent Skill 安装指南

本指南面向使用 **OpenClaw** 或 **HermesAgent** 的 QuantClass 用户，说明如何安装并配置 `quantclass-strategy-dev` skill，让 AI Agent 自动开发 A 股量化策略。

---

## 前置条件

1. **已安装 QuantClass 客户端**（开发构建或正式安装包均可）。
2. **已安装 OpenClaw 或 HermesAgent**，并能正常启动。
3. **系统已安装 Node.js ≥ 22**（因为 MCP server 用 Node 22 的 TypeScript type stripping）。
4. 确保 QuantClass 客户端至少启动过一次，用于生成端口和 token 文件：
   - Windows: `%USERPROFILE%\.quantclass\mcp-port`
   - Windows: `%USERPROFILE%\.quantclass\mcp-token`

---

## 第一步：确认 QuantClass MCP Server 可用

1. 启动 QuantClass 客户端。
2. 在 PowerShell 中查看端口：

   ```powershell
   Get-Content $env:USERPROFILE\.quantclass\mcp-port
   ```

   应输出类似 `8787` 的端口号。
3. 手测 MCP server 能否启动：

   ```powershell
   node "D:\QuantClassSpace\quantclass-client-pro\resources\mcp-server\index.js"
   ```

   按 `Ctrl+C` 几秒后退出。只要没有 panic 报错即可。

---

## 第二步：安装 Agent Skill

> **注意**：OpenClaw 与 HermesAgent 加载 skill 时都只认 `<skill-name>/SKILL.md`（YAML frontmatter + Markdown body）。skill package 里的 `skill.yaml`、`prompts/`、`workflows/` 子目录由 `SKILL.md` 正文引用说明，框架本身不会自动读取它们。

### OpenClaw

1. 找到 OpenClaw 的 **workspace skills** 目录。常见位置：
   - Windows: `%USERPROFILE%\.openclaw\workspace\skills\`
   - 或 OpenClaw 配置中 `agents.defaults.workspace` 指向目录下的 `skills/`。

2. 复制 skill package：

   ```powershell
   # 开发构建
   Copy-Item -Recurse "D:\QuantClassSpace\quantclass-client-pro\resources\agent-skills\openclaw\quantclass-strategy-dev" `
     "$env:USERPROFILE\.openclaw\workspace\skills\"

   # 或正式安装包
   Copy-Item -Recurse "C:\Program Files\QuantclassClient\resources\agent-skills\openclaw\quantclass-strategy-dev" `
     "$env:USERPROFILE\.openclaw\workspace\skills\"
   ```

3. 在 OpenClaw 配置中注册 QuantClass MCP server。编辑 `%USERPROFILE%\.openclaw\openclaw.json`，在合适位置加入：

   ```json
   {
     "mcpServers": {
       "quantclass": {
         "command": "node",
         "args": [
           "D:\\QuantClassSpace\\quantclass-client-pro\\resources\\mcp-server\\index.js"
         ],
         "env": {
           "QUANTCLASS_PORT": "8787",
           "QUANTCLASS_AGENT_WORKSPACE": "D:\\QuantClassSpace\\quantclass-client-pro\\workspace\\agent-strategies"
         }
       }
     }
   }
   ```

   如果是正式安装包，把 args 路径改为：
   ```json
   "C:\\Program Files\\QuantclassClient\\resources\\mcp-server\\index.js"
   ```

   并把 `QUANTCLASS_AGENT_WORKSPACE` 指向你希望存放策略文件的工作区（建议放在 QuantClass 项目或数据目录下，便于查找）。

4. 重启 OpenClaw。

### HermesAgent

> **提示**：Hermes 已内置一个更全面的 QuantClass 研发 skill `quantclass-agent-rd`（`quant-trading` 类别）。如果你只需要“基于模板自动生成策略并回测迭代”，可直接使用 `quantclass-agent-rd`；以下 `quantclass-strategy-dev` 是更轻量的独立包。

1. 找到 HermesAgent 的 skills 目录。常见位置：
   - Windows: `%USERPROFILE%\.hermes\skills\`
   - 或 HermesAgent 配置中指定的 skills 目录。

2. 复制 skill package：

   ```powershell
   # 开发构建
   Copy-Item -Recurse "D:\QuantClassSpace\quantclass-client-pro\resources\agent-skills\hermes\quantclass-strategy-dev" `
     "$env:USERPROFILE\.hermes\skills\"

   # 或正式安装包
   Copy-Item -Recurse "C:\Program Files\QuantclassClient\resources\agent-skills\hermes\quantclass-strategy-dev" `
     "$env:USERPROFILE\.hermes\skills\"
   ```

3. 在 Hermes 配置中注册 QuantClass MCP server。编辑 `%USERPROFILE%\.hermes\config.yaml`，加入：

   ```yaml
   mcp_servers:
     quantclass:
       command: "node"
       args:
         - "D:\\QuantClassSpace\\quantclass-client-pro\\resources\\mcp-server\\index.js"
       env:
         QUANTCLASS_PORT: "8787"
         QUANTCLASS_AGENT_WORKSPACE: "D:\\QuantClassSpace\\quantclass-client-pro\\workspace\\agent-strategies"
       timeout: 180
       connect_timeout: 60
   ```

   正式安装包请相应调整路径。

4. 重启 HermesAgent。

---

## 第三步：验证 Skill 已加载

### OpenClaw

```bash
openclaw skills list
```

确认 `quantclass-strategy-dev` 已出现。

### HermesAgent

```bash
hermes skills list | grep quantclass
```

确认 `quantclass-strategy-dev` 已出现。

---

## 第四步：使用示例

对 Agent 说出你的目标：

```text
基于动量模板，开发一个年化收益>15%、最大回撤<20% 的 A 股选股策略。
```

Agent 会自动执行：

1. 读取 `templates/config.py.tpl` 和 `config/thresholds.yaml`。
2. 调用 `get_strategy_workspace_root` 获取绝对工作区根目录。
3. 生成 `workspace/agent-strategies/{run_id}/v1/config.py`。
4. 调用 `validate_strategy` 校验。
5. 调用 `import_strategy` 导入 QuantClass。
6. 调用 `set_backtest_config` + `run_backtest` 跑回测。
7. 调用 `get_backtest_performance` 读取绩效。
8. 调用 `evaluate_backtest` 判断是否达标。
9. 未达标则进入改进循环，生成 `v2`、`v3`……
10. 达标后调用 `submit_strategy_for_review`，生成 `candidate-report.md` 等待你确认。

你可以在以下目录查看完整历史：

```text
{QUANTCLASS_AGENT_WORKSPACE}/
└── {run_id}/
    ├── v1/
    │   └── config.py
    ├── v2/
    │   └── config.py
    ├── ...
    └── candidate-report.md
```

---

## 第五步：人工确认与实盘

**候选策略报告生成后，Agent 不会自动开启实盘交易。**

你需要：

1. 阅读 `{QUANTCLASS_AGENT_WORKSPACE}/{run_id}/candidate-report.md`。
2. 确认策略绩效达标、逻辑合理。
3. 手动让 Agent 执行：

   ```text
   把 run-xxx 的候选策略导入 QuantClass 并开启自动交易。
   ```

   或者直接手动在 QuantClass 客户端里启用。

---

## 关于 `QUANTCLASS_AGENT_WORKSPACE`

MCP server 默认把策略文件放在其**可执行文件所在目录**向上两层的 `workspace/agent-strategies/` 下：

- 开发构建：`D:\QuantClassSpace\quantclass-client-pro\workspace\agent-strategies`
- 正式安装包：`C:\Program Files\QuantclassClient\workspace\agent-strategies`

为避免策略文件散落在安装目录，**强烈建议**在 MCP server 的 env 中显式设置 `QUANTCLASS_AGENT_WORKSPACE`，指向你固定的策略研发目录。

---

## 故障排查

| 症状 | 可能原因 | 修法 |
|---|---|---|
| Agent 说 spawn ENOENT | `node` 不在 PATH | 改成 `C:\Program Files\nodejs\node.exe` 绝对路径 |
| ECONNREFUSED 127.0.0.1:8787 | QuantClass 客户端没启动 | 启动一次客户端 |
| 端口文件存在但连接拒绝 | 端口过期 | 删除 `~/.quantclass/mcp-port` 并重启客户端 |
| validate_strategy 失败 | `config.py` 缺少 `backtest_name` 或 `strategy_list` | 检查 Agent 是否正确填充模板 |
| import_strategy 失败 | `config.py` 格式与 QuantClass 不匹配 | 检查 `strategy_list` 字段结构 |
| Agent 不知道 config.py 绝对路径 | 未调用 `get_strategy_workspace_root` | 在生成文件后调用该工具拼接路径 |
| Agent 无限循环 | 阈值太激进或模板参数范围不对 | 调整 `config/thresholds.yaml` 里的阈值 |
| 找不到 skill | skills 目录路径不对 | 确认 OpenClaw 用 `~/.openclaw/workspace/skills/`，Hermes 用 `~/.hermes/skills/` |

---

## 自定义配置

你可以修改 skill package 里的以下文件来调整行为：

- `config/thresholds.yaml`：修改达标阈值和迭代上限。
- `templates/config.py.tpl`：修改策略模板骨架。
- `SKILL.md`：修改 Agent 的 system/user prompt 与工作流说明。

修改后重启 Agent 框架即可生效。

---

## 安全提示

- QuantClass MCP Server 只监听 `127.0.0.1`，不对外暴露。
- `~/.quantclass/mcp-token` 是本地鉴权凭证，不要分享给他人。
- 策略文件只能写入 `QUANTCLASS_AGENT_WORKSPACE` 指定的目录，并已做路径穿越防护。
- **自动交易需要人工确认**，Agent 默认不会自行调用 `toggle_auto_trading`。
