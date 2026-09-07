# Research Agent Runbook — QuantClass 研究工作流编排手册

> 给 AI 客户端（Kimi Code / Claude Desktop 等）的 SOP：通过 QuantClass MCP 工具执行 RDAgent 风格的「假设 → 实现 → 回测 → 评估 → 进化」循环。
> 使用方式：把本文作为任务指令交给已连接 QuantClass MCP 的 AI，并给出研究目标（runId、阈值、回测区间）。AI 严格按本手册执行。
> 配套设计：`docs/superpowers/specs/2026-07-20-quantclass-rdagent-workflow-design.md`

## 0. 前置条件

- QuantClass 客户端已启动，MCP 已连接（49 个工具可用）。
- 股票数据已下载、非交易时段（回测期间不能跑实盘）。
- `run_backtest` 是长耗时阻塞调用（几分钟到几十分钟），确保 MCP 客户端超时设置足够；`run_dev_walkforward` 为异步 job（立即返回 jobId，用 `get_dev_walkforward_job` 轮询），不受 MCP 超时影响。
- 建议先 `get_system_status` 做一次预检。

## 1. 响应与错误约定

- HTTP 类工具（回测/实盘/模板）返回 JSON 文本：`code: 0` 表示成功，`data` 为载荷；`code` 非 0 或 MCP 层返回 `...失败: ...` 文本表示失败。
- 本地类工具（工作区/trace/校验/评估）成功返回 JSON 文本；失败返回带 `isError` 的错误文本。
- 每次调用后先判断成功与否再继续；失败按第 7 节处理，不要盲目重试。

## 2. 角色与工具分工

| 角色 | 职责 | 工具 |
|------|------|------|
| Researcher | 读 brief + trace，提出一个可证伪假设 | `get_experiment_trace`、`get_run_summary`、`get_strategy_template`、`get_knowledge`、`list_factor_components` |
| Developer | 把假设实现为策略文件并校验通过 | `get_strategy_workspace_root`、`write_strategy_file`、`read_strategy_file`、`list_strategies`、`validate_strategy` |
| Runner | 导入策略、权重隔离、执行回测 | `import_strategy`、`set_strategy_weight`、`list_library_strategies`、`set_backtest_config`、`run_backtest`（长回测可换 `run_backtest_async` + `get_backtest_task`） |
| Evaluator | 解析绩效、按阈值评估、判定 SOTA | `get_backtest_performance`、`evaluate_backtest`、`get_run_summary`、`compare_backtest_variants` |
| Summarizer | 写 trace、产出 lesson、提交审阅 | `record_experiment`、`record_knowledge`、`close_run`、`submit_strategy_for_review` |

## 3. 阶段 0：初始化 run

1. 调 `create_research_run`，参数：
   - `runId`：用户给定或自拟（如 `run-momentum-001`；不得以 `_v数字` 结尾）
   - `brief`：`{ goal, universe?, thresholds, backtest?, validation?, constraints?, evolving_n? }`
     - `thresholds` 的 key 只能从这 5 个里选：`annual_return_pct`、`max_drawdown_pct`、`sharpe_ratio`、`win_rate_pct`、`profit_loss_ratio`（至少给 1 个）
     - `backtest` 字段对应 `set_backtest_config` 白名单：`initial_cash`(number)、`start_date`("YYYY-MM-DD")、`end_date`("YYYY-MM-DD" 或 null)、`filter_kcb`/`filter_cyb`/`filter_bj`("0"/"1" 字符串)
     - **`validation`（样本外窗口，结构同 backtest，强烈建议提供）**：防过拟合的核心纪律——**进化循环只能使用 `backtest` 窗口，`validation` 窗口在循环期间禁止用于任何回测**，仅在第 5 节收尾时用于一次 SOTA 复核。例如 backtest=2023-01-01→2024-12-31、validation=2025-01-01→今
     - `evolving_n`：最大进化轮数，缺省按 5 执行
