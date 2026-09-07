# QuantClass 研究工作流改进设计：知识积累与假设生成质量

- 日期：2026-08-25
- 状态：已批准（用户确认方案 B 源码校准版）
- 范围：`src/mcp-server/` 工具层改造 + runbook 纪律修订。优先解决两个实证痛点：**知识积累与闭环断裂**、**假设生成质量依赖自觉**。

## 1. 背景

### 1.1 流程试验暴露的问题（2026-07-22 ~ 07-31 五个 run 的证据）

| 证据 | 问题 |
|------|------|
| run-calmar-001 v5、run-cashconv-001 v1 的 lesson 均为「待回填」 | lesson 是进化循环核心载体，但无任何强制，占位文本可写入 |
| run-calmar-001 v5 实际基于 v3 分叉（v4 是死胡同），线性 trace 无法表达 | trace 缺分叉语义 |
| run-calmar-001 的假设引用 run-dd20 的旋钮发现（波动率收紧降回撤 2.8pp），只能靠文字记忆传递 | 无跨 run 结构化知识库 |
| run-dd20 停在 4 轮无疾而终；run-momentum-001/002 空目录烂尾 | run 无生命周期管理，无关闭决策 |
| runbook 要求「不得与历史假设重复」但无工具支持 | 重复假设靠 AI 自觉排查 |

### 1.2 RD-Agent v0.8.0 源码通读结论（本地 `D:\RD-Agents\RD-Agent`，commit 471eb30d）

2026-08-25 对 core/components/scenarios/oai 全层的源码通读（4 路并行探索，结论均有文件:行号证据）：

- **不是多 Agent 架构**：无 agent-to-agent 消息协议；所有「角色」是同一 LLM 后端上不同 system prompt 的单次调用，由 `RDLoop` 流水线写死编排。README 的 "multi-agent" 指 factor/model 两循环协同（代码实际是一个 loop + bandit 动作选择器）。
- **假设生成的三面夹击**（`scenarios/qlib/proposal/factor_proposal.py` + `prompts.yaml`）：全量历史渲染 + 上轮 feedback 预埋的 `new_hypothesis` 种子 + 显式探索纪律（先易后难、连续失败换方向）。
- **feedback 阶段预埋下一轮假设**：`HypothesisFeedback.new_hypothesis`（`core/proposal.py`），本轮 LLM 反馈直接产出下一轮假设种子，下轮可采纳/拒绝/改造。
- **DAG trace**（`core/proposal.py:141-318`）：`dag_parent` + `local_selection` 支持从任意历史节点分叉；`CheckpointSelector`（SOTAJump/BackJump）实现「SOTA 率低就开新分支/回跳」。
- **CoSTEER 知识图谱 V2**：task/error/success 节点，「曾犯同样错误但后来成功」的知识对检索（`components/coder/CoSTEER/knowledge_management.py:723-849`）。
- **任务机械去重**：新任务与历史实验比对，重复直接剔除（`factor_proposal.py:116-131`）。
- **DS 场景 critic-rewriter**：假设生成→批判→改写两阶段（`scenarios/data_science/proposal/exp_gen/proposal.py:705/774`，默认关闭）。
- **不借鉴**：并行 loop（与本客户端内核串行约束冲突）、LLM 判 SOTA（保留确定性规则防刷分）、MCTS 调度、CoSTEER 代码级进化图谱（我们的开发对象是 config 组装而非因子代码）。

## 2. 方案总览（五项）

| # | 改进 | 层 | 对标的 RD-Agent 机制 |
|---|------|----|---------------------|
| 1 | trace schema 升级：`basedOn` / `nextHypothesis` / lesson 必填校验 | 工具 | DAG 分叉 + feedback 预埋假设 |
| 2 | 跨 run 知识库：`record_knowledge` / `get_knowledge` | 工具 | CoSTEER 知识图谱（简化为结构化条目） |
| 3 | 假设生成规范：固定输入序列 + 自批判 + `hypothesisSource` | 纪律 + 工具校验 | 三面夹击上下文 + critic-rewriter |
| 4 | run 生命周期：`close_run` + 列表显示状态 | 工具 | —（RD-Agent 也无，我们的增量） |
| 5 | 组件清单：`list_factor_components` | 工具 | scenario desc / base features 枚举 |

## 3. 数据与产物结构

### 3.1 trace.jsonl 行 schema 扩展（向后兼容，新字段均可选）

```json
{
  "variantId": "v5",
  "basedOn": "v3",
  "hypothesis": "...",
  "hypothesisSource": "knowledge:k-2026-07-31-001 | trace:run-dd20/v2 | none",
  "changes": "...",
  "lesson": "...（必填，占位文本拒绝）",
  "nextHypothesis": "下一轮建议验证：……"
}
```

