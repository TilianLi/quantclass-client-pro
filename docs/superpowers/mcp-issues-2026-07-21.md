# run-e2e-validation：MCP 调用问题清单（端到端验证发现）

> 2026-07-21 凌晨，用 Runbook 驱动 MCP 实跑进化循环时发现。每条附证据与修复建议。
> 环境：libraryType=pos（zeus 内核），回测窗口 2025-01-01 至今，variant = run-e2e-validation_v1。
>
> **处理状态（2026-07-21 更新）**：
> - P0-1（run_backtest 假成功）：✅ 已修复——run_backtest 完成后校验本次产物（策略评价.csv 存在且 mtime 晚于启动时间），未产出返回 500 并提示内核日志
> - P0-2（回测范围为融合组合）：✅ 已提供工具——新增 `set_strategy_weight`，可停用其他策略组隔离回测范围。**机制勘误**：zeus 回测的策略来源是 config.json 的 `pos_mgmt.strategies`（weight>0 融合），real_market_25.json 服务于实盘交易参数；当日实证：清空策略库后 `set_strategy_weight("run-e2e-validation_v1", 1)` 即时生效，zeus 仅回测该 variant 并产出真实结果（2025-01 至今：年化 14.97%、最大回撤 -25.78%）
> - P0-3（无法停用损坏策略组）：✅ 同上，`set_strategy_weight(name, 0)` 即停用（按组名精确匹配，不受 isolate 前缀限制）
> - P1（capWeight 不实时同步）：✅ 对回测而言 config.json 层实时生效；`set_strategy_weight` 三层同步（config.json、localStorage、real_market_25.json）同时保证实盘一致，无需重启
> - P1（performance 无结果与成功同码）：✅ 已改为返回 404
> - P2（观测性缺口）：⏳ 部分处理——`list_library_strategies` 与 `run_backtest_async`/`get_backtest_task` 已于 2026-07-23 前补上（本节前次记录滞后）；libraryType 切换仍未提供

## P0 — run_backtest 假成功（内核崩溃也返回成功）

- **现象**：zeus 启动 7ms 后因因子缺失崩溃（zeus.log 有 ERROR + traceback），进程 exit 0，MCP 返回 `{"code": 0, "message": "策略回测已完成"}`。
- **证据**：`logs/zeus.log` 2026-07-21 03:18:11（`因子【估值.捡烟蒂因子】…缺少依赖 '因子库.估值'` → `pid 16152 exit successfully`）；同次 MCP 响应 code:0。
- **影响**：AI 无法区分「回测成功」与「内核秒崩」，会把空结果当成策略失败计入 trace，污染进化循环。
- **建议**：run_backtest 完成后校验产物（`回测结果/{backtest_name}/策略评价.csv` 存在且 mtime 在本次启动之后），或解析 zeus 退出前的 stderr/log 关键字（`内核调用指令出现异常`），失败时返回 code≠0 与错误摘要。

## P0 — 回测范围≠导入的 variant：zeus 回测全部 weight>0 策略的融合

- **现象**：zeus 回测的策略来源是 config.json 的 `pos_mgmt.strategies`，按 `cap_weight` 过滤，backtest_name 只决定输出目录名。只要库里有其他权重>0 的策略组，回测结果就是融合组合，不是刚导入的 variant。（2026-07-21 勘误：此前判断策略来源为 real_market_25.json，实证修正——real_market_25.json 由 `ROCKET_STR_INFO_PATH` 注入，服务于实盘交易参数；回测融合组成以 config.json 为准。该文件的权重在客户端重启时被 renderer localStorage 整体重写，手工编辑会被回滚。）
- **证据**：zeus.log 的跳过提示与崩溃均对应 config.json 组内策略（方案三因子缺失）；清空 config.json 策略组后 zeus 仅回测新 variant（2026-07-21 03:50 日志：`run-e2e-validation_v1-100.00%`）。
- **影响**：Runbook 的核心假设「回测仅针对当前 variant」在 pos 模式不成立——单假设可归因性被库状态污染。
- **建议**（任一）：a) MCP 新增策略权重管理工具（列出/停用其他策略组）——已实现 `set_strategy_weight`；b) zeus 支持按 backtest_name 单组回测；c) run_backtest 增加 `isolateLibrary` 语义。

