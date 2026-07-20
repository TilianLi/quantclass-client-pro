# QuantClass × RDAgent：AI Agent 量化研究工作流设计

- 日期：2026-07-20
- 状态：待评审
- 范围：在 quantclass-client-pro 现有 MCP 基建之上，参考 RDAgent 的 R&D 进化循环，设计一套「假设 → 实现 → 回测 → 评估 → 进化」的 AI Agent 工作流，并补齐基建缺口。

## 1. 背景

### 1.1 已有基建（quantclass-client-pro）

- **MCP Server**（`src/mcp-server/`，stdio 模式，28 个 tools）：AI 客户端经 stdio 连接，内部通过本地 Hono HTTP 服务（仅 `127.0.0.1`，Bearer token 鉴权）调用客户端能力。
- **策略工作区**（`src/mcp-server/strategy-files.ts`）：`workspace/agent-strategies/<runId>/<variantId>/` 两级目录模型，variant 目录以 `v` 开头；所有读写经 `assertSafePathComponent` / `assertInsideWorkspace` 路径安全校验。
- **策略开发闭环工具**：`get_strategy_template` → `write_strategy_file` → `validate_strategy` → `import_strategy`（isolate 隔离同组旧策略，capWeight 默认 0）→ `set_backtest_config` → `run_backtest` → `get_backtest_result / performance / equity_curve`。
- **评估工具**（`src/mcp-server/backtest-evaluator.ts`）：`evaluate_backtest` / `compare_backtest_variants`，按 5 项阈值（`annual_return_pct`、`max_drawdown_pct`（绝对值比较）、`sharpe_ratio`、`win_rate_pct`、`profit_loss_ratio`）判定达标并选出最优 variant；指标解析自回测产物 `策略评价.csv`。
- **人工审阅**（`src/mcp-server/review-submitter.ts`）：`submit_strategy_for_review` 生成 `candidate-report.md`，等待人工确认后才导入实盘。

### 1.2 RDAgent 核心思路

