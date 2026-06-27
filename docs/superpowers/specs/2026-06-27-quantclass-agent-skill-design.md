# QuantClass 策略开发 Agent Skill 设计文档

## 1. 背景与目标

QuantClass 客户端已暴露 20 个 MCP tools，覆盖系统控制、实盘查询、回测、策略导入等能力。但当前工具集不足以支撑“AI Agent 自主开发策略”的完整闭环：Agent 无法读写策略文件、无法校验策略、无法自动评估多次回测结果并迭代优化。

本文档设计一套**官方内置的 Agent Skill Package**，使 OpenClaw、HermesAgent 等 MCP-native 的 Agent 框架安装后即可理解并执行 QuantClass 策略开发工作流，无需用户自行编写 Agent Runner。

**目标**：
- 用户给出一个高阶目标（如“基于动量模板开发年化>15%、回撤<20% 的策略”），Agent 自动完成生成、校验、导入、回测、评估、迭代，最终提交候选策略等待人工确认。
- 全部能力通过现有/新增 MCP tools 提供，Agent 框架只负责解析 skill 定义、调用 tools、管理状态。

## 2. 设计约束

基于前期讨论，确定以下约束：

- **市场范围**：A 股。
- **策略生成方式**：模板填充型，不自由生成代码。
- **成功标准**：固定阈值（年化收益、最大回撤、夏普、胜率、盈亏比）。
- **存储位置**：`quantclass-client-pro/workspace/agent-strategies/`（项目内固定工作区）。
- **迭代控制**：硬上限，最多生成 N 个 variant。
- **安全闸口**：回测达标后必须人工确认，才能执行导入/启停实盘。
- **外部数据**：第一批版本不集成，保留扩展点。

## 3. 总体架构

### 3.1 新增目录结构

在 `quantclass-client-pro/resources/agent-skills/` 下发布 skill package：

```
resources/agent-skills/
├── openclaw/
│   └── quantclass-strategy-dev/
│       ├── skill.yaml              # skill 元信息和入口
│       ├── prompts/
│       │   ├── init.md             # 任务初始化 prompt
│       │   ├── generate.md         # 生成策略 prompt
│       │   ├── evaluate.md         # 评估回测结果 prompt
│       │   └── improve.md          # 改进策略 prompt
│       ├── templates/
│       │   └── config.py.tpl       # 策略模板
│       ├── workflows/
│       │   └── strategy-dev.yaml   # 状态机定义
│       └── config/
│           └── thresholds.yaml     # 默认阈值
├── hermes/
│   └── quantclass-strategy-dev/
│       └── ...（结构同上，语法按 Hermes 调整）
└── init-tools/
    └── create-skill-package.js     # 可选：初始化脚本
```

### 3.2 数据流

```
┌─────────────────┐     skill.yaml + prompts     ┌──────────────────┐
│  OpenClaw/      │ ────────────────────────────▶│  QuantClass MCP  │
│  HermesAgent    │                              │  Server          │
│                 │◀─────────────────────────────│                  │
└─────────────────┘      tool results            └────────┬─────────┘
                              HTTP + Bearer token         │
                                                          ▼
                                                 ┌──────────────────┐
                                                 │  QuantClass 主进程 │
                                                 │  (Hono API)       │
                                                 └──────────────────┘
```

1. 用户在 Agent 框架中安装 `quantclass-strategy-dev` skill。
2. Agent 读取 skill 中的 workflow 和 prompts，开始按状态机执行。
3. Agent 调用 QuantClass MCP tools 完成文件读写、校验、导入、回测、评估。
4. 达标后生成候选报告，等待用户确认。
5. 用户确认后，由用户或 Agent 调用 `import_strategy` / `toggle_auto_trading`（默认不自动启停实盘）。

### 3.3 与 Agent Runner 方案的边界

- **MCP Server**：只暴露原子能力（tools/resources），无状态，不维护迭代进度。
- **Agent 框架**：负责 workflow 解析、状态机推进、LLM 调用、prompt 组装、迭代计数、人工确认 gate。
- **本 Skill Package**：是一份声明式规范 + prompt/template 集合，让 Agent 框架知道“该做什么、按什么顺序做”。

## 4. MCP Server 扩展

### 4.1 复用现有 tools

| Tool | 用途 |
|---|---|
| `get_strategy_template` | Agent 开局读取策略模板规范 |
| `import_strategy` | 把生成好的策略导入 QuantClass |
| `set_backtest_config` | 设置回测参数 |
| `run_backtest` | 执行回测 |
| `get_backtest_performance` | 读取回测绩效 |
| `get_backtest_result` | 读取回测选股明细 |
| `get_backtest_equity_curve` | 读取资金曲线 |
| `toggle_auto_trading` | 人工确认后由用户决定是否让 Agent 调用 |

### 4.2 新增 tools

| Tool | 用途 |
|---|---|
| `list_strategies` | 列出工作区下已有策略目录/variant |
| `read_strategy_file` | 读取指定策略文件内容 |
| `write_strategy_file` | 写入/覆盖策略文件 |
| `validate_strategy` | 调用 Python 解析 `config.py`，返回语法/依赖错误 |
| `evaluate_backtest` | 对比多次回测结果，返回最优 variant 及是否达标 |
| `submit_strategy_for_review` | 生成候选报告，标记任务等待人工确认 |

### 4.3 明确不新增的工具

- `fetch_market_data`：第一批版本不集成外部数据，保留扩展点。
- LLM 调用、prompt 组装、状态机推进：由 Agent 框架负责。