## P0 — MCP 无工具停用/删除损坏的策略组，损坏组可让一切回测崩溃

- **现象**：X2/X3-选股策略精心随机（方案三）权重=1，引用 `估值.EP`、`估值.捡烟蒂因子`、`规模.Alpha95V2` 等全盘不存在的因子（`strategy_repo/*/因子库` 为扁平旧因子集，无 `估值/`、`成长/` 等子包），zeus init 加载即崩。isolate 前缀正则 `^(.*_v)\d+$` 无法匹配无 `_vN` 后缀的组名（"选股策略精心随机"），MCP 也没有删除/停用工具。
- **证据**：zeus.log 三次崩溃（02:50 估值.EP、03:01 规模.Alpha95V2、03:18 估值.捡烟蒂因子）；`find QuantData -name EP.py` 仅命中 strategy_repo 扁平目录。
- **影响**：库中只要存在一个损坏组，所有 pos 回测（含 UI 发起）全部失败；AI 无法自愈。
- **建议**：MCP 新增 `remove_strategy` / `set_strategy_weight`（按名称精确匹配），并让 isolate 支持非 `_vN` 命名或显式组名列表。

## P1 — import_strategy 的 capWeight 与策略权重的同步语义

- **现象**：`import_strategy(capWeight=1)` 返回成功（config.json + localStorage 已更新），但 `real_market_25.json` 的对应槽位不会实时创建/更新，该文件在**客户端重启时**才从 renderer localStorage 全量重建（此前对 config.json / real_market_25.json 的手工修改均被回滚）。
- **证据**：03:1x 导入响应 `capWeight: 1`；随后两次读取 real_market_25.json 槽位权重仍为 0。03:09 启动重启后该文件被 localStorage 旧状态整体重写。
- **影响**：对**回测**无影响（zeus 读 config.json，导入即生效）；对**实盘**参数（hold_plan/buy/sell）有滞后，需重启或经 `set_strategy_weight` 同步。`capWeight=0` 的安全默认使 zeus 回测直接跳过新 variant（`资金占比为0，跳过`）。
- **建议**：import 时同步刷新 real_market_25.json 对应槽位；`set_strategy_weight` 已提供三层同步；import_strategy 文档写明 pos 模式回测要求 capWeight>0 或用 set_strategy_weight 启用。

## P1 — get_backtest_performance 的「无结果」与「成功」同码

- **现象**：策略评价文件不存在时返回 `code: 0, data: null`，与成功同码，只能靠判 `data === null` 区分。
- **建议**：返回 code≠0（如 404）或显式 `status: "no_result"` 字段。

## P2 — 观测性缺口

- 无 MCP 工具读取 real_market_25 权重/策略清单（诊断融合组成只能读文件）。
- 无 MCP 工具切换 libraryType（settings.libraryType），pos/select 模式无法经 MCP 切换。
- run_backtest 仅阻塞式（30 分钟上限）；源码已有 `BacktestTaskManager`（`src/main/lib/process.ts:222`）支持 taskId 轮询，未暴露到 MCP。

## 环境备注（非 MCP 问题）

- config.json / real_market_25.json 的手工编辑会在客户端重启时被 renderer localStorage 回滚——策略权重的权威存储是 localStorage（`fusion` / `selectStockStrategy25`），文件手术无效。
- 本 run 期间对 `config.json`、`real_market_25.json` 做过备份：`*.bak-e2e-20260721`（AppData/Roaming/QuantclassClient/）。当前 config.json 比原状多一个 `run-e2e-validation_v1` 组（weight=1，isolate 命名合规），其余组未动。
- X2/X3（方案三）引用缺失因子是当前库的内置炸弹，建议在 UI 中将其资金占比设 0 或删除，并补回/清理对应策略包。

