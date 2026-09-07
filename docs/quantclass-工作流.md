# QuantClass 工作流总览

> 整理时间：2026-07-31。基于客户端实际运行状态与 MCP 工具清单整理，非纸面推测。

## 0. 当前环境快照（实时查询）

| 项目 | 状态 |
|------|------|
| 客户端在线 | ✅ isOnline = true |
| 历史数据自动更新 | ✅ 已开启（isSetAutoUpdate） |
| 分钟线数据定时任务 | ⛔ 未开启（isSetAutoMinData = false） |
| 自动交易 | ⛔ 未开启（isSetAutoTrading = false） |
| 分钟线模式 | fast，精确+模糊双通道均可用 |
| 策略工作区根目录 | `D:\QuantClassSpace\quantclass-client-pro\workspace\agent-strategies` |
| 看板自动化 | "QuantClass 研发看板 · 数据采集" 每天 9:08 运行，最近一次成功 |

---

## 1. 策略研发闭环（AI 辅助，核心工作流）

这是与 AI（Kimi Work）协作的主线，49 个 MCP 工具中的"策略开发闭环 + 研究工作流"都服务于它。

```
创建研究 run → 写策略/因子 → 校验 → 回测 → 记录实验 → 评估/对比
     ↑                                                    │
     └────────── walkforward 稳健性检验（消耗迭代预算） ←──┘
                          │
                          ▼
              样本外 validation 闸门 → 提交人工评审 → 导入策略库 → 设置权重
```

### 阶段与工具对照

| 阶段 | 工具 | 说明 |
|------|------|------|
| 立项 | `create_research_run` | 创建 run，写 brief.json：目标、阈值、回测区间、进化轮数（evolving_n），可选 walkforward 多窗口；brief 含 backtest 时自动同步回测配置到客户端（响应含 configSync） |
| 起步 | `get_strategy_template` | 拿策略模板与可用因子清单 |
| 编写 | `write_strategy_file` / `write_factor_file` / `read_strategy_file` / `list_strategies` | 文件操作限定在策略工作区内，有路径穿越校验；因子写入前做 AST 白名单静态检查 |
| 校验 | `validate_strategy` | 校验 config.py（内嵌 Python 解析） |
| 回测 | `run_backtest` / `run_backtest_async` + `get_backtest_task` | 同步/异步执行；`only_backtest_name=true` 可临时隔离单组（zeus） |
| 读结果 | `get_backtest_performance` / `get_backtest_equity_curve` / `get_backtest_result` / `get_backtest_diagnostics` | 绩效、资金曲线、选股明细、分年度归因诊断 |
| 记录 | `record_experiment` | 追加 trace.jsonl；`fromLatestBacktest` 自动抓绩效；brief 配了 walkforward 时，带绩效的 dev 条目会被拦截导向 `run_dev_walkforward` |
| 稳健性 | `run_dev_walkforward`（异步 job）+ `get_dev_walkforward_job` / `run_walkforward` | `run_dev_walkforward` 前置校验（含迭代预算预检）后立即返回 jobId，窗口循环后台执行（逐窗口切配置 → 异步回测 → 恢复配置 → 写 type=dev trace）；用 `get_dev_walkforward_job(runId)` 轮询进度与结果。失败窗口 score 计 0；消耗 1 轮迭代预算 |
| 评估 | `evaluate_backtest` / `compare_backtest_variants` / `get_run_summary` / `get_experiment_trace` | SOTA 口径统一：先比达标率 score → 同分比年化 → 再比低复杂度 |
| 样本外闸门 | `run_validation` → `complete_validation` | 切到 brief.validation 窗口异步回测，完成后恢复配置并记录 type=validation 条目；`run_validation` 支持 `variantId`（缺省取 SOTA），当前回测策略与期望不一致时报错 |
| 评审 | `submit_strategy_for_review` | 生成候选报告，等人工确认 |
| 入库 | `import_strategy` → `set_strategy_weight` / `list_library_strategies` | 导入策略库、设置资金占比（支持批量/一键隔离） |

### 关键约定

- **指标命名**：规范字段是 `calmar_ratio`（年化/最大回撤）；`sharpe_ratio` 是历史误名，仅作兼容别名。
- **迭代预算**：brief 里的 `evolving_n` 是 dev 迭代轮数的硬闸门——`record_experiment` 写入前拦截、`run_dev_walkforward` 启动前预检，预算耗尽直接报错（需 `close_run` 或提高预算），每次 walkforward 检验完成消耗 1 轮。
- **安全边界**：策略文件读写限定在 `QUANTCLASS_AGENT_WORKSPACE`（默认 `workspace/agent-strategies`，当前生效路径见上表）。

---

## 2. 数据保障线（日常运维）

| 任务 | 工具 | 当前状态 |
|------|------|----------|
| 历史数据更新 | `toggle_history_update` | ✅ 已开启 |
| 分钟线数据定时 | `toggle_min_data_schedule` / `exec_min_data` | ⛔ 未开启，可手动执行一次 |
| 系统健康检查 | `get_system_status` | 随时可查 |

典型用法：开盘前 `get_system_status` 确认在线；需要盘中数据时先 `toggle_min_data_schedule` 开启分钟线任务。

---

## 3. 实盘交易线（涉及真实资金，谨慎）

```
回测通过的库内策略 → set_strategy_weight 配好资金占比
→ toggle_auto_trading 开启自动交易
→ 盘中监控：get_buy_signals / get_sell_signals / get_stock_timing_plans
→ 账户对账：get_account_info / get_trading_info
→ 参数调整：get_trading_config / update_trading_config
```

| 工具 | 用途 |
|------|------|
| `toggle_auto_trading` | 启停自动交易（当前 ⛔ 关闭） |
| `get_buy_signals` / `get_sell_signals` | 买卖信号 |
| `get_stock_timing_plans` | 个股择时计划 |
| `get_account_info` / `get_trading_info` | 账户与 Aqua 交易信息 |
| `get_trading_config` / `update_trading_config` | 交易配置读写（field 支持 dot-key） |

---

## 4. 看板与自动化（已运行的周边设施）

**Dashboard：QuantClass 策略研发看板**

- Automation：「QuantClass 研发看板 · 数据采集」— 每天 9:08（Asia/Shanghai）定时运行，也可手动触发
- 采集内容：各策略 run 最新回测绩效 + 系统状态 + GitHub 仓库（TilianLi/quantclass-client-pro）Issue/PR/提交动态
- 供数给 3 个 Widget，Binding 均 valid：
  - 策略开发进展
  - 开发动态面板
  - 研发环境状态灯

另一个相关技能：`quantclass-strategy-fetch`（从官网下载分享会策略 → 163 邮箱取附件 → 解包导入客户端 → 生成可回测 config.py），属于"扩充策略来源"的旁路工作流。

---

## 5. 一条完整的典型日常动线

1. **开盘前**：`get_system_status` → 确认数据更新与在线状态
2. **研发时段**：在 research run 里迭代策略（写文件 → validate → backtest → record → walkforward），直到 `get_run_summary` 显示达标
3. **样本外确认**：`run_validation` + `complete_validation` 过闸门
4. **评审入库**：`submit_strategy_for_review` → 人工确认 → `import_strategy` → `set_strategy_weight`
5. **盘中（如开实盘）**：监控信号与账户
6. **每天 9:08**：看板自动刷新，盯「策略开发进展」即可掌握全局