2. 若返回「run 已存在」错误：**这是恢复信号，不是失败**。改调 `get_experiment_trace(runId)` + `get_run_summary(runId)`，从 trace 中最大 variantId 序号 +1 继续（trace 为空则从 v1 开始）。不要试图删除或重建 run。
3. 初始化后回测配置已由 `create_research_run` 按 `brief.backtest` 自动同步（响应含 `configSync`）。若响应中 `configSync.applied=false`（客户端不可达）或需临时校正，再手动按 `brief.backtest` 调一次 `set_backtest_config`（只传 brief 里有的字段）作为可选校正。

## 4. 主循环（每轮一个 variant）

每轮严格按 6 步执行，**一轮只验证一个假设**（保证 trace 可归因）。回测串行，不并发。

### 4.0 Loop 编排（多 Agent 驱动模式）

每轮迭代以 `get_loop_state(runId)` 为入口——它是纯状态机：从可观察产物（brief/trace/dev-walkforward-job/validation-state/variant 目录/评审报告）推导当前 phase，返回预算、`plateau`（连续 2 轮非 SOTA，触发假设规则书转向条款）、`nextVariantId`、下一步动作清单、当前阶段角色 playbook，以及 **`dispatch`：注入运行时上下文后可直接转发的子代理分派指令**（`role`/`prompt`/`expects`/`onReturn`——编排器把 `prompt` 原样发给子代理，按 `expects` 验收输出，按 `onReturn` 接续）。phase 语义：

| phase | 含义 | 该做什么 |
|-------|------|----------|
| `await_hypothesis` | 待提假设 | dispatch **Researcher** 子代理（只读工具），产出假设 JSON |
| `await_backtest` | 有 variant 目录但无 trace 记录 | dispatch **Developer** 子代理（写文件→validate，不碰导入/回测）；其返回后由编排器按 nextActions 执行 **Runner** 确定性步骤（导入→权重隔离→触发回测） |
| `walkforward_running` | walkforward job 进行中 | `get_dev_walkforward_job` 轮询 |
| `await_summary` | 回测完成待回填结论 | dispatch **Evaluator** 子代理（只读，看指标+诊断出结构化结论）→ 把输出转 **Summarizer** 子代理（`amend_experiment` 落盘 + `record_knowledge` 结晶） |
| `await_validation` / `await_review` / `await_close` | 收尾各闸门 | 按 nextActions 直接调工具（无 LLM 角色） |
| `validation_running` / `closed` | 闸门锁/已关闭 | 轮询或停手 |

状态机不存任何额外状态，会话中断后重调 `get_loop_state` 即可恢复现场。每轮只验证一个假设、回测串行的纪律不变。五份角色资产（含无 LLM 的 Runner checklist）固定在 `src/mcp-server/loop-playbook.ts`。

### 4.1 Researcher：提出假设

1. 按固定顺序收集上下文（不得跳步）：
   a) `get_knowledge()`——跨 run 知识库全量（有可疑旋钮时追加 `get_knowledge(knobFilter)` 精查）
   b) `get_run_summary(runId)`——当前 SOTA 与阈值差距
   c) `get_experiment_trace(runId, tail=5)`——近期假设与 lesson；重点看上一轮的 `nextHypothesis`（可采纳、拒绝或改造）
   d) `get_strategy_template`（首次或需要格式细节时）+ `list_factor_components`（假设涉及新因子/过滤组件时必查，确认组件真实存在）
2. 假设自批判三问（critic 步骤，内部完成不另外调工具）：
   - 与 trace 历史假设是否语义重复？（重复则放弃或改造）
   - 是否有知识条目或历史实验证据支撑？（把引用写进 `hypothesisSource`）
   - 是否可证伪？（必须指明预期改善的指标与方向）
3. 首次或需要格式细节时调 `get_strategy_template`，返回 `data` 含：
   - `configPyFormat.requiredVariables`：`strategy_list` 的字段说明（name、cap_weight、hold_period、select_num、offset_list、rebalance_time、factor_list、filter_list、timing、buy_time、sell_time、split_order_amount 等）与 `backtest_name`
   - `timingExamples.availableSignals`：real_trading 现有可用择时信号清单
   - `directoryStructure`：策略库/因子库/信号库/外部数据/截面因子库 目录约定