---

# run-rdagent-demo-001：MCP 调用问题清单（2026-07-23 追加）

> 2026-07-23 凌晨，Kimi Work（经 kimi.plugin.json 安装 quantclass 插件，MCP 由外部宿主 spawn）按 `research-agent-runbook.md` 完整实跑 RD-Agent 流程（2 轮进化 + 样本外复核 + 提交审阅）时发现。每条附证据与修复建议。
> 环境：libraryType=pos（zeus 内核 v2.2.0），样本内 2023-01-01→2024-12-31，样本外 2025-01-01→2026-07-21，runId = run-rdagent-demo-001。
> 全程结果：v1 动量降序（年化 -9.31%/回撤 -31.16%，SOTA）、v2 小市值+反转（年化 +4.93%/回撤 -39.26%）、v1 OOS（年化 -13.50%/回撤 -23.54%），未全部达标，已产出 candidate-report.md 待人工审阅。
>
> **处理状态（2026-07-23 修复）**：
> - P0（validate_strategy 外部宿主必坏）：✅ 已修复——新增 `src/mcp-server/paths.ts`，以模块自身位置（import.meta.url）为锚解析 resources 目录与内嵌 python（含 `python/<arch>/` 布局），`validateStrategy`/`checkFactorSource`/`validateConfigSyntax` 三处共用；ENOENT 时返回含已搜索路径的可操作提示
> - P1（sharpe_ratio 口径）：✅ 文档口径已标注——`get_backtest_performance`/`evaluate_backtest`/`compare_backtest_variants` 工具 description 与 runbook §4.4 均注明「实为年化收益/回撤比」；字段改名（calmar_ratio）为 breaking change，留待后续版本
> - P1（filter_cyb 未生效）：✅ 已修复——根因为类型不一致：UI 写布尔、MCP 写字符串 "0"/"1"，Python 真值判断下 "0" 为真 → 全部过滤。`PUT /mcp/backtest/config` 落盘前现将 filter_* 强制转布尔，与 UI 口径一致
> - P2（compare_backtest_variants 吞校验失败 + 字段不一致）：✅ 已修复——校验失败输出 `validationWarnings`；`parsePercentOrNumber` 放宽为取首个数值（兼容 "57.95% / 57.95%" 双值，win_rate_pct 不再丢失）；`parsePerformanceCsv` 修正表头 off-by-one（该 CSV 本无表头）
> - P2（异步路径无产物校验）：✅ 已修复——产物校验抽取为共用函数并下沉到 `GET /mcp/backtest/task`：status=success 时校验 策略评价.csv 存在且 mtime 不早于任务 startedAt，未产出则降级 status=error 并附 artifactError
> - P2（数据准备缓存）：⏳ 未处理——缓存键在 zeus 内核侧（QuantData/code 外部二进制），本仓库无法修改，需内核侧支持
> - P3（杂项）：✅ 部分修复——runbook 工具数已更正为 38（kimi.plugin.json 在宿主侧仓库，未同步）；`record_experiment` 自动 ts 改为本地时间+时区偏移；`fromLatestBacktest` 的 kernelVersion 缺失已修（`/mcp/backtest/task` 响应带 kernelVersion，MCP 侧轮询到 success 时缓存）

## P0 — validate_strategy 在外部 MCP 宿主下必坏（process.cwd 依赖 + python 候选不全）

