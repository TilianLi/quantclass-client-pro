# 基于 RD-Agent 思想的 QuantClass 量化研究工作流设计

> 版本：v0.1
> 适用：quantclass-client-pro v3.6.x + Hermes 5-Profile fleet
> 作者：Hermes 架构师
> 状态：设计稿，待 chief-trader / 用户确认后落地

## 1. 核心思想：把 RD-Agent 的“研究闭环”翻译到 QuantClass

### 1.1 RD-Agent 的关键抽象

| RD-Agent 概念 | 含义 | 在量化场景中的对应 |
|---|---|---|
| **Scenario** | 任务背景与数据环境 | A股 + 目标收益/回撤 + 模板约束 |
| **Hypothesis** | 待验证的研究假设 | “动量因子在大盘风格中有效，配合换手率过滤可提升夏普” |
| **Experiment** | 把假设变成可执行实验 | 生成 config.py → 回测 → 绩效评估 |
| **Feedback** | 实验结果驱动下一轮 | 未达标 → 改进 → 新 variant |
| **Workspace** | 代码/数据/中间结果落盘 | `workspace/agent-strategies/{run_id}/v{n}/` |
| **Trace** | 多轮实验历史 | `decisions/<date>/agent_rd_<run_id>.json` |
| **CoSTEER** | 自迭代机制 | generate → validate → backtest → evaluate → improve 循环 |

### 1.2 QuantClass 已有能力（可直接复用）

| 能力 | 现有载体 | RD-Agent 对位 |
|---|---|---|
| 策略文件读写/校验 | MCP tools: `read/write/validate_strategy` | Workspace + Coder |
| 策略导入/回测 | MCP tools: `import_strategy/run_backtest/get_performance` | Experiment Runner |
| 多 variant 评估 | MCP tool: `evaluate_backtest` | Summarizer / Evaluator |
| 候选报告提交 | MCP tool: `submit_strategy_for_review` | Review Gate |
| 实盘数据查询 | MCP tools: `get_buy_signals/get_sell_signals/get_account_info` | Production Feedback |
| 风控/事件/因子 | 5-Profile fleet: `risk-guardian/event-hunter/strategy-optimizer` | Multi-Agent 协作 |

### 1.3 关键差距

| 差距 | 说明 | 本设计补齐方式 |
|---|---|---|
| 无统一问题定义层 | 用户只说“做个策略”，没结构化 | 增加 **Research Question 层**（目标/约束/假设模板） |
| 无多假设并行探索 | 当前是单线迭代 | 增加 **Hypothesis Pool** + Bandit/LLM 选择器 |
| 无研究知识沉淀 | 每轮 run 独立，经验难复用 | 增加 **Insight Registry**（成功/失败假设记录） |
| 无盘后实盘反馈闭环 | 回测达标≠实盘有效 | 增加 **Live Monitor** 阶段，对比回测 vs 实盘绩效 |
| 无跨品种/跨周期扩展 | 只到 A 股选股 | 预留 **Multi-Scenario** 扩展点 |

---

## 2. 五层工作流总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: 问题定义 (Research Question)                               │
│  输入：用户意图 / 市场观察 / 历史研究空白                            │
│  输出：结构化研究任务 {goal, metric, constraints, horizon, scenario} │
│  负责：架构师（人类交互）+ strategy-optimizer（可行性评估）        │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 2: 假设生成 (Hypothesis Generation)                          │
│  输入：研究任务 + 因子库 + 事件库 + 历史 Insight                     │
│  输出：候选假设列表 [{id, hypothesis, rationale, prior_score}]       │
│  负责：strategy-optimizer（因子检验）+ event-hunter（事件驱动灵感）  │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: 实验执行 (Experiment Execution)                            │
│  输入：假设 → 生成 config.py → 校验 → 回测                           │
│  输出：每个假设的 backtest performance + evaluation                   │
│  负责：quant-ops（环境预检/回测执行）+ MCP tools                     │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 4: 信号仲裁与决策 (Signal Arbitration)                        │
│  输入：多假设实验结果 + 实时风控 + 事件情绪                           │
│  输出：候选策略报告 / 买入/卖出指令 / 风险告警                        │
│  负责：chief-trader（最终决策）+ risk-guardian（实时风控）            │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 5: 反馈与知识沉淀 (Feedback & Insight)                        │
│  输入：实盘绩效 + 回测绩效 + 市场变化                                │
│  输出：Insight Registry 更新 + 因子体检报告 + 下一轮问题               │
│  负责：strategy-optimizer（因子衰减）+ 架构师（知识文档化）           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 每层详细设计