- `basedOn`：缺省视为上一 variant（保持线性语义）。
- `lesson` 校验：空、纯占位（「待回填」「TBD」「TODO」等，大小写不敏感）→ 拒绝写入。
- `hypothesisSource`：自由文本但推荐 `knowledge:<id>` / `trace:<runId>/<variantId>` 引用格式；缺省记 `none`。

### 3.2 knowledge.jsonl（workspace 根目录，跨 run 共享）

```json
{
  "id": "k-2026-08-25-001",
  "ts": "...",
  "knob": "波动.波动率20 过滤阈值",
  "change": "pct:<=0.25 → 0.20",
  "effect": "最劣窗口回撤 -21.88%→-21.78%（-0.1pp），年化 20.89%→21.08%（+0.19pp）",
  "evidence": [{ "runId": "run-calmar-001", "from": "v3", "to": "v5" }],
  "regime": "2024-01 流动性危机段",
  "tags": ["波动率", "回撤控制"]
}
```

- id 自动生成（`k-<date>-<seq>`），追加写，不修改不删除（知识只增不改；修正通过新条目表达）。
- 检索：`get_knowledge` 支持按 `knob` 子串过滤 + 全量列出（预期量级几十条，不做向量检索——YAGNI）。

### 3.3 run 状态

`brief.json` 旁新增字段（`close_run` 写入）：`status: active | achieved | abandoned | paused`、`closedAt`、`closeReason`。`list_strategies` 输出附带各 run 状态。

## 4. 工具变更清单

### 4.1 修改现有工具

| 工具 | 变更 |
|------|------|
| `record_experiment` | 新增可选字段 `basedOn`/`nextHypothesis`/`hypothesisSource`；lesson 占位校验；假设与历史条目语义近似时返回 `warnings`（字符 bigram Jaccard 相似度 > 0.7 触发，警告不阻断） |
| `list_strategies` | 各 run 输出附带 `status`/`closeReason` |

### 4.2 新增工具（`src/mcp-server/` 新文件 `knowledge-base.ts` + `research-run.ts` 扩展）

| 工具 | 入参 | 行为 |
|------|------|------|
| `record_knowledge` | `knob, change, effect, evidence[], regime?, tags?` | zod 校验后追加 `knowledge.jsonl`，返回生成的 id |
| `get_knowledge` | `knobFilter?` | 读取 knowledge.jsonl；有 filter 时按 knob 子串过滤 |
| `close_run` | `runId, status, reason` | 写入 run 状态；`achieved` 要求存在 SOTA 记录，否则报错 |
| `list_factor_components` | 无 | 枚举 real_trading 因子库/截面因子库目录（类目 + 因子名，只读，复用现有路径解析与安全校验），供 Researcher 落地假设 |

### 4.3 实现约束

- 全部复用 `strategy-files.ts` 的 `assertSafePathComponent` / `assertInsideWorkspace`；纯函数与 I/O 分离；zod 校验。
- 文件头保留项目版权头；Biome 风格。
- tools 注册与计数测试同步更新（`tests/mcp-server/tools.test.ts`）。

## 5. runbook 修订（`docs/superpowers/runbook/research-agent-runbook.md`）

1. **§4.1 Researcher 固定输入序列**：`get_knowledge()` → `get_run_summary` → `get_experiment_trace` → 上轮 `nextHypothesis`。新增自批判三问（与历史假设重复？有知识/证据支撑？可证伪——指明预期改善指标与方向？）。
2. **§4.5 record_experiment 新字段说明**：`basedOn` 何时填（分叉时必填）、`nextHypothesis` 写法、`hypothesisSource` 引用格式。
3. **新增收尾步骤**：循环退出后必须 `close_run`（达标/放弃/暂停 + 原因）；放弃时也鼓励把负面发现写 `record_knowledge`（负面知识同样宝贵）。
4. 工具计数与工具清单表格同步更新。

## 6. 测试

- `tests/mcp-server/knowledge-base.test.ts`：record/get 的正常路径与边界（占位 effect 不限制、evidence 结构校验、filter 命中/未命中）。
- `tests/mcp-server/research-run.test.ts` 增补：lesson 占位拒绝、`basedOn`/`nextHypothesis` 透传、`close_run` 状态机（achieved 无 SOTA 报错、重复 close 行为）、list_strategies 状态展示。
- 验证命令：`pnpm test:mcp`、`pnpm verify:mcp-tools`、`pnpm typecheck`。

## 7. 非目标（YAGNI）

- 不做向量检索/RAG 知识库（条目量级不需要）。
- 不做多 loop 并行、MCTS/bandit 调度（内核串行约束 + 复杂度）。
- 不把 SOTA 判定改为 LLM 判断（保留 score→年化→复杂度确定性口径）。
- 不做因子代码级进化知识图谱（CoSTEER 本体）。
- 不改动回测内核、实盘逻辑、MCP 鉴权。
