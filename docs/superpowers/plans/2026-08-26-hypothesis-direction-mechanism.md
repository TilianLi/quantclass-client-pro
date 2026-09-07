# 假设与新方向生成机制设计（借鉴 RD-Agent 源码）

> 日期：2026-08-26。状态：P0 + Loop 编排已实现（见 §4.5），P1/P2 为规划。
> 调研对象：microsoft/RD-Agent 源码（本地 `D:\RD-Agents\RD-Agent`，commit 471eb30d）。

## 1. 问题

当前 RD 闭环（MCP 工具链）只支持「调参」：假设 = 自由文本，变更 = 已有因子的参数/阈值微调。缺三层能力：

1. **假设无类型**：无法区分「调参」「新组合」「新因子」「新方向」，探索覆盖不可度量。
2. **新因子无通路**：`write_factor_file` 只有 AST 白名单闸门，假设→公式→代码→分层验证的链路不存在。
3. **无探索策略**：没有「何时该转向」的机制，critic 三问只查重；run 之间的新方向完全靠人/LLM 临场发挥。

## 2. RD-Agent 源码调研要点（为什么这样设计）

| 机制 | RD-Agent 实现 | 关键文件 |
|------|--------------|----------|
| 假设结构 | 纯文本 hypothesis + `action ∈ {factor, model}` 路由字段；FactorTask = {factor_name, description, formulation, variables} | `core/proposal.py:24-50`、`scenarios/qlib/proposal/quant_proposal.py:23-37` |
| 上下文注入 | 全量历史 + 最近一次实验 + SOTA 实验 + 场景规则书；按 action 过滤历史但互注对方 SOTA | `components/proposal/__init__.py:29-65`、`quant_proposal.py:99-135` |
| 探索策略 | 80% 写在 prompt 规则书（`hypothesis_specification`：先简后繁、连续 N 轮不超 SOTA 就换方向）；代码只强制任务去重 | `scenarios/qlib/prompts.yaml:95-112` |
| 方向调度 | contextual bandit（Linear Thompson Sampling，8 维指标向量，贝叶斯线性回归后验）；消融证明优于 LLM 选方向（IC 0.0532 vs 0.0476，同预算多跑 33% 轮次） | `scenarios/qlib/proposal/bandit.py`（约 100 行） |
| feedback | 固定五字段 JSON（Observations / Hypothesis Evaluation / New Hypothesis / Reasoning / Replace Best Result），prompt 内置转向规则 | `scenarios/qlib/prompts.yaml:165-226` |
| 新因子验证 | 分层：AST 落盘 → debug 数据小样本执行 → 硬指标检查（无 inf/索引/缺失率）→ 与 SOTA 因子库截面相关 ≥0.99 去重 → 全量回测 | `components/coder/factor_coder/`、`scenarios/qlib/developer/factor_runner.py:46-61` |
| 错误回喂 | 失败错误用正则归一化（ErrorType+行号），下次生成注入「同类错误的失败→成功代码配对」 | `components/coder/CoSTEER/knowledge_management.py:723-849` |
| 知识结晶 | **成功才入库**：失败只暂存错误分析，final_decision=True 才把整条工作链写进知识图 | `knowledge_management.py:884-925` |
| 多 Agent | 不是对话式群聊，是五个流水线工位（HypothesisGen → Hypothesis2Experiment → coder → runner → feedback），角色价值在独立上下文构造与 prompt 资产 | `components/workflow/rd_loop.py` |

两个不学的设计：SOTA 判定用 LLM 布尔值（我们的确定性 score→年化→复杂度更稳）；bandit 上下文取「最近一次实验」会漂移（我们若做，用每臂最近 k 次均值）。

## 3. 总体设计