### 3.1 Layer 1: 问题定义（Research Question）

**目标**：把模糊的用户意图转化为可量化、可验证的研究任务。

**输入示例**：
- 用户：“最近小盘风格很弱，想做一个大盘动量策略，年化>15%，回撤<20%。”
- 历史：“上周发现‘低估值+高股息’组合在震荡市表现稳健。”
- 系统：“某因子近 30 日 IC 连续为负，需替换。”

**输出结构**（`research_tasks/<task_id>.json`）：

```json
{
  "task_id": "rq-20260701-001",
  "created_at": "2026-07-01T09:00:00",
  "source": "user",
  "goal": "开发大盘风格动量选股策略",
  "metrics": {
    "annual_return_pct": { "target": 15.0, "operator": ">=" },
    "max_drawdown_pct": { "target": 20.0, "operator": "<=" },
    "sharpe_ratio": { "target": 1.0, "operator": ">=" }
  },
  "constraints": {
    "market": "A股",
    "universe": "沪深300成分股",
    "style": "large_cap",
    "template": "momentum",
    "max_variants": 20
  },
  "horizon": "medium",
  "status": "pending_hypothesis"
}
```

**处理流程**：
1. 架构师与用户对话，澄清目标/约束。
2. 架构师把任务写入 `research_tasks/<task_id>.json`（只写研究任务文件，不写交易文件）。
3. 架构师把任务转交 chief-trader，由其调度 strategy-optimizer 做可行性预评估。

---

### 3.2 Layer 2: 假设生成（Hypothesis Generation）

**目标**：基于研究任务，生成多个可验证的候选假设，并给出先验评分。

**输入**：
- `research_tasks/<task_id>.json`
- `factor_library/`（因子库定义）
- `event_driven/<date>/summary.json`（事件摘要）
- `insight_registry.json`（历史成功/失败假设）

**输出结构**（`hypotheses/<task_id>/<h_id>.json`）：

```json
{
  "hypothesis_id": "h-20260701-001-a",
  "task_id": "rq-20260701-001",
  "statement": "在沪深300成分股中，20日价格动量因子经过去极值和市值中性化后，能有效预测未来20日收益；叠加换手率<5%过滤可降低噪声。",
  "rationale": "历史回测显示大盘动量IC在2024-2025年稳定在0.04以上；近期小盘拥挤，大盘风格可能持续。",
  "factors": ["momentum_20d", "turnover_20d", "neutralize_market_cap"],
  "filters": [{"name": "turnover_lt", "params": {"threshold": 0.05}}],
  "prior_score": 0.72,
  "source": "strategy-optimizer",
  "status": "pending_experiment"
}
```

**生成策略**：
1. **模板变异**：从动量/价值/成长/质量等模板出发，生成参数组合。
2. **因子组合**：基于 `quant-factor-analysis` 的 IC/IR 矩阵，挑选有效因子组合。
3. **事件灵感**：基于 `event-hunter` 的近期事件，提出事件驱动型假设（如“政策利好+低估值”）。
4. **历史复用**：读取 `insight_registry.json`，对相似成功假设加权。

**选择器**：
- 第一轮：随机或均匀采样，保证探索。
- 后续轮：用 LLM 或简单 UCB Bandit 根据 prior_score + 历史胜率选择Top-K。

---

### 3.3 Layer 3: 实验执行（Experiment Execution）

**目标**：把每个假设变成 QuantClass 可执行的 config.py，完成校验、导入、回测。

**状态机**（复用 `quantclass-strategy-dev` 的 7 步状态机）：

```
init
  └→ generate: 写 workspace/agent-strategies/{run_id}/{h_id}/v{n}/config.py
  └→ validate: validate_strategy
       ├─ fail → improve → generate
       └─ pass → import: import_strategy(capWeight=0, dry-run)
            ├─ fail → improve → generate
            └─ pass → backtest: set_backtest_config → run_backtest → get_performance
                 ├─ fail → improve → generate
                 └─ pass → evaluate: evaluate_backtest
                      ├─ 达标 → record result
                      ├─ 未达标且未达上限 → improve → generate
                      └─ 达上限 → record best result
```

**关键增强**（相比现有 skill）：
- 每个假设独立目录：`workspace/agent-strategies/{run_id}/{h_id}/v{n}/`
- 每个假设最多 `max_variants_per_hypothesis` 轮（默认 10），全局 `max_hypotheses` 并行探索。
- `import_strategy` 必须用 `capWeight=0` 做 dry-run，避免污染实盘。
- 回测配置与研究任务一致（universe、时间范围、过滤条件）。

