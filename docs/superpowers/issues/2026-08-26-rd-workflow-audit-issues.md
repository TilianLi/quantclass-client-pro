# RD 研发闭环实跑审计 · 缺陷清单

> 来源：2026-08-26 用 `run-rd-audit-20260826` 对最新研究闭环（知识库 / run 生命周期 / 假设质量闸门 / walkforward 强制）做端到端实跑审计。每条缺陷附实测证据与代码根因。
>
> 环境说明：审计前发现本机 `node_modules/electron` 二进制残缺（`dist/` 只剩 `locales`），`install.js` 静默退出不修复；`.npmrc` 中 `electron_mirror` 被注释导致 GitHub 直连 10 分钟超时。最终手工从 `%LOCALAPPDATA%/electron/Cache/electron-v39.2.7-win32-x64.zip` 解包恢复。**此项为环境基建问题，建议解除 `.npmrc` 镜像注释或在 rebuild 脚本中检测残缺。**

---

## P0 — 严重

### ISSUE-1 `run_dev_walkforward` 同步超长执行，MCP 超时后变"幽灵任务"

- **现象**：调用约 5 分钟后客户端报 `MCP error -32001: Request timed out`，但服务端继续执行：配置切窗、逐窗口回测、写 trace 全部完成，调用方却拿不到任何结果，也无 taskId / 进度查询 / 取消手段。审计中两次调用均复现。
- **风险**：agent 无法区分"失败"与"进行中"，可能重复触发 → 重复消耗迭代预算、重复写 trace、串行回测互相抢配置。
- **根因**：`src/mcp-server/tools.ts:633-793` 在单个 MCP 请求内串行 `await` N 个窗口的同步回测（单窗口 HTTP 超时 30 分钟）；所有 handler 不响应 `extra.signal` 取消；`client.ts:88-92` 用独立 AbortController；主进程 `mcp.ts:488-582` 不监听请求 abort。客户端超时后发 `notifications/cancelled`，无人接收。
- **修复方向**：job 化——`run_dev_walkforward` 前置校验（含预算预检，见 ISSUE-5）+ 快照配置后立即返回 jobId，窗口循环后台执行，进度落盘 `workspace/<runId>/dev-walkforward-job.json`（仿 `validation-gate.ts` 的 validation-state.json 先例）；新增 `get_dev_walkforward_job(runId)` 查询；窗口内回测改用已有的 `/mcp/backtest/run-async` + `/mcp/backtest/task` 轮询（`mcp.ts:590/622`）。

### ISSUE-2 `create_research_run` 不回写 `brief.backtest`，首轮回测静默用错窗口/股票池

- **现象**：创建 run（brief.backtest = 2023~2024、过滤科创/北交）后直接 `run_backtest`，实际执行的是客户端残留配置 `2019-01-01 → null、板块过滤 []`，预估仓位里混入 20 只北交所股票。审计实跑证据：zeus 日志 `回测周期：2019-01-01 -> None`、`板块过滤：[]`。
- **风险**：每个新 run 的首轮 dev 回测都可能跑在与研究目标完全不符的窗口与股票池上，结果静默污染判断。runbook 第 40 行虽要求手动 `set_backtest_config` 补救，但工具层零校验零提醒。
- **根因**：`research-run.ts:398-418` 的 `createResearchRun` 只有写盘一个副作用，全 `src/mcp-server/` 无任何代码消费 `brief.backtest`。
- **修复方向**：`create_research_run` 成功后若 `brief.backtest` 存在，自动 `PUT /mcp/backtest/config`（映射逻辑复用 `validation-gate.ts:86-101`）；客户端离线时降级为响应内 warning（run 已创建，不可失败回滚）。

### ISSUE-3 `close_run` 非幂等，已关闭 run 可被静默覆盖

- **现象**：对已 achieved 的 run 再次 `close_run` 成功，`closeReason` 被覆盖为无意义内容（实测被"幂等性测试"覆盖，原始关闭结论丢失），`closedAt` 被刷新。
- **根因**：`research-run.ts:702-732` 合并写回前从未检查 `raw.status`；注释称"重复 close 允许"是有意设计，但无 force 显式确认。
- **修复方向**：已关闭（status ≠ active）时默认报错并回显现有 status/closedAt；加可选 `force: boolean` 参数，显式传 true 才允许改判，响应中回显被覆盖的旧值。

### ISSUE-4 迭代预算 `evolving_n` 只报告不拦截

- **现象**：`evolving_n=2` 用尽（used=2/2）后，`record_experiment` 仍接受第 3 条 dev 记录，返回 `remaining: -1` 且 `warnings` 为空。
- **根因**：`research-run.ts:500-514` 预算在 `appendFileSync` **之后**才计算，仅作返回字段；无任何 reject/warning 分支。`run_dev_walkforward` 入口也无预检——超预算时会白跑 N 分钟回测才在写 trace 时暴露（若现闸门生效）。
- **修复方向**：写入前拦截：`type=dev` 且 `devCount >= evolving_n` 时报错（提示 close_run 或提高预算）；`run_dev_walkforward` 入口（拿到 brief 后、起回测前）同步预检，避免白跑。validation 条目不受限。