参考 [R&D-Agent-Quant 论文](https://arxiv.org/abs/2505.15155) 与 [RDAgent 文档](https://rdagent.readthedocs.io/en/stable/scens/quant_agent_fin.html)：

- **R（Research）**：基于场景设定 + 历史实验 trace（知识库）生成可证伪的研究假设。
- **D（Development）**：CoSTEER 式编码循环——实现 → 执行 → 错误反馈 → 修正，直到可运行。
- **进化循环（Evolving）**：每轮实验产生反馈总结，驱动下一轮假设；trace 即知识库，持续积累；`evolving_n` 控制迭代轮数。
- **SOTA 追踪**：每轮与历史最优对比，决定是否更新 SOTA。

### 1.3 差距分析

现有基建已覆盖 D 侧（实现/回测/评估/审阅），对照 RDAgent 缺 R 侧与进化侧：

| # | 缺口 | 影响 |
|---|------|------|
| 1 | 无 run 级「研究任务书」（目标 + 阈值 + 约束的结构化载体） | 假设生成无锚点，评估标准散落在对话中 |
| 2 | 无实验 trace 持久化（假设 ↔ 配置 ↔ 绩效 ↔ 结论） | 无法跨轮积累知识，进化无从谈起 |
| 3 | 无跨 variant 的 SOTA / 趋势汇总 | 每轮只能两两对比，缺少全局视角 |
| 4 | 假设生成缺少可用组件清单（因子库/信号库枚举） | 假设可能落到客户端不支持的因子上（待确认可行性，列入可选） |

## 2. 方案选项

### 方案 A：纯提示词工作流（零代码改动）

不改动客户端，直接由 AI 客户端（如 Kimi Code、Claude Desktop）用现有 28 个 MCP tools，按一份 Runbook（SOP 提示词）执行 R&D 循环；trace 以 Markdown/JSON 文件形式由 AI 自行写入工作区。

- 优点：今天就能用；零发布成本；安全性不变。
- 缺点：trace 格式靠 AI 自觉，易漂移；无结构化校验；跨会话恢复弱。

### 方案 B：基建增强 + 编排层（推荐）

在 `src/mcp-server/` 新增 4 个「工作流级」纯函数工具：`create_research_run`、`record_experiment`、`get_experiment_trace`、`get_run_summary`，把研究任务书与实验 trace 固化到工作区（zod 校验、路径安全复用现有模块）；循环决策仍由 AI 客户端驱动（方案 A 的 Runbook 作为编排层）。

- 优点：状态结构化、可校验、可跨会话恢复；改动小且全部为可单测的纯函数，契合项目测试约定（`node --test`）；不引入新的安全面。
- 缺点：需要一次代码改动与发版。

### 方案 C：客户端内置自治 Agent

在 Electron 主进程内置 LLM 调用与循环编排，UI 展示进化过程，一键启动。

- 优点：体验最好，不依赖外部 AI 客户端。
- 缺点：范围最大（LLM Key 管理、UI、自动交易安全评审），与当前 MCP-first 架构重复造轮子。

**推荐：方案 B（含方案 A 的 Runbook 作为编排层，M2 交付）。方案 C 作为远期方向，不在本期范围。**

## 3. 角色与职责

编排者（Orchestrator）为外部 AI 客户端，通过 MCP 驱动，内部按 RDAgent 分四个逻辑角色（同一 LLM 会话内的分工，不是独立进程）：

| 角色 | 职责 | 使用的工具 |
|------|------|-----------|
| Researcher | 读 brief + trace，提出一个可证伪假设，并落成具体的 config 变更方案（因子选择、参数、过滤条件） | `get_experiment_trace`、`get_run_summary`、`get_strategy_template` |
| Developer | 把假设实现为策略文件；CoSTEER 循环：写文件 → 校验 → 按错误反馈修正 | `write_strategy_file`、`read_strategy_file`、`validate_strategy` |
| Runner/Evaluator | 导入策略、执行回测、读取绩效并按阈值评估、更新 SOTA | `import_strategy`、`set_backtest_config`、`run_backtest`、`get_backtest_performance`、`evaluate_backtest`、`compare_backtest_variants` |
| Summarizer | 把本轮实验（假设、变更、绩效、结论、教训）写入 trace，生成下一轮反馈 | `record_experiment` |

## 4. 工作流（单次 run）

前置：用户给出研究目标（如「中证 1000 范围内改进动量选股，年化 ≥ 15%、最大回撤 ≤ 25%」）。

```
create_research_run(runId, brief)                 # 初始化任务书
loop 最多 evolving_n 轮（brief 中配置，默认 5）:
  1. Researcher: 读 brief + trace → 提出假设 H_n → 分配 variantId = v{n}
  2. Developer:  实现 v{n} 策略文件；validate_strategy 失败则按错误修正，
                 单 variant 最多修正 3 次，仍失败 → 记 trace verdict=failed，进下一轮
  3. Runner:     import_strategy(isolate=true) → set_backtest_config → run_backtest
  4. Evaluator:  get_backtest_performance → evaluate_backtest(阈值)
                 → compare_backtest_variants(本轮 vs 历史 SOTA)
  5. Summarizer: record_experiment(...) → trace.jsonl
  6. 若全部阈值达标 → 跳出循环
submit_strategy_for_review(最优 variant)           # 生成 candidate-report.md
[人工 gate] 用户确认后才执行 import_strategy(capWeight>0) / 开启实盘
```

约束：

- 每轮只提出并验证**一个**假设（RDAgent 的单假设原则，保证 trace 可归因）。
- Agent **绝不**自动执行实盘相关操作：`import_strategy` 的 `capWeight` 在循环内恒为 0；`toggle_auto_trading` 不在工作流内；启用实盘永远由人工在审阅 `candidate-report.md` 后执行。
- 回测是长耗时操作，循环内串行执行，不并发回测。

## 5. 数据与产物结构

```
workspace/agent-strategies/<runId>/
├── brief.json              # 研究任务书（create_research_run 写入）
├── trace.jsonl             # 实验 trace，每行一条实验记录（record_experiment 追加）
├── v1/                     # variant 目录（现有模型，v 开头）
│   ├── config.py
│   └── ...                 # 因子库/信号库等策略文件
├── v2/
└── candidate-report.md     # 候选策略报告（submit_strategy_for_review 生成）
```

### brief.json schema

```json
{
  "runId": "run-momentum-001",
  "goal": "改进中证1000动量选股策略",
  "universe": "中证1000",
  "thresholds": {
    "annual_return_pct": 15,
    "max_drawdown_pct": 25,
    "sharpe_ratio": 1.0
  },
  "backtest": {
    "start_date": "2020-01-01",
    "end_date": null,
    "initial_cash": 1000000
  },
  "constraints": ["filter_kcb=1"],
  "evolving_n": 5,
  "createdAt": "2026-07-20T16:00:00.000Z"
}
```

`thresholds` 的 key 与 `evaluate_backtest` 的 `Thresholds` 完全一致；`backtest` 字段与 `set_backtest_config` 白名单字段一致。

### trace.jsonl 行 schema

```json
{
  "ts": "2026-07-20T16:05:00.000Z",
  "variantId": "v1",
  "hypothesis": "20日动量叠加换手率过滤可提升年化并降低回撤",
  "changes": "config.py 选股因子改为 mom_20 + turnover_rank<0.3",
  "files": ["config.py"],
  "metrics": {
    "annual_return_pct": 12.3,
    "max_drawdown_pct": 28.1,
    "sharpe_ratio": 0.9,
    "win_rate_pct": 52.0,
    "profit_loss_ratio": 1.4
  },
  "evaluation": { "passed": false, "score": 0.33 },
  "verdict": "completed | failed | sota",
  "lesson": "动量窗口过短导致换手过高，下一轮拉长窗口并加入波动率过滤"
}
```

`verdict` 枚举：`completed`（正常完成未更新 SOTA）、`sota`（刷新历史最优）、`failed`（校验/回测失败）。`lesson` 为 Summarizer 产出的下一轮反馈，是进化循环的核心载体。

## 6. 新增 MCP 工具（方案 B）

在 `src/mcp-server/` 新增 `research-run.ts`（纯函数，含 zod schema），并在 `tools.ts` 注册，tools 总数 28 → 32：

| 工具 | 入参 | 行为 |
|------|------|------|
| `create_research_run` | `runId`, `brief` | 幂等创建 run 目录并写入 `brief.json`；runId 已存在则报错（不覆盖） |
| `record_experiment` | `runId`, `entry` | zod 校验后向 `trace.jsonl` 追加一行 |
| `get_experiment_trace` | `runId`, `tail?` | 读取 trace；`tail=N` 时只返回最近 N 条（控制上下文体积） |
| `get_run_summary` | `runId` | 汇总：实验总数、各 verdict 计数、当前 SOTA（按 evaluation.score → annual_return_pct 次序比较）、距阈值差距、各指标随轮次趋势 |

实现约束：

- 复用 `strategy-files.ts` 的 `assertSafePathComponent` / `assertInsideWorkspace`，runId 校验规则与现有一致。
- 文件头保留项目 BUSL-1.1 版权头；代码风格遵循 Biome 配置。
- 纯函数与 I/O 分离，便于 `node --test` 单测。

可选（待确认后另行评估）：`list_factor_components`，枚举客户端可用因子/信号组件供 Researcher 落地假设。需先确认客户端是否具备可枚举的因子库元数据，本期不实现。

## 7. 错误处理与安全

- **校验失败**：`validate_strategy` 错误原文回喂 Developer 修正，单 variant 上限 3 次；超限记 `verdict=failed` 并附错误摘要，进入下一假设，不中断 run。
- **回测失败/超时**：同样记 `failed`，不中断 run；连续 2 次回测失败则终止 run 并提示检查数据/内核状态（`get_system_status`）。
- **全部轮次未达标**：trace 完整保留，`submit_strategy_for_review` 仍可提交「当前最优」，报告自带「未完全达标」标注。
- **路径安全**：全部文件操作限制在工作区内，复用现有校验，不新增例外。
- **实盘安全**：循环内 `capWeight` 恒为 0；不调用任何自动交易开关；启用实盘必须经人工 gate。
- **网络安全**：MCP 仍仅监听 `127.0.0.1` + Bearer token，无变更。

## 8. 测试

- `tests/mcp-server/research-run.test.ts`：覆盖 create/record/trace/summary 的正常路径与边界（runId 非法、路径穿越、重复创建、trace 为空、tail 截断、SOTA 比较）。
- `tests/mcp-server/tools.test.ts`：注册数 28 → 32 更新。
- 验证命令：`pnpm test:mcp`、`pnpm verify:mcp-tools`、`pnpm typecheck`。

## 9. 里程碑

| 里程碑 | 内容 | 交付物 |
|--------|------|--------|
| M1 | 4 个工作流级 MCP 工具 + 单测（方案 B 核心） | `research-run.ts`、测试、tools 注册 |
| M2 | 编排 Runbook（给 AI 客户端的 SOP 提示词，方案 A 形态，即刻可用） | `docs/` 下 Runbook 文档 |
| M3（远期，不在本期） | 客户端内置自治编排（方案 C） | 另行立项 |

## 10. 非目标（YAGNI）

- 不做多假设并行 / bandit 动作选择（RDAgent 的高级特性，待单假设循环跑通后再评估）。
- 不做因子与模型的联合优化（R&D-Agent(Q) 的完整能力），本期只覆盖策略配置层面的假设进化。
- 不改动回测内核、实盘交易逻辑与 MCP 鉴权机制。
- 不在循环内自动导入实盘或调整 `capWeight`。