**输出**：
- `workspace/agent-strategies/{run_id}/{h_id}/experiment.json`（每轮 variant 绩效）
- `workspace/agent-strategies/{run_id}/{h_id}/best_config.py`（最优 variant）

---

### 3.4 Layer 4: 信号仲裁与决策（Signal Arbitration）

**目标**：整合多个假设的实验结果 + 风控 + 事件情绪，生成最终候选策略或交易指令。

**输入**：
- 各假设的 `experiment.json`
- `risk_status.json`（实时风控状态）
- `event_driven/<date>/summary.json`（事件情绪）
- `account.json`（当前账户/持仓）

**仲裁规则**（由 chief-trader 执行）：

| 优先级 | 信号 | 处理方式 |
|---|---|---|
| P0 | risk-guardian 触发熔断/止损 | 立即生成 `emergency_sell.json`，停止新策略 |
| P1 | 事件情绪极端负面（score < -80） | 对持仓生成卖出信号，暂停相关因子假设 |
| P2 | 假设实验达标且风险可控 | 提交候选策略报告，等待人工确认 |
| P3 | 假设实验未达标但某方向有潜力 | 记录 insight，进入下一轮 Layer 2 |

**输出**：
- `decisions/<date>/agent_rd_<run_id>.json`：决策记录
- `candidate-report.md`：人工确认用
- 必要时生成 `buy.json` / `sell.json`（仅 chief-trader 有权限）

---

### 3.5 Layer 5: 反馈与知识沉淀（Feedback & Insight）

**目标**：把实验结果和实盘反馈沉淀为可复用的研究知识。

**输入**：
- 回测绩效 vs 实盘绩效（如果已上线）
- `health_check_30f.json`（因子体检）
- 用户反馈/市场变化

**输出**：
- `insight_registry.json`：记录成功/失败假设，更新置信度
- `optimization_report.json`：策略优化报告
- 下一轮 `research_tasks/` 的新任务

**更新规则**：
- 假设达标且上线后实盘表现好 → 提升该因子组合权重，标记为“有效”。
- 假设回测好但实盘快速衰减 → 标记为“过拟合风险”，限制未来使用。
- 因子体检显示 IC 持续为负 → 自动发起新研究任务替换该因子。

---

## 4. 与现有 5 个 Profile 的职责边界

```
用户意图
  ↓
Hermes 架构师（你）
  ├─ 人类交互：澄清目标、确认风险、格式化汇报
  ├─ 架构配置：维护 research_tasks/、insight_registry/、cron
  └─ 转交 chief-trader 进入工作流

chief-trader（8642）
  ├─ 读取 research_tasks/<task_id>.json
  ├─ 调度 strategy-optimizer 生成假设池
  ├─ 调度 quant-ops 执行回测实验
  ├─ 读取 risk_status.json + event summary
  ├─ 仲裁信号、生成决策 / candidate-report
  └─ 把结果回传给架构师

risk-guardian（8643）
  ├─ 实时扫描风控
  ├─ 任何时刻触发 P0 熔断 → 直接写入 risk_status.json
  └─ chief-trader 读取后优先处理

event-hunter（8644）
  ├─ 盘前/盘中扫描事件
  ├─ 输出 event_driven/<date>/summary.json
  └─ 为 Layer 2 假设生成提供灵感，为 Layer 4 仲裁提供情绪信号

strategy-optimizer（8645）
  ├─ Layer 2：生成/筛选假设
  ├─ Layer 3：评估回测结果、指导改进方向
  ├─ Layer 5：更新 optimization_report.json、health_check_30f.json
  └─ 不直接调用 MCP tools，只输出结构化建议

quant-ops（8646）
  ├─ Layer 3：预检环境、执行回测
  ├─ 调用 MCP tools（write/validate/import/run_backtest）
  └─ 输出实验结果文件
```

**关键边界**：
- 架构师**不**直接调度 Agent，只通过 chief-trader 转交意图。
- 架构师**不**写入 `buy.json`/`sell.json`/`risk_status.json`。
- 架构师可以写入 `research_tasks/`、`insight_registry/` 等研究任务/知识文件（属于架构配置范畴）。

---

## 5. 数据目录与文件约定

```
D:\QuantClassSpace\QuantDataeal_trading\hermes_data├── research_tasks/              # 研究任务定义（架构师可写）
│   └── rq-<date>-<seq>.json
├── hypotheses/                # 候选假设（chief-trader 可写）
│   └── <task_id>/
│       └── <h_id>.json
├── experiments/               # 实验结果汇总（quant-ops 可写）
│   └── <run_id>/
│       └── experiment.json
├── insights/                  # 知识沉淀（架构师/optimizer 可写）
│   └── insight_registry.json
├── decisions/                 # 决策记录（chief-trader 可写）
│   └── <date>/
│       └── agent_rd_<run_id>.json
└── reports/                   # 候选报告（chief-trader 可写）
    └── <run_id>/
        └── candidate-report.md
```

