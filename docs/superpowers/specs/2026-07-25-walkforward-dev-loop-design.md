# Walkforward 收编 dev 闭环 — 设计文档

日期：2026-07-25
状态：已批准（用户确认六节设计后进入实现）

## 背景与目标

当前研究工作流（brief → dev 迭代 → SOTA 选择 → 单次 validation → 提交评审）中，dev 迭代全程在单一回测窗口上进行，阈值 score 本质是对该窗口过拟合。`run_walkforward` 工具虽已存在，但游离在研究闭环之外：不认识 runId、不写 trace、不做阈值评估。

本设计把 walkforward 收编进 dev 闭环：**brief 配置了 walkforward 的 run，每次 dev 实验强制执行多窗口回测，按最劣窗口口径汇总评估后写入 trace**，让 SOTA 竞争建立在跨窗口稳健性之上。

## 已确认的关键决策

| 决策点 | 结论 |
|--------|------|
| 触发频率 | 每次 dev 实验强制（brief 配置 walkforward 后） |
| 窗口定义 | brief 显式声明 `walkforward.windows` |
| 汇总口径 | 最劣窗口为准；同分 tie-break 用年化较低者；失败窗口 score 计 0 |
| 兼容性 | brief 无 walkforward 配置时完全走旧逻辑，历史 run 零影响 |
| 落地架构 | 方案 A：新增一体化工具 `run_dev_walkforward`（执行+评估+记录一条路径） |

## 1. brief schema 扩展（`src/mcp-server/research-run.ts`）

`researchBriefSchema` 新增可选字段：

```json
"walkforward": {
  "windows": [
    { "start_date": "2018-01-01", "end_date": "2020-12-31" },
    { "start_date": "2021-01-01", "end_date": "2022-12-31" },
    { "start_date": "2023-01-01", "end_date": null }
  ]
}
```

- 窗口字段为现有 `backtestWindowSchema` 的子集：`start_date` 必填、`end_date` 可空（null=至今）、`initial_cash` 可选；板块过滤沿用当前回测配置，不进窗口定义（与现有 `run_walkforward` 一致）。
- 校验：至少 **2 个**窗口；日期可解析且 `start_date < end_date`（end 非空时）。用 zod `superRefine` 实现。

## 2. trace 条目扩展（`src/mcp-server/research-run.ts`）

`experimentEntrySchema` 新增两个可选字段：

- `windows`：分窗口明细数组，每项 `{window, ok, error?, metrics?, evaluation?}`，`evaluation` 为该窗口单算的 `{passed, score}`。
- `worstWindow`：`{start_date, end_date}`，标识驱动汇总结论的最劣窗口。

条目顶层 `metrics` / `evaluation` 存**最劣窗口**的结果：

- `evaluation.score = min(各窗口 score)`，失败（未跑出绩效）的窗口按 score=0 参与取 min；
- `metrics` = 最劣窗口的完整指标（最劣窗口为失败窗口时缺省）；
- `evaluation.passed = (min score === 1)`，与 `evaluateBacktest` 的 allPassed 语义一致。

SOTA 竞争（`isBetterVariant`：score→年化→复杂度）与 `get_run_summary` 的 trends **零改动**——它们消费顶层字段，自动获得最劣窗口口径。

## 3. 新工具 `run_dev_walkforward`

- 纯汇总逻辑抽到新模块 `src/mcp-server/walkforward-eval.ts`（纯函数，可单测）；工具注册在 `src/mcp-server/tools.ts`。
- 参数：`runId`、`variantId`、`hypothesis`、`changes?`、`lesson?`。**窗口只从 brief 读，不接受参数覆盖**——这是强制性的关键。

执行流程：

1. 读 brief；run 不存在 → 报错；brief 无 `walkforward` → 报错并提示走 `record_experiment` 旧路径。
2. **快照当前回测配置**（GET `/mcp/backtest/config`），流程结束后在 finally 语义下恢复（复用 `validation-gate.ts` 的 `priorConfigToRestoreBody`）。现有 `run_walkforward` 不恢复配置是个坑，新工具修掉。
3. 逐窗口串行：PUT config → POST `/mcp/backtest/run`（超时沿用 1_800_000ms）→ GET performance → 用 `evaluateBacktest` 对 `brief.thresholds` 做单窗口评估。回测成功但无绩效数据按窗口失败处理。
4. 汇总：按「score 升序 → 年化升序」选最劣窗口；任何窗口失败 → 该窗口 score 计 0（部分失败 = 整体 score 0，保守原则）；**全部失败 → 不写 trace，直接返回错误**。
5. 调 `recordExperiment` 写一条 `type: "dev"` 记录（含 windows 明细 + 最劣窗口顶层指标 + kernelVersion），verdict 自动判定照常，消耗 **1 轮** `evolving_n` 预算。
6. 响应：分窗口结果 + 最劣窗口 + 汇总 score/passed + trace 条目 + budget。

同步执行（与 `run_walkforward` 现状一致），不做异步化；调用方等待 N×数分钟，超时由调用侧控制。

## 4. `record_experiment` 的强制拦截

强制性落在这里：brief 含 `walkforward` 时，若 dev 条目**带 metrics 或 evaluation 但没有 windows 字段** → 拒绝写入，报错提示改用 `run_dev_walkforward`。

例外放行：无 metrics 且无 evaluation 的条目（verdict=failed，用于记录「回测都没跑起来」的失败实验）——失败记录不该被逼着跑完整 walkforward。

## 5. 不动的部分

validation 闸门、`submit_strategy_for_review`、`evaluate_backtest`、`compare_backtest_variants`、SOTA 语义、预算计数逻辑全部不变。`run_walkforward` 保留为通用工具（不加 run 语义）。

## 6. 测试与文档

- 新增 `tests/mcp-server/walkforward-eval.test.ts`：最劣窗口选择（score 平级比年化、失败窗口计 0、全失败）、汇总 passed 语义。
- 扩展 `tests/mcp-server/research-run.test.ts`：brief walkforward 校验（窗口数 <2、start≥end、非法日期）、record 强制拦截、failed 例外放行、带 windows 的正常记录。
- `scripts/verify-mcp-tool-registration.mjs` 的 `REQUIRED_TOOLS` 增加 `run_dev_walkforward`。
- `AGENTS.md`：工具数 41→42，研究工作流分组增加新工具与 dev 闭环说明，测试文件清单同步。

## 错误处理一览

| 场景 | 行为 |
|------|------|
| run 不存在 / 无 brief | 报错，不动配置 |
| brief 无 walkforward | 报错并提示旧路径，不动配置 |
| 单窗口回测失败 | 该窗口记 `ok:false + error`，score 计 0，继续下一窗口 |
| 全部窗口失败 | 不写 trace，返回错误；配置已恢复 |
| 流程中途异常 | finally 恢复原回测配置（恢复失败静默，不掩盖主错误） |
| record 时 brief 有 walkforward 但条目无 windows（且带绩效） | 拒绝写入并提示 |