### ISSUE-5 `run_validation` 不校验当前回测策略是否为该 run 的 SOTA

- **现象**：工具只收 `runId`；若 agent 忘记先 `import_strategy` SOTA variant，样本外验证会静默跑在库内旧策略上，`complete_validation` 再把错误结果记为 validation 条目，全程无告警，代价是数分钟回测 + 错误结论。
- **根因**：`tools.ts:1905-1931` 中 `GET /mcp/backtest/config` 响应已含 `backtestName`，但仅作快照保存，从未与 SOTA 期望名比对。
- **修复方向**：增加可选 `variantId` 参数（缺省取 `getRunSummary(runId).sota`）；按 compare 同款逻辑从 variant 的 config.py 推导期望 `backtest_name`，与当前配置不一致时直接报错并提示先 `import_strategy`。

---

## P1 — 口径不一致

### ISSUE-6 `compare_backtest_variants` 与 trace/SOTA 口径分裂

- **现象**：同 run 同 variant，`get_run_summary` 的 SOTA 指标（v1：年化 22.23 / 回撤 -11.52，2023 最劣窗口）与 `compare_backtest_variants`（v1：年化 24.0 / 回撤 -21.79）完全对不上。本次两者恰好都选中 v2，但指标值差异足以误导人工判断。
- **根因**：`tools.ts:1442-1466` 直接读 `回测结果/<backtest_name>/策略评价.csv`——该目录被内核按 backtest_name 覆盖写，walkforward 后只剩**最后一个窗口**（甚至之后任何同名回测）的残留；而 SOTA 口径是 `walkforward-eval.ts:66-101` 选出的最劣窗口。且无 mtime 新鲜度校验（主进程 `findBacktestArtifact` mcp.ts:346-366 有，这里反而没有）。
- **修复方向**：variant 在 trace.jsonl 有 dev 记录时优先取最近一次 dev 条目的 `metrics`（walkforward 最劣窗口口径，与 SOTA 一致）；无记录才回退读 CSV；响应中每个 variant 标注 `source: "trace" | "csv"`。

### ISSUE-7 板块过滤字段类型口径分裂（string "0"/"1" vs boolean）

- **现象**：brief.json 与 `set_backtest_config` 入参用字符串 `"0"/"1"`；`get_backtest_config` 返回 boolean；`validation-gate.ts:39-41` 快照类型声明为 string 与实际运行值（boolean）不符；首次设置前 GET 默认返回字符串 `"0"`，设置后变 `false`，往返不自洽。
- **根因**：主进程 `mcp.ts:1346-1352` PUT 时把 `"1"→true / 其他→false` 存 boolean（zeus Python 按真值判断，字符串 "0" 为真会误过滤，转换是必要的），但线缆协议与类型声明没有跟着统一。
- **修复方向**（非破坏）：`BacktestConfigSnapshot.filterKcb/Cyb/Bj` 改 `string | boolean`；`priorConfigToRestoreBody` 对 `filter_*` 统一归一为 boolean 再回传；brief schema 三字段加 `.describe('线缆口径 "0"/"1"，客户端存储为 boolean')`。

---

## P2 — 轻微

### ISSUE-8 评审报告结尾文案与前置事实矛盾

- **现象**：报告固定结尾「请确认是否将该策略导入 QuantClass 并启用实盘交易」，但策略在回测前已被 `import_strategy` 导入库中；「启用实盘交易」也越过评审本身的决策范围。
- **根因**：`review-submitter.ts:104` 静态文案。
- **修复方向**：改为如实描述——「该策略已导入 QuantClass 策略库。请确认是否为其分配实盘资金占比（set_strategy_weight）并开启自动交易」。

---

## 已确认的非缺陷（记录备查）

- **calmar_ratio / sharpe_ratio 双写**：`backtest-evaluator.ts:79-89`、`mcp.ts:1369-1375`、`research-run.ts:215-224` 三处均一致双写，是有意的兼容别名设计，所有产出路径（run_dev_walkforward / complete_validation / fromLatestBacktest / compare）口径一致。不改。
- **假设质量闸门**：占位 lesson 拦截、walkforward 强制（带绩效 dev 条目必须走 run_dev_walkforward）均按设计工作，实测拦截信息清晰。

## 待观察（内核侧，非 MCP 工具链）

- 三次回测日志中「选股面板数据拼接完成，最晚日期 2026-08-12」与「行情数据最新 2026-08-25」相差 9 个交易日，选股结果区间止步 2026-08-07。因子计算最晚日期正常（08-25）。疑似内核面板拼接或选股输出区间滞后，建议内核侧排查，本清单不展开。

---

## 修复范围（本轮执行）

- P0：ISSUE-1 ~ ISSUE-5 全部
- P1：ISSUE-6、ISSUE-7 全部
- P2：ISSUE-8（一行文案，顺手）
- 非缺陷与待观察项不动。