---

## 6. 触发时机与 Cron 配置

| 触发时机 | 入口 | 执行内容 |
|---|---|---|
| 用户主动发起 | 架构师 → chief-trader | 完整 5 层工作流，直到 candidate-report |
| 周六 10:00 | cron → chief-trader | 自动扫描 insight_registry + health_check，发起新研究任务 |
| 盘前 08:30 | cron → event-hunter + risk-guardian | 更新事件/风控状态，供 chief-trader 早盘决策 |
| 因子体检异常 | strategy-optimizer → 架构师 | 自动生成替换因子研究任务 |

**Cron 模板**（`profiles/chief-trader/cron/jobs.json` 待新增）：

```json
{
  "jobs": [
    {
      "name": "saturday-rd-loop",
      "schedule": "0 10 * * 6",
      "prompt": "读取 hermes_data/research_tasks/ 中 pending_hypothesis 任务和 hermes_data/insights/insight_registry.json，生成候选假设，调用 quant-ops 执行回测，最终提交 candidate-report。",
      "toolsets": ["quant-trading"]
    }
  ]
}
```

---

## 7. 风险闸口与合规

| 风险 | 闸口设计 |
|---|---|
| 未审策略直接上线 | `import_strategy` 实验阶段用 `capWeight=0`；candidate-report 必须人工确认后才可调 `toggle_auto_trading` |
| 无限循环/资源耗尽 | 每层硬上限：`max_hypotheses`、`max_variants_per_hypothesis`、`max_total_experiments` |
| 回测过拟合 | Layer 5 强制对比回测 vs 实盘；过拟合假设标记并降权 |
| 风控熔断被绕过 | risk-guardian 独立写入 risk_status.json；chief-trader 任何决策前必读 |
| 事件噪音导致误交易 | event-hunter 只输出 ≥ impact_level 3 的事件；chief-trader 按 P0-P3 仲裁 |
| BUSL-1.1 合规 | 本工作流仅用于本地研究/非生产测试；生产用途需商业授权 |

---

## 8. 落地路线图

### Phase 1: 最小可用闭环（2-3 周）
- 复用现有 `quantclass-strategy-dev` skill 的 7 步状态机。
- 新增 `research_tasks/` 和 `hypotheses/` 文件结构。
- 实现单假设 → 多 variant 自动回测，输出 candidate-report。
- 人工确认后，由 chief-trader 调用 `import_strategy` + `toggle_auto_trading`。

### Phase 2: 多假设并行（3-4 周）
- 在 Layer 2 引入假设池生成器（基于因子库 + 事件摘要）。
- 实现多假设并行实验（受并发/资源限制）。
- 引入假设评分和简单选择器（Top-K / UCB）。

### Phase 3: 知识沉淀与自动迭代（4-6 周）
- 落地 `insight_registry.json` 和更新规则。
- 周六 cron 自动触发下一轮研究任务。
- 增加实盘 vs 回测对比监控。

### Phase 4: 多场景扩展（后续）
- ETF/期货/转债等场景。
- 外部数据源集成（财报、宏观、另类数据）。

---

## 9. 验收标准

- [ ] 用户给出高阶目标后，系统自动生成 ≥3 个候选假设。
- [ ] 每个假设能独立完成 generate → validate → import → backtest → evaluate。
- [ ] 达标假设生成 candidate-report.md，未经人工确认不触发实盘。
- [ ] risk-guardian 触发熔断时，系统立即停止并汇报。
- [ ] 实验结果自动写入 insight_registry，支持后续复用。
- [ ] 周六 cron 能自动触发一轮研究循环。

---

## 10. 与现有 SPEC 的衔接

本设计直接复用：
- `docs/superpowers/specs/2026-06-27-quantclass-agent-skill-design.md`：7 步状态机、工作区结构、安全闸口。
- `docs/superpowers/specs/2026-06-28-quantclass-mcp-tool-exposure-design.md`：MCP 27 tools 注册、bundle 同步、验证脚本。
- `resources/agent-skills/hermes/quantclass-strategy-dev/`：skill prompts、模板、阈值。

新增内容：
- `research_tasks/`、`hypotheses/`、`experiments/`、`insights/`、`reports/` 目录与文件规范。
- 5-Profile 职责边界与调用协议。
- Layer 2 假设生成器设计。
- Layer 5 知识沉淀与反馈闭环。
