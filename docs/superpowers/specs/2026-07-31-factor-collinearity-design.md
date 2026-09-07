# 因子共线性 / 真实复杂度度量 · 设计文档

> 日期：2026-07-31。方案：A（MCP server 侧纯本地工具 + 内嵌 Python 脚本）。
> 决策记录（与用户的澄清结论）：
> - 度量深度：**只做值级**（因子值相关矩阵 / VIF / 有效复杂度），不做 AST 结构级分析。
> - 生效方式：**报告 + 软警告**，不拦截任何现有流程。
> - 复杂度口径：**双口径并存**——保留现有条目数 `complexity`，新增 `effective_complexity`。
> - 计算范围：**调仓日截面抽样**（按 config 回测区间取调仓日截面，全市场过滤后股票池）。

## 1. 背景与问题

当前研究工作流的复杂度口径是 `countConfigKnobs`（`src/mcp-server/research-run.ts:313-358`）：
对 config.py 文本做启发式计数（`factor_list`/`filter_list`/`filter_list_post`/`cross_sections` 条目数）。
已知缺陷：

- `cross_sections` 条目是 dict，depth-2 方括号扫描恒计 0；
- 同因子不同参数（`动量20` vs `动量60`）按 2 计，但它们值上可能几乎共线；
- 名字不同、走势雷同的因子（如动量类 vs 反转类）完全无法识别。

结果：SOTA tie-break 用的"复杂度"不反映真实自由度，防过拟合没有牙齿。
全库 grep 确认当前无任何相关性/共线性代码，这是绿地功能。

## 2. 目标与非目标

**目标**

- 新增 MCP 工具 `analyze_factor_collinearity`：对指定 run/variant 输出值级共线性报告
  （稳健相关矩阵、高相关对、VIF、有效复杂度）。
- `record_experiment` 可选自动附带共线性摘要进 trace（软警告，不拦截）。
- `get_run_summary` 展示最近一次 `effective_complexity`。

**非目标（v1 明确不做）**

- 不改 SOTA 选择语义（`effective_complexity` 只进 trace 供参考，不参与排序）。
- 不做结构级/AST 共线性分析。
- 不分析截面因子（cross_sections 产出因子）本身的值——它依赖内核运行时环境
  （`CrossSectionConfig`），v1 只分析其时序输入因子，产出因子在报告中标注 `skipped`。
- 不做因子值磁盘缓存、不做增量计算（跑通实测后再议）。
- 不拦截 `record_experiment` / `submit_strategy_for_review`。

## 3. 架构

```
AI Agent ──MCP──> analyze_factor_collinearity (tools.ts 注册)
                        │
                        ▼
              factor-collinearity.ts (新文件, src/mcp-server/)
                        │  execFile(内嵌 Python, resources/python/<arch>)
                        ▼
              resources/factor_collinearity.py (新脚本)
                        │  读 config.py (复用 parse_config.py 逻辑)
                        │  读行情 CSV (stock-trading-data-pro/)
                        │  import variant 因子模块, 调 add_factor
                        ▼
                   JSON 报告 → TS → MCP 响应

record_experiment (research-run.ts)
   └─ 可选 withCollinearity=true 时内部调用同一 TS 函数, 摘要写进 trace entry
```

**为什么不动主进程**：数据路径经 `ALL_DATA_PATH` 环境变量可得（MCP server 已有先例），
纯本地文件操作 + Python 子进程，与 `factor-check.ts`（`src/mcp-server/factor-check.ts:38-66`）
模式同构；主进程零改动，不需要重新发布客户端。

## 4. 组件设计

### 4.1 `resources/factor_collinearity.py`（核心，新文件）

输入（JSON，经 stdin 或临时文件传入，仿 check_factor.py 模式）：

```json
{
  "config_path": "<variant>/config.py",
  "factor_dirs": ["<variant>/因子库"],
  "data_dir": "D:/QuantClassSpace/QuantData",
  "start_date": "2023-01-01",
  "end_date": "2025-12-31",
  "filters": {"kcb": "1", "cyb": "0", "bj": "1"},
  "max_sections": 60
}
```

处理流程：

