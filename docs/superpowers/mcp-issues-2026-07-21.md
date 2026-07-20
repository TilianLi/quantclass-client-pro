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
> - P2（观测性缺口）：⏳ 未处理（库内策略清单工具、libraryType 切换、异步回测任务 API，留待后续）

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