4. 输出本轮提案（内部记录，不写文件）：
   - `variantId`：`v{n}`（顺序递增，failed 的也占号）
   - `action`：假设动作类型四选一——`tune_param`（调参/阈值）、`combine`（已有组件新组合）、`new_factor`（产生新因子，须备 factorSpec）、`new_direction`（换因子家族/股票池/框架）。**取值规则见 `get_strategy_template` 响应里的 `hypothesisSpecification`（假设规则书）**：先简后繁；连续 2 轮 SOTA 无改进则下一轮不得再用 tune_param；new_factor 必须给出可计算 formulation 并陈述与现有因子的预期低相关理由
   - `hypothesis`：一句话可证伪假设（机制 + 预期改善的指标方向）
   - `changes`：相对上一 variant 的具体改动（因子/参数/过滤条件）
   - 约束：**不得与 trace 中已试过的假设重复**；优先回应上一轮 `lesson`；只使用 template 中确认存在的因子与信号（因子存在性由 `validate_strategy` 强制检查）

### 4.2 Developer：实现与校验

1. 需要绝对路径时先调 `get_strategy_workspace_root`。
2. 用 `write_strategy_file` 写 `config.py` 到 `{runId}/{variantId}/`。`config.py` 必须满足：
   - 含顶层变量 `backtest_name` 与 `strategy_list`（AST 提取，建议写成字面量）
   - **`backtest_name = "{runId}_{variantId}"`**（如 `run-momentum-001_v1`）。该命名使 isolate 机制（正则 `^(.*_v)\d+$` 提取分组前缀 `{runId}_v`）得以生效
   - **`strategy_list` 中每个策略的 `name` 也设为 `"{runId}_{variantId}"`**。关键原因：默认选股库（select）下，isolate 删除旧 variant 时比对的是 store 中已有策略条目的 `name` 字段，而该字段来自 `strategy_list[*].name`，不是 `backtest_name`——若策略名不带 `{runId}_v` 前缀，旧 variant 的策略会逐轮累积，污染后续回测。多策略时可加后缀区分（如 `{runId}_{variantId}_a`），只要保持 `{runId}_v` 前缀即可被 isolate 命中
3. 调 `validate_strategy(configFilePath=<工作区绝对路径>/{runId}/{variantId}/config.py)`，返回 `{ valid, errors, extracted? }`。
4. 校验失败：读 `errors` 逐条修复（常见问题：缺必填变量、Python 语法错误、`因子文件不存在`、`择时信号文件不存在`），重写文件后重新校验。**单 variant 最多修正 3 次**；仍失败 → 跳到 4.5 记 `failed`，进入下一轮。
5. **自定义因子（受限开放，走闸门流程）**：假设需要新因子时：
   - 用 `write_factor_file(runId, variantId, category, factorName, content)` 写入——**写入前强制静态检查**：仅允许 pandas/numpy/math 等纯计算库 import + `fin_cols`/`add_factor` 接口契约；禁止 os/sys/subprocess/网络/IO/exec/eval/dunder 访问，不通过则拒绝写入；自动补齐 `__init__.py`
   - 时序因子契约：模块级 `fin_cols = []` + `def add_factor(df, param=None, **kwargs)`，函数内用 `kwargs['col_name']` 设列并 `return df[[col_name]]`；因子基于**后复权**数据计算（成交用原始价，双轨制）
   - 截面因子（`kind="cross_factor"`）：写入 `截面因子库/`（category 可选），契约额外要求模块级 `ov_cols = []`，并通过 `kwargs['section_factor']` 读取输入因子列（`section_factor.factor_list[i].col_name`），返回 `df[["交易日期", "股票代码", col_name]]`；放宽 `core`（内核库）与 `scipy` 导入。config 中经策略的 `cross_sections` 字段引用（见 config 手册 §8）
   - `validate_strategy` 对 variant 因子库做同一套检查（绕过工具手工放置的因子同样会被拦截）
   - 静态闸门之外，**内核回测是最终功能闸门**（产物校验会捕捉因子运行时错误）；失败按 4.3/第 7 节处理
   - 仍未开放：`信号库` 与个股择时（1H/1D 对齐反馈差）、直接写 real_trading（永远只写 variant 本地）