1. **解析 config**：复用 `resources/parse_config.py` 的解析能力（import 或子进程），
   从 `strategy_list` 收集所有被引用的时序因子：`{name, param}` 去重集合，
   记录各 strategy 的 `hold_period`（如 `"3D"`/`"2W"`）、`offset_list`、
   `filter_kcb/cyb/bj`、回测区间。
2. **调仓日序列**：按 `hold_period` 把回测区间切为调仓日；多个 strategy 取各自调仓日并集；
   总数超 `max_sections` 时等距抽样。复权/换仓时点语义（`rebalance_time`）
   不影响因子值本身（因子按截至选股日的数据计算），统一按"调仓日收盘后可见数据"计算。
3. **股票池**：`data_dir/stock-trading-data-pro/`（不存在则 fallback `stock-trading-data/`）
   下全部 CSV，按板块前缀（sh/sz/bj）与 filters 过滤；剔除调仓日停牌/无数据个股。
4. **逐截面计算因子矩阵**：
   - 每只股票读 CSV（**GBK 编码**，列为 `交易日期/开盘价/.../收盘价/前收盘价/成交额/流通市值/换手率...`），
     截取调仓日之前 `max(param 回看) + buffer(20%)` 的窗口；
   - **后复权还原**：因子计算约定用后复权数据（手册 §8），用 `收盘价/前收盘价`
     链式累乘得复权因子，对价量列还原（与内核口径近似，见 §6 限制）；
   - **内置因子映射表**：`收盘价→收盘价(后复权)`、`换手率→换手率`、`流通市值→流通市值`、
     `成交额→成交额` 等列映射；未识别的内置因子（官方称"不可枚举，以 validate 通过为准"）
     标记 `unresolved` 并从矩阵剔除、在报告中列出；
   - 自定义因子：动态 import variant 因子库模块（与 check_factor.py 相同的白名单环境假设——
     这些文件写入时已通过 AST 检查），调 `add_factor(df, param=param, col_name=...)` 取值。
5. **相关与统计**：
   - 每截面算 **Spearman** 秩相关（对单调变换稳健，适合因子排序场景）；
   - 跨截面取**中位数**得稳健相关矩阵 R；
   - 输出：高相关对（|ρ| ≥ 0.8，阈值可配）、VIF（对 R 求逆对角线）、
     **有效复杂度** = 参与比 `(Σλ)²/Σλ²`（λ 为 R 的特征值）、
     每因子平均 |ρ| 排名（找出"最冗余"因子）。

输出（JSON 到 stdout）：

```json
{
  "ok": true,
  "caveat": "研究用近似口径：复权/停牌处理与闭源内核不保证逐位一致，数值用于相对比较",
  "sections_used": 48,
  "stocks_per_section_median": 4300,
  "factors": [{"name": "动量20", "kind": "custom", "status": "ok"}],
  "unresolved_factors": ["异常涨跌停状态"],
  "skipped_cross_factors": ["截面动量排名"],
  "correlation_matrix": {"动量20": {"动量60": 0.93}},
  "high_corr_pairs": [{"a": "动量20", "b": "动量60", "rho": 0.93}],
  "vif": {"动量20": 7.2},
  "effective_complexity": 3.4,
  "factor_redundancy_rank": [{"name": "动量60", "mean_abs_rho": 0.81}],
  "duration_ms": 123456
}
```

### 4.2 `src/mcp-server/factor-collinearity.ts`（新文件，纯函数层）

- `analyzeFactorCollinearity(runId, variantId, opts)`：
  定位 variant 目录（复用 strategy-files.ts 的工作区根与路径校验）；
  **职责划分**：回测区间与板块过滤由 TS 从 run 的 `brief.json` 读取
  （research-run.ts 已有 brief 读取逻辑，单份事实源），
  config.py 的因子/调仓周期解析放在 Python（复用 parse_config.py，避免双份解析）；
  `execFile`（**异步**，超时默认 10 分钟可配，不用 factor-check.ts 的 10s sync 模式）
  调内嵌 Python，解析 stdout JSON 返回结构化结果。
- Python 不可达 / 超时 / config 解析失败：返回 `{ok:false, error}`，调用方决定呈现。

### 4.3 MCP 工具注册（`src/mcp-server/tools.ts`）

- `analyze_factor_collinearity`：参数 `{runId, variantId, maxSections?, corrThreshold?}`，
  handler 包 try/catch，返回 JSON 文本；注册进 `registerTools`，
  同步加入 `tests/mcp-server/tools.test.ts` 的工具名清单。

