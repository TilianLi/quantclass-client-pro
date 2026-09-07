/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

// ============================================================
// 假设规则书（hypothesis specification）
//
// 借鉴 RD-Agent 的 hypothesis_specification（scenarios/qlib/prompts.yaml）：
// 探索策略 80% 写在 prompt 规则书里而不是代码里——规则可独立迭代、
// 改文案不改行为。设计文档：docs/superpowers/plans/2026-08-26-hypothesis-direction-mechanism.md
//
// 注入点：get_strategy_template 响应的 data.hypothesisSpecification 字段
// （MCP 侧合并，不动主进程模板端点）。
// ============================================================

export const HYPOTHESIS_SPECIFICATION = `# 假设规则书（Hypothesis Specification）

## 动作类型（action，记录实验时必填其一）

| action | 含义 | 适用场景 |
|--------|------|----------|
| tune_param | 调已有组件的参数/阈值 | 建立基线、验证单旋钮敏感度 |
| combine | 已有因子/过滤组件的新组合 | 基线达标后寻找互补信号 |
| new_factor | 产生新因子（必须附 factorSpec：factorName + formulation） | 现有组件无法表达的假设 |
| new_direction | 换因子家族/股票池/框架的新研究方向 | 当前方向连续无改进（见转向规则） |

## 探索纪律

1. **先简后繁**：先用 tune_param 建立可复现基线，再尝试 combine / new_factor。
   没有基线的 new_factor 假设一律退回。
2. **转向规则**：连续 2 条 dev 条目非 sota（SOTA 无改进），下一轮 action 不得
   为 tune_param——必须 combine / new_factor / new_direction 三选一。
3. **new_factor 纪律**：
   - factorSpec.formulation 必须可计算，只使用内核可得数据（日频 OHLCV、
     成交额、财务字段）；写不清公式的假设不成立。
   - 必须陈述新因子与现有因子库**预期低相关**的理由（信息增量是什么）。
   - 因子实现走 write_factor_file（AST 白名单校验），禁止绕过工具手工放置。
4. **new_direction 纪律**：必须在 brief goal 约束内换方向（换因子家族、
   换股票池、换框架），并附 regime 判断（为什么旧方向在当前市场环境失效）。
5. **可证伪**：每个假设必须指明预期改善的指标与方向（如「2024 窗口回撤
   -21.67% → ≤-15%，年化不明显下降」），只写「提升表现」的假设退回。

## 结构化结论（记录实验时）

带绩效的后验条目（record_experiment / complete_validation）除 lesson 外
建议填两个字段（缺省会收到 warning）：

- observations：数据事实——各窗口指标、与 SOTA/上一 variant 的对比、
  get_backtest_diagnostics 的归因发现
- hypothesisEvaluation：假设判定——被支持还是证伪、原因分析

下一轮方向写在 nextHypothesis（预埋种子，下一轮可采纳/拒绝/改造）。
`