### 4.3 Runner：导入、权重隔离与回测

1. 调 `import_strategy`：
   - `configFilePath` = `<工作区绝对路径>/{runId}/{variantId}/config.py`
   - **不传 `capWeight`**（默认重置为 0，安全）；`isolate` 用默认值 true
2. **权重隔离（pos 模式必须）**：pos 模式的回测范围是「全部 weight>0 策略的融合组合」，不是刚导入的 variant。必须隔离：
   - 启用当前 variant：`set_strategy_weight(name="{runId}_{variantId}", weight=1)`
   - 一键停用其余组：`set_strategy_weight(others_except=["{runId}_{variantId}"], weight=0)`
   - 需要查看库内状态时调 `list_library_strategies`（仅名称与权重）
   - 三层同步（config.json、localStorage、real_market_25.json），zeus 下次启动即生效，无需重启客户端
3. 调 `run_backtest`（空参数），阻塞等待完成。该工具会校验本次回测产物（策略评价.csv 缺失或非本次生成 → 返回失败并提示内核日志位置）。用 `run_backtest_async` 时产物校验在 `get_backtest_task` 侧完成：`status=success` 但未产出本次结果会降级为 `status=error` 并附 `artifactError`。
4. 回测失败（`code` 非 0 或错误文本）：跳到 4.5 记 `failed`（附错误摘要）。**连续 2 次回测失败则终止整个 run**：先 `get_system_status` 检查数据/内核状态，把诊断写入总结，按第 6 节收尾（不提交审阅）。

### 4.4 Evaluator：解析绩效与评估

1. 调 `get_backtest_performance`（若返回「策略评价文件不存在」错误，按回测失败处理，见第 7 节）。成功时**直接取 `data.parsed`**——它是 5 项工作流标准指标的数值形式（`annual_return_pct`、`max_drawdown_pct`、`sharpe_ratio`、`win_rate_pct`、`profit_loss_ratio`），可直接作为 `evaluate_backtest` 的 metrics 与 `record_experiment` 的 metrics 使用，**不要手工解析字符串**。原始中文字符串仍在 `data.metrics` 中（`累积净值` 等 18 项），仅供撰写 lesson 时参考。`parsed` 的键缺失（如某项无法解析）时不要编造。**口径注意：`sharpe_ratio` 实为「年化收益/回撤比」（Calmar 类口径），策略评价 18 项中并无真夏普率**——阈值设定与报告解读都按此口径，字段改名留待后续版本。
2. 调 `evaluate_backtest`：`performances: [{ variantId, ...上一步的指标 }]`，`thresholds: brief.thresholds`。返回 `{ passed, bestVariantId, score, details }`——`score` 是达标项比例（0-1），`passed` 为全部达标。
3. 判定 SOTA：与 4.1 获取的 `get_run_summary(runId).sota` 比较——先比 `score`，同分比 `annual_return_pct`。本轮更优则本轮为新 SOTA（`verdict = "sota"`），否则 `verdict = "completed"`。

### 4.5 Summarizer：记录实验

调 `record_experiment(runId, entry, fromLatestBacktest=true)`：自动把最近一次回测的绩效数值填入 `metrics`、内核版本填入 `kernelVersion`（均仅在缺省时生效），AI 只需提供核心字段：