## 5. Skill Package 详细设计

### 5.1 skill.yaml

```yaml
name: quantclass-strategy-dev
version: 1.0.0
description: 基于模板自动开发 A 股量化策略并回测迭代
author: QuantClass
mcpServers:
  - quantclass
entry:
  prompt: prompts/init.md
  workflow: workflows/strategy-dev.yaml
```

### 5.2 workflows/strategy-dev.yaml

```yaml
name: quantclass-strategy-dev
version: 1.0.0
state_machine:
  initial: init
  states:
    init:
      action: read_template_and_thresholds
      transitions:
        - next: generate

    generate:
      action: llm_generate_strategy
      input:
        template: templates/config.py.tpl
      output: workspace/{run_id}/v{n}/config.py
      transitions:
        - next: validate

    validate:
      action: validate_strategy
      transitions:
        - on_success: import
        - on_failure: improve

    import:
      action: import_strategy
      transitions:
        - on_success: backtest
        - on_failure: improve

    backtest:
      action: run_backtest
      transitions:
        - on_success: evaluate

    evaluate:
      action: evaluate_backtest
      transitions:
        - on_met: submit
        - on_not_met: improve
        - on_limit_reached: submit_best

    improve:
      action: llm_improve_strategy
      transitions:
        - next: generate

    submit:
      action: submit_strategy_for_review
      final: true

    submit_best:
      action: submit_strategy_for_review
      final: true
```

### 5.3 config/thresholds.yaml

```yaml
thresholds:
  annual_return_pct: 15.0
  max_drawdown_pct: 20.0
  sharpe_ratio: 1.0
  win_rate_pct: 55.0
  profit_loss_ratio: 1.5

iteration:
  max_variants: 20
  max_retries_per_variant: 3
```

### 5.4 prompts 设计

- `init.md`：告知 Agent 任务目标、可用 tools、工作目录、阈值、安全规则。
- `generate.md`：基于模板生成 `config.py`，填充因子参数、过滤条件、仓位逻辑。
- `evaluate.md`：对比回测绩效与阈值，输出是否达标及改进建议。
- `improve.md`：基于 evaluate 结论，让 LLM 修改具体参数或增加过滤条件。

## 6. 文件与工作区管理

### 6.1 目录命名规则

```
workspace/agent-strategies/
└── {run_id}/
    ├── meta.json              # 任务元数据：目标、阈值、起止时间
    ├── v1/
    │   ├── config.py
    │   ├── backtest/
    │   │   ├── performance.json
    │   │   ├── result.json
    │   │   └── equity_curve.json
    │   └── evaluation.md      # Agent 对本轮的评估
    ├── v2/
    │   └── ...
    └── candidate-report.md    # 最终候选报告（人工确认用）
```

### 6.2 版本控制

- 工作区目录加入 `.gitignore` 或单独管理，避免污染主仓库。
- 每轮 variant 独立目录，不覆盖历史，便于复盘。

## 7. 安全与错误处理

| 风险 | 处理措施 |
|---|---|
| Agent 写坏文件 | 每轮 variant 独立目录；保留原始模板；不覆盖 `real_trading/`。 |
| 无限循环 | `max_variants` 和 `max_retries_per_variant` 硬上限。 |
| 回测失败 | `validate_strategy` 提前拦截语法错误；回测内核异常返回错误给 Agent，进入改进或重试。 |
| 误开实盘 | `submit_strategy_for_review` 后必须人工确认；`toggle_auto_trading` 默认不自动调用。 |
| Token/端口过期 | MCP client 自动重读 `~/.quantclass/mcp-port` 和 `~/.quantclass/mcp-token`。 |
| 阈值配置错误 | `evaluate_backtest` 校验阈值字段，缺失时报错。 |

## 8. 测试与验收

### 8.1 单元测试

- 新增 MCP tools 的接口测试（mock Hono API 响应）。
- `validate_strategy` 需覆盖 syntax error、missing dependency、valid config 三种情况。
- `evaluate_backtest` 需覆盖达标、不达标、边界值。

### 8.2 集成测试

- 使用示例模板跑一次完整 workflow，验证状态机按 `init → generate → validate → import → backtest → evaluate → submit` 流转。
- 验证未达标时进入 `improve → generate` 循环，直到达标或达到 `max_variants`。

### 8.3 人工验收

- 在 OpenClaw 或 HermesAgent 中安装 skill。
- 给定高阶目标，观察 Agent 是否能自主产出候选策略报告。
- 人工确认后，验证 `import_strategy` 是否正确导入到 QuantClass。

## 9. 未来扩展

- **外部数据集成**：第二批可加入 `fetch_market_data` tool，封装 `kimi-datasource` 的股票/财报/宏观接口。
- **多策略模板**：支持轮动、动量、价值、多因子等更多模板。
- **参数优化**：引入网格搜索或遗传算法，由 Agent 框架调度批量回测。
- **实盘监控**：回测达标上实盘后，增加实盘绩效跟踪和自动下架逻辑。

## 10. 交付物清单

- [ ] `resources/agent-skills/openclaw/quantclass-strategy-dev/` skill package
- [ ] `resources/agent-skills/hermes/quantclass-strategy-dev/` skill package
- [ ] MCP server 新增 6 个 tools（`list_strategies`、`read_strategy_file`、`write_strategy_file`、`validate_strategy`、`evaluate_backtest`、`submit_strategy_for_review`）
- [ ] 新增 tools 的单元测试
- [ ] 集成测试脚本
- [ ] 用户安装与使用说明文档