- **现象**：`validate_strategy` 返回 `{"valid": false, "errors": ["校验失败: spawnSync python ENOENT"]}`，与 config 内容无关，任何合法 config 都失败。
- **证据**：`resources/mcp-server/index.js` 两处——`validateStrategy`（约 21880 行）用 `join(process.cwd(), "resources", "python", "python.exe")` 与 `join(process.cwd(), "resources", "parse_config.py")`；`checkFactorSource`（约 21263 行）同样依赖 `process.cwd()`。Kimi Work spawn MCP server 时 cwd ≠ QuantClass 安装目录 → 候选全部落空 → 回退裸 `python`（系统 PATH 无）→ ENOENT。**且 `validateStrategy` 的候选列表漏了 `resources/python/x64/python.exe`（`resolvePythonCmd` 有该候选、`validateStrategy` 没有）——即使 cwd 正确，`validate_strategy` 仍会回退裸 python 失败**。客户端自带 python 实际位于 `resources/python/x64/python.exe`。
- **影响**：runbook §4.2 的强制校验门在外部宿主下不可用；`write_factor_file` 的静态闸门（checkFactorSource）同样必坏；AI 只能绕过官方工具手工复刻校验（本次用 bundled python 直跑 `parse_config.py` + 人工核对因子文件存在性代替），流程合规性被破坏。
- **建议**：a) 所有 `process.cwd()` 改为相对 index.js 自身定位（如 `join(__dirname, "..")`，index.js 在 `resources/mcp-server/` 下）；b) `validateStrategy` 的 python 候选补齐 `resources/python/x64/python.exe`（与 `resolvePythonCmd` 对齐，或两处共用同一函数）；c) ENOENT 时返回可操作错误（如「未找到 python，期望路径 X」）而非裸 spawn 错误。

## P1 — parsed.sharpe_ratio 口径错误：实为「年化收益/回撤比」，不是夏普率

- **现象**：`get_backtest_performance` 的 `data.parsed.sharpe_ratio` 数值与 `data.metrics["年化收益/回撤比"]` 完全一致（v1：-0.3；v2：0.13；OOS：-0.57），策略评价 18 项中并不存在夏普率指标。
- **影响**：runbook thresholds 五键之一的 `sharpe_ratio` 实际评估的是 Calmar 类收益回撤比，`evaluate_backtest`、trace、candidate-report 全链路口径被静默替换；用户若按夏普率理解会误判策略质量。
- **建议**：字段改名 `calmar_ratio`（或 `annual_return_drawdown_ratio`），或内核在策略评价中补充真夏普率后再映射；至少在 runbook §4.4 与工具 description 中写明口径。

## P1 — set_backtest_config 的 filter_cyb 疑似未生效（创业板始终被排除）

- **现象**：`set_backtest_config(filter_cyb="0", filter_kcb="1", filter_bj="1")` 返回 `updated` 确认写入，但随后三次回测（v1、v2、OOS）zeus 日志均显示 `板块过滤：['bj', 'cyb', 'kcb']` 与 `需要排除`北交所`，`创业板`，`科创板``——`filter_cyb="0"` 未传导到内核。
- **证据**：MCP 响应 `updated: {..., filter_cyb: "0", ...}`；zeus stdout（task zeus_30312 / zeus_30504 / zeus_48088）板块过滤三处均含 cyb。
- **影响**：回测股票池与 brief 声明不一致，样本内/外结论的 universe 偏离预期；若语义反反转（"0"/"1" 含义写反）则 runbook §3 的字段说明也在误导。
- **建议**：核对 MCP 写入的配置键/路径与 zeus 读取处是否一致；在 `set_backtest_config` 响应或 `get_backtest_config` 中回显内核实际生效值，便于 AI 闭环验证。

## P2 — compare_backtest_variants 静默吞掉校验失败 + 指标字段集不一致

- **现象**：该工具内部调用 `validateStrategy`（约 22934 行），python ENOENT 被 catch 吞掉，仅靠 `validation.extracted?.backtest_name || \`${runId}_${variantId}\`` 命名兜底继续——校验失败对外完全不可见。另外其输出的 performances 缺 `win_rate_pct`（`get_backtest_performance.parsed` 有），两工具字段集不一致。
- **影响**：本次侥幸靠命名约定返回了正确结果，但配置真出错时会静默产出错误的对比结论；字段缺失使跨工具拼接 metrics 时需要额外判空。
- **建议**：validateStrategy 失败时在响应中带 `validationWarnings`；统一两个工具的 parsed 字段集（至少补齐 win_rate_pct）。