### 4.4 `record_experiment` 集成（`src/mcp-server/research-run.ts`）

- 工具参数新增可选 `withCollinearity: boolean`（默认 false——分析耗时长，不默认开启）。
- 为 true 时：先完成原有 trace 写入（**分析失败不影响记录本身**），再调
  `analyzeFactorCollinearity`，成功则：
  - entry 新增 `collinearity: {max_abs_rho, high_corr_pairs_count, effective_complexity, sections_used}`；
  - entry.metrics 新增可选 `effective_complexity`（与 `complexity` 条目数并存，不替换）；
  - 响应文本追加 warning：`max_abs_rho ≥ 0.8` 时提示高相关对清单，**仅提示不拦截**。
- trace.jsonl schema 变更仅为新增可选字段，向后兼容（旧条目无此字段，读取侧已容忍缺字段）。

### 4.5 `get_run_summary` 展示

- summary 中 SOTA 条目旁附带最近一次带 `collinearity` 的 entry 的
  `effective_complexity` 与 `max_abs_rho`（无则省略字段）。不改 SOTA 排序逻辑。

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| variant/config.py 不存在 | 工具返回 `ok:false` + 明确错误（与其他工具一致） |
| 行情数据目录不存在 | `ok:false`，提示检查 `ALL_DATA_PATH` / 数据更新 |
| 内置因子无法映射 | 不失败；剔除并在 `unresolved_factors` 列出 |
| 因子模块 import/计算异常 | 该因子标记 `status:"error"` 剔除，报告继续（单因子不拖垮整体） |
| Python 超时（默认 10min） | `ok:false, error:"timeout"`；record_experiment 场景降级为无摘要正常记录 |
| 全部因子均失败 | `ok:false`（无矩阵可算） |

## 6. 口径限制（报告中必须携带 caveat）

- **近似重放**：闭源内核的数据预处理细节（复权精确算法、停牌剔除规则、pro 数据加工）
  不可见，脚本用 `收盘价/前收盘价` 链式复权近似。相关矩阵用于**相对比较**
  （哪对因子冗余），不作绝对断言。
- **内置因子不可枚举**：映射表覆盖常见项，未识别项进 `unresolved_factors`，
  映射表随使用逐步补全。
- **截面因子跳过**：cross_sections 产出因子不计算，只分析其时序输入因子。

## 7. 测试

- **Python 脚本单测**（`tests/mcp-server/fixtures/` 下造玩具数据）：
  构造 3 只股票的 GBK CSV + 两个设计上高相关的玩具因子（如 `动量20` 与 `动量20*2+噪声`），
  断言：高相关对被检出、effective_complexity ≈ 1.x、unresolved/异常路径行为正确。
- **TS 单测**：`tests/mcp-server/factor-collinearity.test.ts`，mock Python 输出，
  测参数组装、错误传递、record_experiment 集成（含分析失败降级）。
- **e2e 注册断言**：`tools.test.ts` 工具清单加 `analyze_factor_collinearity`
  （注意 tools.test.ts 依赖先 `build:mcp`）。

## 8. 改动文件清单

| 文件 | 改动 |
|------|------|
| `resources/factor_collinearity.py` | 新增（核心脚本） |
| `src/mcp-server/factor-collinearity.ts` | 新增（纯函数层） |
| `src/mcp-server/tools.ts` | 注册新工具 |
| `src/mcp-server/research-run.ts` | record_experiment 加 withCollinearity；trace entry/metrics 加可选字段；get_run_summary 展示 |
| `tests/mcp-server/factor-collinearity.test.ts` | 新增 |
| `tests/mcp-server/fixtures/` | 新增玩具行情 CSV + 玩具因子 |
| `tests/mcp-server/tools.test.ts` | 工具名清单 |
| `docs/quantclass-工作流.md` | §1 阶段表补一行新工具 |

## 9. 性能预算

- 默认 `maxSections=60`、股票池 ~5000、因子数 ~10：
  每截面约 5000 次小窗口 rolling 计算，Python 预估分钟级；超时上限 10 分钟。
- `withCollinearity` 默认关闭，避免拖慢常规 record_experiment。