```
Researcher（角色化 prompt + 规则书）
   │  输出结构化假设：action + hypothesis + factorSpec? + hypothesisSource
   ▼
Developer（write_strategy_file / write_factor_file）
   ▼
Runner（import_strategy → set_strategy_weight → run_dev_walkforward）
   ▼
Evaluator（evaluate_backtest，确定性 score）
   ▼
Summarizer（record_experiment：observations/hypothesisEvaluation/lesson/nextHypothesis）
   ▼
知识结晶（P1：达标条目自动生成知识；错误归一化入库）
```

P0 = 假设结构化 + 规则书 + lesson 结构化（纯配置/schema 级，零行为风险）
P1 = 新因子分层验证（小样本执行、值检查、共线性去重、错误归一化回喂）
P2 = 方向调度（plateau 检测规则先行，bandit 待 trace 数据积累后实现）

## 4. P0 详细设计（本次实现）

### 4.1 假设 action 字段与 factorSpec（research-run.ts）

`experimentEntrySchema` 新增两个可选字段：

```ts
/** 假设动作类型 */
action: z.enum(["tune_param", "combine", "new_factor", "new_direction"]).optional()
/** action=new_factor 时必填：新因子规格（对齐 RD-Agent FactorTask） */
factorSpec: z.object({
  factorName: z.string().min(1),   // 因子名（不含 .py）
  formulation: z.string().min(1),  // 计算定义/公式
  variables: z.string().optional() // 依赖变量说明
}).optional()
```

schema 级 superRefine：`action === "new_factor"` 时 `factorSpec.factorName` 与 `factorSpec.formulation` 必填，否则拒绝写入。旧 trace 条目无 action 字段，读取不受影响（向后兼容）。

`run_dev_walkforward` 工具参数同步增加 `action` / `factorSpec` 透传（job 写 trace 时带入）。

### 4.2 假设规则书（hypothesis-spec.ts → get_strategy_template）

新文件 `src/mcp-server/hypothesis-spec.ts` 导出 `HYPOTHESIS_SPECIFICATION` 常量（中文规则书，内容见该文件）。注入点选在 MCP 侧的 `get_strategy_template` handler：把规则书合并进响应 `data.hypothesisSpecification`。**不动主进程** `/mcp/strategy/template` 端点——规则书与 MCP 工具同生命周期、同 bundle 发布，避免 out/main 重建。

规则书核心条款：
- 动作类型四选一的定义与适用场景
- 先简后繁：先用 tune_param 建立基线再上新因子
- 转向规则：连续 2 轮 SOTA 无改进（completed 且非 sota），下一轮 action 不得为 tune_param
- new_factor 纪律：factorSpec 必填；公式只能用日频行情/财务可得字段；必须陈述与现有因子库预期低相关的理由
- 可证伪：必须指明预期改善的指标与方向

### 4.3 lesson 结构化（observations / hypothesisEvaluation）

`experimentEntrySchema` 新增两个可选字段：

- `observations`：数据事实（指标数值、诊断发现、与 SOTA/上轮的对比）
- `hypothesisEvaluation`：假设判定（被支持/证伪、原因分析）

`nextHypothesis` 字段已存在，继续承担「下一轮方向」职责（对应 RD-Agent feedback 的 New Hypothesis）。

校验为**软约束**（非阻断 warning）：条目带 `evaluation` 且无 `windows`（即 record_experiment 直写的后验条目，含 validation）时，缺 observations 或 hypothesisEvaluation 则在响应 `warnings` 中提示。`run_dev_walkforward` 写入的条目 lesson 是任务启动前给的预测性文本，不适用后验结构，用 `windows !== undefined` 排除。

### 4.4 runbook 更新

- §4.1：假设输出增加 action 字段要求，引用规则书
- §4.5：record_experiment 示例补 action/observations/hypothesisEvaluation
- 第 7 节排障表：补「new_factor 缺 factorSpec」报错条目

### 4.5 Loop 编排（已实现，同批交付）

把 runbook 的控制流显式化为状态机，多 Agent 角色落地为 playbook 资产：