```json
{
  "variantId": "v1",
  "hypothesis": "20日动量叠加换手率过滤可提升年化并降低回撤",
  "action": "combine",
  "changes": "factor_list 改为 mom_20；filter_list 加 turnover_rank < 0.3",
  "files": ["config.py"],
  "evaluation": { "passed": false, "score": 0.33 },
  "verdict": "completed",
  "lesson": "动量窗口过短导致换手过高、回撤超标；下一轮拉长窗口并加波动率过滤",
  "observations": "年化 12.1%（阈值 15%）、回撤 -28.4%（阈值 25%）；较 SOTA v0 年化 +1.3pp 但回撤恶化 4pp",
  "hypothesisEvaluation": "部分支持：换手率过滤有效降低了回撤但未达标，动量窗口过短是主要拖累"
}
```

- `action`：假设动作类型（`tune_param`/`combine`/`new_factor`/`new_direction`），规则见假设规则书；`new_factor` 必须同时传 `factorSpec: { factorName, formulation, variables? }`，缺失会被工具直接拒绝。
- `observations` / `hypothesisEvaluation`：结构化结论（数据事实、假设判定）。带 `evaluation` 的后验条目（含 complete_validation 写入的 validation 条目）缺省会收到 warning（不阻断）；`run_dev_walkforward` 写入的条目不适用（其 lesson 为启动前预测文本）。
- `verdict`：`completed`（正常完成未刷新 SOTA）/ `sota`（刷新历史最优）/ `failed`（校验或回测失败）。
- `failed` 时 `metrics`/`evaluation` 可缺省（fromLatestBacktest 可不传），但 `lesson` 必须写明失败原因摘要。
- `complexity`（旋钮计数）：填 `factor_list` + `filter_list` + `filter_list_post` + `cross_sections` 的条目总数。SOTA 同分时**复杂度低者优先**（防过拟合的正则项），都不填才退回比年化。
- **`lesson` 必填且要具体**：哪个指标未达、差距多少、下一步假设方向。它是进化循环的核心载体。占位文本（「待回填」「TBD」等）会被工具直接拒绝（见下条）。
- `basedOn`：本轮 config 不是从上一 variant 演进、而是分叉自更早 variant 时必填（如 v5 基于 v3 而非 v4），保持 trace 可归因。
- `hypothesisSource`：假设来源引用——`knowledge:<id>`（来自知识库）/ `trace:<runId>/<variantId>`（来自历史实验）/ `none`（全新探索，需更强理由）。
- `nextHypothesis`：预埋给下一轮的假设种子（对应 RD-Agent 反馈阶段的 new_hypothesis），写清建议验证什么、为什么。
- lesson 占位文本（「待回填」「TBD」等）会被工具拒绝；假设与历史高度相似时工具返回 warnings，需在 lesson 中说明与相似实验的差异。

**brief 配置 walkforward 时（多窗口 dev 闭环）**：带绩效的 dev 实验不能直接用 `record_experiment` 写入（会被拦截），改走 `run_dev_walkforward` 异步 job：

1. 调 `run_dev_walkforward(runId, variantId, hypothesis, action?, factorSpec?, changes?, lesson?)`：前置校验（walkforward 配置、迭代预算预检、无进行中 job）后立即返回 `{ jobId, status:"running", totalWindows }`，**不再阻塞等待**。action/factorSpec 语义与 record_experiment 一致，落盘时透传进 trace 条目。
2. 用 `get_dev_walkforward_job(runId)` 轮询：job 文件实时记录当前窗口序号与各窗口 status/metrics/evaluation；`status="success"` 表示全部窗口完成且 trace 已写入，`status="error"` 见 job 的 `error` 字段（全部窗口失败时不写 trace）。
3. **确认 trace**：`status="success"` 后调 `get_experiment_trace(runId, tail=1)` 确认 type=dev 条目已落盘（含分窗口明细 windows 与最劣窗口 worstWindow），job 的 `traceEntry`/`budget` 字段可直接核对。
4. 预算耗尽的报错（「迭代预算已用完」）在启动前预检即抛出，不会白跑回测。
5. **回填结构化结论**：job 落盘的 trace 条目里 lesson 是启动前的预测文本；回测完成后按 `get_loop_state` 的 `await_summary` 提示，用 `amend_experiment(runId, variantId, { observations, hypothesisEvaluation, lesson?, nextHypothesis? })` 回填后验结论（只能修订最新条目）。