## P2 — 异步回测路径无产物校验（与同步路径保障不对等）

- **现象**：`run_backtest`（同步）带产物校验（2026-07-21 P0-1 的修复），但同步阻塞有 MCP 客户端超时风险（runbook §0 自行警告「几分钟到几十分钟」）；`run_backtest_async` 规避了超时，工具 description 明确「异步模式不做产物校验」。本次三轮回测全部走 async 正是为规避超时。
- **影响**：最实用的调用路径（async + 轮询）恰恰缺少「内核秒崩识别」这一关键保障，2026-07-21 P0-1 的修复在 async 路径下形同虚设。
- **建议**：把产物校验下沉到 `get_backtest_task`（status=success 时校验 策略评价.csv 存在且 mtime 晚于 startedAt，不满足则 status=error 并附内核日志位置），或至少在 `get_backtest_performance` 侧补 mtime 校验。

## P2 — 回测数据准备无跨 variant 缓存复用（性能）

- **现象**：同一窗口同一过滤条件下，v1/v2/OOS 三次回测各花 ~70 秒全量重跑「准备数据」（5868 只股票预处理 + 5 张透视表），占单次回测总耗时（~2 分钟）的一半以上；运行缓存按 backtest_name 隔离（`运行缓存/{backtest_name}/`），variant 间无法共享。
- **建议**：按「窗口 + 板块过滤 + 数据版本」做数据准备层的共享缓存键，variant 间复用 `股票预处理数据.pkl` / `全部股票行情pivot.pkl`；进化循环 N 轮可省 N×~70s。

## P3 — 杂项

- **工具数量三处不一致**：runbook §0 写「32 个工具可用」、`kimi.plugin.json` description 写「33 tools」、实测 `tools/list` 返回 **38 tools + 2 resources**。建议以实测为准同步文档。
- **OOS 窗口日志显示不友好**：`end_date: null` 透传为 `回测周期：2025-01-01 -> None`（功能正常，仅显示问题）。
- **record_experiment 自动 ts 为 UTC**：trace 中 `2026-07-22T18:36:24.990Z` 对应本地 02:36，人工阅读 trace 易混淆；建议用本地时区或附带时区标注。
- **fromLatestBacktest 未自动填 kernelVersion**：`record_experiment(fromLatestBacktest=true)` 的 description 宣称自动填 `kernelVersion`（缺省时），实际 trace entry 中无该字段；metrics 自动填充正常。

## 环境备注（2026-07-23，非 MCP 问题）

- quantclass 插件通过 Kimi Work 安装（`plugins/managed/quantclass/kimi.plugin.json` + installed.json 注册），MCP server 由 Kimi Work 以 `node resources/mcp-server/index.js`（QUANTCLASS_PORT=8787）spawn——这正是 P0 的触发形态；客户端自启 MCP（若 cwd 为安装目录）不受 P0 影响。
- 本 run 结束时库内状态：`run-rdagent-demo-001_v1` weight=1，其余 4 组 weight=0；回测配置已切回样本内窗口（2023-01-01→2024-12-31）。candidate-report 路径：`workspace/agent-strategies/run-rdagent-demo-001/candidate-report.md`，实盘导入待人工确认，未触碰任何实盘类工具。
- 校验绕行记录：v1/v2 的 config 均经 bundled python（`resources/python/x64/python.exe` + `resources/parse_config.py`）手动解析 + 因子文件存在性人工核对（`因子库/动量/动量20.py`、`因子库/波动/波动率20.py`、`因子库/市值.py` 均存在且含 `__init__.py`），与 `validate_strategy` 规则等效。