- **`get_loop_state(runId)`**（`src/mcp-server/research-loop.ts`）：phase 完全从可观察产物推导（brief/trace/dev-walkforward-job/validation-state/variant 目录/candidate-report.md），不存额外状态，会话中断后重调即恢复。phase：`await_hypothesis → await_backtest → walkforward_running → await_summary → （达标或预算尽）→ await_validation → await_review → await_close / closed`。响应含预算、`plateau`（连续 2 条非 sota 的 dev 条目，跳过 failed）、nextVariantId、nextActions、当前阶段的角色 playbook。
- **角色 playbook**（`src/mcp-server/loop-playbook.ts`）：五角色各自固化——Researcher（只读出假设 JSON）/ Developer（只写码到 validate 为止）/ Runner（确定性 checklist，无 LLM）/ Evaluator（只读，看指标+诊断出结构化结论草稿）/ Summarizer（落盘 amend + 知识结晶）。`get_loop_state` 的 `dispatch` 字段返回注入运行时上下文（runId/variantId/SOTA 摘要/窗口指标/plateau）后可直接转发的子代理 prompt，含 expects 输出契约与 onReturn 后续动作。
- **`amend_experiment`**（research-run.ts）：trace 唯一的原地修订例外（仅限最新条目），解决 walkforward job 落盘时 lesson 是预测文本的问题——Summarizer 在回测完成后回填 observations/hypothesisEvaluation，P0c 的结构化结论由此在主流水线生效。
- plateau 是规则书转向条款的机器可读信号：`plateau=true` 时下一轮 action 不得为 tune_param。

## 5. P1 规划（新因子分层验证，未实现）

`write_factor_file` 之后、全量回测之前补三层：

1. **小样本执行**：内嵌 Python 在抽样股票×近 60 日上执行因子 `add_factor`，硬检查：无 inf、缺失率 < 阈值、索引格式（交易日期×股票代码）、非常数列。
2. **共线性去重**：复用 `resources/factor_collinearity.py`，与 run 内已用因子做截面相关，|corr| ≥ 0.99 剔除。
3. **错误归一化回喂**：每层失败把错误归一化（错误类型+关键行）存 run 目录 `factor-errors.jsonl`；下次 write_factor_file 前后由 LLM 自查「同类错误史」。

## 6. P2 规划（方向调度，未实现）

1. **plateau 检测**（纯规则，先做）：`get_run_summary` 增加 `plateau` 字段——最近 2 条 dev 条目均非 sota 时 `plateau: true`，配合规则书转向条款。
2. **bandit 调度**：trace 积累足够带 action 字段的记录后，新 MCP 工具 `propose_next_direction`：臂 = {tune_param, combine, new_factor, new_direction}，上下文 = 最近 k 次该臂实验的指标均值，奖励 = calmar 为主的多指标加权和；后验持久化到 run 目录。
3. **达标池**：SOTA 从单最优扩展为「score=1 的 variant 池」，供组合与对照。

## 7. 多 Agent 映射

MCP 工具是被动工具，「角色」靠调用方分工。落地方式：把 runbook 暗含的五角色固化为独立子代理调用，各自只拿自己需要的上下文——Researcher（trace+知识库+组件目录 → 假设 JSON）、Developer（假设 → config/因子代码）、Runner（导入+权重+回测）、Evaluator（绩效 → score）、Summarizer（结构化记录）。编排由主 agent 承担（与 RD-Agent 的 Loop 框架同构）。

## 8. 兼容性与风险

- 全部新字段可选，旧 trace/旧调用方零影响；唯一硬校验（new_factor 必附 factorSpec）只在新动作类型上生效。
- 规则书是 prompt 资产，改文案不改行为，可独立迭代。
- 风险：LLM 填 action 时不老实（把调参标成 new_direction）。缓解：P1 起可在 record 侧做轻校验（new_factor 条目对应的 variant 目录必须真有新因子文件）。