### 4.6 循环退出

- `evaluation.passed === true`（全部阈值达标）→ 提前退出循环。
- 达到 `evolving_n` 轮 → 退出循环（预算为硬闸门：耗尽后 `record_experiment` / `run_dev_walkforward` 直接报错）。
- 连续 2 次回测失败 → 终止（见 4.3）。
- **循环退出后必须 `close_run`**：达标→`achieved`（要求存在 SOTA）；放弃→`abandoned`；暂停→`paused`，均附一句话原因。对已关闭的 run 再次关闭会被拒绝（幂等保护），确需改判时显式传 `force=true`，响应回显被覆盖的 `previousStatus`/`previousCloseReason`。放弃或暂停时，把本轮最重要的负面发现（哪个旋钮无效/恶化）写入 `record_knowledge`——负面知识与正面知识同等宝贵，防止后续 run 重复踩坑。

## 5. 收尾：样本外复核、恢复 SOTA 与提交人工审阅

1. 调 `get_run_summary(runId)` 取最终 SOTA。若全程没有任何 completed/sota 记录（全部 failed）：**不提交审阅**，输出失败总结（各轮失败原因 + `get_system_status` 诊断）后结束。
2. **样本外复核（brief 含 validation 时必做）**：
   - 推荐走闸门工具：`run_validation(runId, variantId?)` —— `variantId` 缺省取当前 SOTA；工具会先校验当前回测策略（backtestName）与期望 variant 一致，不一致直接报错（需先 `import_strategy(<SOTA config.py 绝对路径>)` 并设置权重），防止样本外验证静默跑在旧策略上。成功返回 taskId 后由它自动切窗/快照，回测完成后调 `complete_validation(runId, variantId)` 恢复原配置并记录 type=validation 条目
   - 手动方式（等价）：调 `set_backtest_config` 切到 `brief.validation` 窗口（只传 brief 里有的字段），**恢复库内状态到 SOTA**（`import_strategy` → `set_strategy_weight(name=SOTA名, weight=1)` + `others_except=[SOTA名], weight=0`），然后 `run_backtest` 一次，取 `data.parsed`
   - 用同一 `brief.thresholds` 调 `evaluate_backtest` 得到 OOS 的 `passed/score/details`
   - 按余量规则写 `oosNote`（文字判断）：
     ① OOS 各阈值项是否仍达标；② OOS 年化 ≥ 样本内年化的 50% 为可接受，低于为退化；
     ③ OOS 回撤绝对值 ≤ 样本内的 1.5 倍为可接受；④ 与 IS 结果显著背离时必须在 oosNote 中说明可能原因
   - 复核完成后把 `set_backtest_config` 切回 `brief.backtest` 窗口（若后续还要继续进化）
   - **可选加深**：用 `run_walkforward(windows=[多个窗口])` 对 SOTA 做多窗口稳健性检查（返回各窗口绩效与最劣年化/年化中位/最差回撤汇总）
3. 用 SOTA variant 的**样本内** metrics 再调一次 `evaluate_backtest`（同 brief.thresholds），拿带 `details` 的 IS evaluation。可选交叉验证：`compare_backtest_variants(runId, variantIds=[全部已完成 variant], thresholds)` 确认 SOTA 一致。
4. 调 `submit_strategy_for_review`：
   - `runId`、`variantId` = SOTA variant
   - `evaluation` = 上一步的样本内 `{ passed, score, details }`
   - `strategyPath` = `{runId}/{variantId}/config.py`
   - `summary` = 假设演进摘要（每轮一句话）+ SOTA 指标 + 是否全部达标
   - `oosWindow`/`oosEvaluation`/`oosNote` = 第 2 步的样本外结果（有 validation 窗口时必传，报告将并排展示样本内/样本外对照）
5. 生成 `candidate-report.md` 后**停止动作**，向用户汇报：SOTA variant、样本内/样本外各指标 vs 阈值、trace 轮数、报告路径，并明确提示——**确认后才可人工导入实盘**。

## 6. 红线（必须遵守）

- 导入时**不传 `capWeight`**（保持 0）；权重调整只允许经 `set_strategy_weight` 做回测隔离；**不调用** `toggle_auto_trading`、`exec_min_data`、`update_trading_config`、`toggle_min_data_schedule`、`toggle_history_update` 及任何实盘类工具。
- 启用实盘永远由用户在审阅 `candidate-report.md` 后人工执行。
- 一轮只验证一个假设；回测串行；不跳过 `record_experiment`。
- 不绕过「run 已存在」报错；不删除工作区任何文件。
- 不向 `validate_strategy` / `import_strategy` 传工作区外的路径。

## 7. 失败处理表

| 场景 | 处理 |
|------|------|
| `create_research_run` 报「已存在」 | 恢复模式：读 trace + summary 继续（见 3.2） |
| `validate_strategy` 失败 | 按 errors 修复重写，单 variant ≤3 次；超限记 `failed` 进下一轮 |
| `run_backtest` 失败 | 记 `failed`；连续 2 次终止 run 并附 `get_system_status` 诊断 |
| `get_backtest_performance` 文件不存在 | 返回错误（「策略评价文件不存在，请先执行回测」）——按回测失败处理 |
| 指标键缺失（如无 `胜率（含0/去0）`） | 该指标不传，不编造 |
| `record_experiment` 校验失败 | 检查 entry 字段（verdict 枚举、score 0-1、variantId/hypothesis 非空）后重写 |
| `action="new_factor"` 被拒绝 | 缺 `factorSpec`：补 `factorName` + `formulation`（可计算的公式定义）后重写 |
| 「迭代预算已用完」报错 | `close_run` 收尾，或修改 brief.json 提高 `evolving_n` 后继续 |
| `run_dev_walkforward` 返回 jobId 后久未完成 | `get_dev_walkforward_job(runId)` 查进度；`status=error` 时按 `error` 字段处理（全部窗口失败不写 trace） |
| `close_run` 报「已关闭」 | 属幂等保护；确需改判传 `force=true` |
| `amend_experiment` 报「只能修订最近一次」 | 只能改 trace 最新条目；历史条目不修，改进写入下一轮 nextHypothesis |
| `run_validation` 报策略不一致 | 先 `import_strategy(<SOTA config.py 绝对路径>)` 并 `set_strategy_weight` 设权重，再重试 |
| 阈值全未达标且轮次耗尽 | 正常收尾：提交「当前最优」审阅（报告自带未达标标注），由人决定 |

## 8. 单轮调用序列示例（v2，假设 v1 已完成）

```
get_knowledge()                               # 跨 run 知识库（提假设前必查）
get_experiment_trace(runId, tail=5)          # 了解历史（含上轮 nextHypothesis）
get_run_summary(runId)                        # 当前 SOTA
list_factor_components()                      # 假设涉及新组件时确认存在性
write_strategy_file(runId, "v2", "config.py", <含 backtest_name="{runId}_v2">)
validate_strategy(configFilePath=.../runId/v2/config.py)   # valid=true
import_strategy(configFilePath=.../runId/v2/config.py)     # 不传 capWeight
set_strategy_weight(name="{runId}_v2", weight=1)            # 启用当前 variant
set_strategy_weight(others_except=["{runId}_v2"], weight=0) # 一键停用其余组
run_backtest()                                # 阻塞等待（带产物校验；长回测可用 run_backtest_async + get_backtest_task）
get_backtest_performance()                    # 取 data.parsed（5 项数值指标）
evaluate_backtest(performances=[{variantId:"v2", ...data.parsed}], thresholds=brief.thresholds)
record_experiment(runId, {variantId:"v2", hypothesis, changes, files:["config.py"],
                          evaluation:{passed, score}, verdict, lesson},
                  fromLatestBacktest=true)    # 自动抓 metrics 与 kernelVersion
```
