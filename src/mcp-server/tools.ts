/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
	computeDrawdownEpisodes,
	computeYearlyReturns,
	parseEquityRows,
} from "./backtest-diagnostics.js"
import { evaluateBacktest } from "./backtest-evaluator.js"
import { get, post, put } from "./client.js"
import { resolveVariantPerformances } from "./compare-variants.js"
import { listFactorComponents } from "./component-catalog.ts"
import {
	readDevWalkforwardJob,
	startDevWalkforwardJob,
} from "./dev-walkforward-job.js"
import { checkFactorSource } from "./factor-check.js"
import { getKnowledge, recordKnowledge } from "./knowledge-base.ts"
import {
	closeRun,
	createResearchRun,
	experimentEntrySchema,
	getExperimentTrace,
	getResearchBrief,
	getRunStatuses,
	getRunSummary,
	recordExperiment,
	researchBriefSchema,
} from "./research-run.js"
import { submitForReview } from "./review-submitter.js"
import {
	getWorkspaceRoot,
	listRuns,
	listVariants,
	readStrategyFile,
	writeFactorFile,
	writeStrategyFile,
} from "./strategy-files.js"
import { validateStrategy } from "./strategy-validator.js"
import {
	backtestWindowToConfigBody,
	buildValidationWindow,
	clearValidationState,
	priorConfigToRestoreBody,
	readValidationState,
	saveValidationState,
} from "./validation-gate.js"

// 最近一次成功回测的信息缓存（供 record_experiment 的 fromLatestBacktest 使用）
let lastBacktestInfo: {
	at: string
	backtestName?: string
	kernel?: string
	kernelVersion?: string
	libraryType?: string
} | null = null

/**
 * 把 `field` (允许包含 dot-key, 例如 "real_market_config.account_id")
 * 与 `value` 转成 controller 端 whitelisting 期望的扁平对象:
 *   { "real_market_config.account_id": value }
 * 这样 controller 中 `body[key]` 形式的检查才能命中白名单键。
 */
function flattenFieldValue(
	field: string,
	value: unknown,
): Record<string, unknown> {
	return { [field]: value }
}

export function registerTools(server: McpServer): void {
	server.tool(
		"get_system_status",
		"获取 QuantClass 系统运行状态，包括调度器状态、网络连接、自动任务等信息",
		{},
		async () => {
			try {
				const result = await get("/mcp/status")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取系统状态失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"toggle_min_data_schedule",
		"控制实时数据（分钟线）定时任务的启停",
		{
			isOn: z.boolean().describe("是否启用定时任务"),
			mode: z
				.enum(["fast", "stable"])
				.optional()
				.describe("运行模式: fast=高频, stable=稳定"),
			autoAccurate: z.boolean().optional().describe("是否自动执行精确模式"),
			autoFuzzy: z.boolean().optional().describe("是否自动执行模糊模式"),
		},
		async ({ isOn, mode, autoAccurate, autoFuzzy }) => {
			try {
				const result = await post("/mcp/min-data/toggle", {
					isOn,
					mode,
					autoAccurate,
					autoFuzzy,
				})
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `控制定时任务失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"exec_min_data",
		"手动执行一次分钟线数据获取",
		{
			type: z
				.enum(["accurate", "fuzzy"])
				.describe("获取类型: accurate=精确, fuzzy=模糊"),
			mode: z
				.enum(["fast", "stable"])
				.optional()
				.describe("运行模式: fast=高频, stable=稳定"),
		},
		async ({ type, mode }) => {
			try {
				const result = await post("/mcp/min-data/exec", { type, mode })
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `执行数据获取失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool("get_trading_config", "读取当前交易配置信息", {}, async () => {
		try {
			const result = await get("/mcp/config/trading")
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `读取交易配置失败: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			}
		}
	})

	server.tool(
		"update_trading_config",
		"更新交易配置中的指定字段。允许的字段: real_market_config.account_id (string), real_market_config.use_fuzzy (string), real_market_config.use_open_sell (string)。auto_real_trading 请使用 toggle_auto_trading 工具。",
		{
			field: z.string().describe("配置字段名称，支持 dot-key 路径"),
			value: z
				.union([z.string(), z.number(), z.boolean()])
				.describe("配置字段值"),
		},
		async ({ field, value }) => {
			try {
				// controller 端 whitelisting 用 body[key] 扁平读取；
				// 在 client 侧把 { field, value } 拆解为 { "field.dot.path": value }
				const body = flattenFieldValue(field, value)
				const result = await put("/mcp/config/trading", body)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `更新交易配置失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"toggle_auto_trading",
		"控制自动交易的启停",
		{
			isOn: z.boolean().describe("是否启用自动交易"),
		},
		async ({ isOn }) => {
			try {
				const result = await post("/mcp/trading/toggle", { isOn })
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `控制自动交易失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"toggle_history_update",
		"控制历史数据更新任务的启停",
		{
			isOn: z.boolean().describe("是否启用历史数据更新"),
		},
		async ({ isOn }) => {
			try {
				const result = await post("/mcp/history-data/toggle", { isOn })
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `控制历史数据更新失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	// ============================================================
	// 第一优先级：交易数据查询（只读）
	// ============================================================

	server.tool(
		"get_buy_signals",
		"查询实盘买入信号列表，包含当前策略产生的买入信号（股票代码、买入价格、目标仓位等）",
		{},
		async () => {
			try {
				const result = await get("/mcp/trading/buy-signals")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取买入信号失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_sell_signals",
		"查询实盘卖出信号列表，包含当前策略产生的卖出信号（股票代码、卖出价格、卖出原因等）",
		{},
		async () => {
			try {
				const result = await get("/mcp/trading/sell-signals")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取卖出信号失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_stock_timing_plans",
		"查询个股择时买入或卖出计划。type=buy 返回买入计划（目标股票、买入金额），type=sell 返回卖出计划（持仓股票、卖出数量）",
		{
			type: z
				.enum(["buy", "sell"])
				.describe("计划类型: buy=买入计划, sell=卖出计划"),
		},
		async ({ type }) => {
			try {
				const result = await get(`/mcp/trading/stock-timing-plans?type=${type}`)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取择时计划失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_account_info",
		"查询实盘账户信息，包括可用资金、总资产、持仓明细等",
		{},
		async () => {
			try {
				const result = await get("/mcp/trading/account")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取账户信息失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_trading_info",
		"查询 Aqua 交易信息，包含交易内核的运行状态和交易记录",
		{},
		async () => {
			try {
				const result = await get("/mcp/trading/info")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取交易信息失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	// ============================================================
	// 第一优先级：回测工具
	// ============================================================

	server.tool(
		"get_backtest_config",
		"查询当前回测配置，包括策略库类型（选股/仓位管理）、初始资金、回测起止日期、板块过滤设置（科创板/创业板/北交所）、策略名称",
		{},
		async () => {
			try {
				const result = await get("/mcp/backtest/config")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取回测配置失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"run_backtest",
		"执行策略回测。根据当前策略库类型自动选择内核（选股→aqua，仓位管理→zeus）。回测是长耗时操作（可能几分钟到几十分钟），会阻塞直到回测完成。回测期间不能同时运行实盘。建议在非交易时段使用。仓位管理库(zeus)默认会融合回测全部 weight>0 的策略组；传 only_backtest_name=true 可临时将其他组权重置 0、只回测当前 backtest_name 策略组，结束后自动恢复原权重。成功响应包含 backtestName、kernelVersion、durationMs、resultPath；未产出结果（内核失败）返回错误。",
		{
			only_backtest_name: z
				.boolean()
				.optional()
				.describe(
					"仅回测当前 backtest_name 策略组：回测前临时将库内其他策略组权重置 0（三层同步），结束后无论成败自动恢复原权重。仅仓位管理库(zeus)有效，默认 false",
				),
		},
		async ({ only_backtest_name }) => {
			try {
				// 回测是长耗时操作，设置 30 分钟超时
				const result = await post(
					"/mcp/backtest/run",
					only_backtest_name ? { only_backtest_name } : undefined,
					1_800_000,
				)
				const data = (result as Record<string, unknown>)?.data as
					| Record<string, unknown>
					| undefined
				if (data) {
					lastBacktestInfo = {
						at: new Date().toISOString(),
						backtestName: data.backtestName as string | undefined,
						kernel: data.kernel as string | undefined,
						kernelVersion: data.kernelVersion as string | undefined,
						libraryType: data.libraryType as string | undefined,
					}
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `执行回测失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"run_backtest_async",
		"异步执行策略回测：立即返回 taskId，内核在后台运行，用 get_backtest_task 轮询状态。适合长耗时回测时避免阻塞等待。产物校验在 get_backtest_task 侧完成（status=success 时校验本次产物，未产出则降级为 error 并附 artifactError）。",
		{},
		async () => {
			try {
				const result = await post("/mcp/backtest/run-async", undefined, 60_000)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `启动异步回测失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_backtest_task",
		"查询异步回测任务状态（run_backtest_async 返回的 taskId）。返回 status(running/success/error)、exitCode、stdout/stderr 尾部日志与 kernelVersion。status=success 时校验本次回测产物（策略评价.csv 存在且为本次运行所写），未产出则 status 降级为 error 并附 artifactError。",
		{
			taskId: z.string().describe("任务 ID（形如 zeus_12345）"),
		},
		async ({ taskId }) => {
			try {
				const result = await get(
					`/mcp/backtest/task?taskId=${encodeURIComponent(taskId)}`,
				)
				// 异步回测同样缓存最近一次成功信息，供 record_experiment 的
				// fromLatestBacktest 自动填充 kernelVersion
				const data = (result as Record<string, unknown>)?.data as
					| Record<string, unknown>
					| undefined
				if (data && data.status === "success") {
					lastBacktestInfo = {
						at: new Date().toISOString(),
						kernel: data.kernel as string | undefined,
						kernelVersion: data.kernelVersion as string | undefined,
					}
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `查询回测任务失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"run_walkforward",
		"对当前已启用策略依次在多个回测窗口执行回测（walk-forward 稳健性检查，防单窗口过拟合）。每个窗口串行执行 set_backtest_config → run_backtest → get_backtest_performance。返回各窗口绩效与汇总（最劣年化/年化中位/最差回撤/成功数）。注意：执行前需已导入并启用目标策略；每个窗口约需数分钟，全部串行执行。",
		{
			windows: z
				.array(
					z.object({
						start_date: z.string().describe("窗口开始日期 YYYY-MM-DD"),
						end_date: z
							.string()
							.nullable()
							.optional()
							.describe("窗口结束日期 YYYY-MM-DD，null 表示今天"),
						initial_cash: z.number().optional().describe("初始资金"),
					}),
				)
				.min(1)
				.describe("回测窗口列表（串行逐个执行）"),
		},
		async ({ windows }) => {
			const results: Array<Record<string, unknown>> = []
			for (const w of windows) {
				const body: Record<string, unknown> = {
					start_date: w.start_date,
					end_date: w.end_date ?? null,
				}
				if (w.initial_cash !== undefined) body.initial_cash = w.initial_cash
				try {
					await put("/mcp/backtest/config", body)
					await post("/mcp/backtest/run", undefined, 1_800_000)
					const perf = (await get("/mcp/backtest/performance")) as Record<
						string,
						unknown
					>
					const parsed = (perf?.data as Record<string, unknown>)?.parsed
					results.push({ window: body, ok: true, metrics: parsed })
				} catch (error) {
					results.push({
						window: body,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			}

			const okMetrics = results
				.filter((r) => r.ok && r.metrics)
				.map((r) => r.metrics as Record<string, number>)
			const annuals = okMetrics
				.map((m) => m.annual_return_pct)
				.filter((v): v is number => typeof v === "number")
				.sort((a, b) => a - b)
			const drawdowns = okMetrics
				.map((m) => m.max_drawdown_pct)
				.filter((v): v is number => typeof v === "number")
				.map((v) => Math.abs(v))
			const aggregate = {
				succeeded: okMetrics.length,
				total: windows.length,
				annual_min: annuals.length > 0 ? annuals[0] : undefined,
				annual_median:
					annuals.length > 0
						? annuals.length % 2 === 1
							? annuals[(annuals.length - 1) / 2]
							: (annuals[annuals.length / 2 - 1] +
									annuals[annuals.length / 2]) /
								2
						: undefined,
				drawdown_worst:
					drawdowns.length > 0 ? Math.max(...drawdowns) : undefined,
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ results, aggregate }, null, 2),
					},
				],
			}
		},
	)

	server.tool(
		"run_dev_walkforward",
		"启动一次 dev 迭代的 walkforward 稳健性检验（异步 job，不阻塞）：前置校验（brief.walkforward 存在、迭代预算未耗尽、无进行中 job）→ 快照当前回测配置 → 落盘 job 文件并立即返回 jobId。窗口循环在后台执行：逐窗口切配置 → /mcp/backtest/run-async + 轮询 task → 按 brief.thresholds 逐窗口评估，每窗口进度写入 <runId>/dev-walkforward-job.json（用 get_dev_walkforward_job 轮询）。全部完成后恢复原回测配置，并按最劣窗口口径（score 升序 → 年化升序，失败窗口计 0）写入一条 type=dev 的 trace 记录（消耗 1 轮迭代预算）；全部窗口失败则不写 trace、job status=error。",
		{
			runId: z.string().describe("Run ID"),
			variantId: z.string().describe("被检验的 variant ID"),
			hypothesis: z.string().describe("本次实验假设"),
			changes: z.string().optional().describe("相对上一版的变更"),
			lesson: z.string().optional().describe("实验结论教训"),
		},
		async ({ runId, variantId, hypothesis, changes, lesson }) => {
			try {
				const result = await startDevWalkforwardJob({
					runId,
					variantId,
					hypothesis,
					changes,
					lesson,
				})
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `启动 dev walkforward 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_dev_walkforward_job",
		"查询 run_dev_walkforward 启动的异步 job 进度：读取 <runId>/dev-walkforward-job.json，返回 status(running/success/error)、当前窗口序号、各窗口 metrics/evaluation、完成后的 traceEntry 与 budget。无此 run 的 job 时报错。",
		{
			runId: z.string().describe("Run ID"),
		},
		async ({ runId }) => {
			try {
				const job = readDevWalkforwardJob(runId)
				return {
					content: [{ type: "text", text: JSON.stringify(job, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `查询 dev walkforward job 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_backtest_result",
		"查询回测选股结果，返回最新一次回测的选股明细（选股日期、股票代码、目标资金占比、预计股数等）。需先执行 run_backtest 生成结果。",
		{},
		async () => {
			try {
				const result = await get("/mcp/backtest/result")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取回测结果失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	// ============================================================
	// 第二批次：策略开发闭环工具
	// ============================================================

	server.tool(
		"get_strategy_template",
		"获取策略开发模板，包括 config.py 格式说明、策略库目录结构、必选/可选变量说明。AI Agent 开发策略前应先调用此工具了解格式要求。",
		{},
		async () => {
			try {
				const result = await get("/mcp/strategy/template")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取策略模板失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"import_strategy",
		"导入策略到 QuantClass。接收 config.py 文件路径，解析策略配置并复制策略库/因子库/信号库等到 real_trading/ 目录下。路径与 QuantClass 客户端原有导入逻辑完全一致。可选 capWeight 参数设置资金占比（0-1，如 1=100%、0.5=50%），不传则重置为 0（安全默认，需后续手动设置）。默认开启 isolate，会自动替换同组（backtest_name 前缀相同，如 xxx_v1/xxx_v2）旧策略，避免 config.json 堆积。",
		{
			configFilePath: z
				.string()
				.describe(
					"config.py 文件的绝对路径，需与策略库/因子库等目录在同一层级",
				),
			capWeight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe(
					"资金占比 0-1，如 1=100%，0.5=50%。不传则重置为 0（安全默认）",
				),
			isolate: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"是否自动隔离同组旧策略。true 时，若 backtest_name 形如 xxx_vN，会移除所有名称以 xxx_ 开头的旧策略。",
				),
		},
		async ({ configFilePath, capWeight, isolate }) => {
			try {
				// 策略导入可能涉及 Python 解析和文件复制，设置 60s 超时
				const result = await post(
					"/mcp/strategy/import",
					{ configFilePath, capWeight, isolate },
					60_000,
				)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `导入策略失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"set_strategy_weight",
		"设置库内策略组的资金占比（0-1），支持三种用法（三选一）：name=单个组；names=多个组（同一 weight）；others_except=一键隔离（除列出的组外全部设为 weight，通常 0）。三层同步：客户端配置、界面 localStorage、real_market_25.json。pos 模式回测范围为全部 weight>0 策略的融合组合，回测某 variant 前应将其余策略组权重设为 0 以隔离回测范围。",
		{
			name: z
				.string()
				.optional()
				.describe("单个策略组名称（精确匹配，如 run-momentum-001_v1）"),
			names: z
				.array(z.string())
				.optional()
				.describe("多个策略组名称（批量设为同一 weight）"),
			others_except: z
				.array(z.string())
				.optional()
				.describe("一键隔离：除这些组外全部设为 weight（通常为 0）"),
			weight: z
				.number()
				.min(0)
				.max(1)
				.describe("资金占比 0-1，0=停用（跳过），1=100%"),
		},
		async ({ name, names, others_except, weight }) => {
			try {
				const body: Record<string, unknown> = { weight }
				if (name !== undefined) body.name = name
				if (names !== undefined) body.names = names
				if (others_except !== undefined) body.others_except = others_except
				const result = await post("/mcp/strategy/weight", body, 60_000)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `设置策略权重失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"list_library_strategies",
		"列出当前策略库（pos/select）内所有策略组的名称与资金占比。权重隔离前用此工具发现需要停用的策略组。",
		{},
		async () => {
			try {
				const result = await get("/mcp/strategy/library")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `列出库内策略失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"set_backtest_config",
		"设置回测配置。支持字段：initial_cash(初始资金)、start_date(开始日期YYYY-MM-DD)、end_date(结束日期，null表示今天)、filter_kcb(过滤科创板0/1)、filter_cyb(过滤创业板0/1)、filter_bj(过滤北交所0/1)。非白名单字段会被拒绝。",
		{
			initial_cash: z.number().optional().describe("初始资金（如 1000000）"),
			start_date: z.string().optional().describe("回测开始日期 YYYY-MM-DD"),
			end_date: z
				.string()
				.nullable()
				.optional()
				.describe("回测结束日期 YYYY-MM-DD，null 表示今天"),
			filter_kcb: z
				.string()
				.optional()
				.describe("是否过滤科创板: 0=不过滤, 1=过滤"),
			filter_cyb: z
				.string()
				.optional()
				.describe("是否过滤创业板: 0=不过滤, 1=过滤"),
			filter_bj: z
				.string()
				.optional()
				.describe("是否过滤北交所: 0=不过滤, 1=过滤"),
		},
		async (params) => {
			try {
				// 过滤掉 undefined 字段，避免发送未设置的参数
				const body: Record<string, unknown> = {}
				for (const [key, value] of Object.entries(params)) {
					if (value !== undefined) {
						body[key] = value
					}
				}
				const result = await put("/mcp/backtest/config", body)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `设置回测配置失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_backtest_performance",
		"查询回测绩效指标，读取策略评价.csv。返回累积净值、年化收益、最大回撤、胜率、盈亏收益比等 18 项绩效指标。AI Agent 可据此判断策略好坏。需先执行 run_backtest 生成结果。注意：data.parsed 中 calmar_ratio 是「年化收益/最大回撤」（Calmar）的规范字段名，sharpe_ratio 为其历史误名兼兼容镜像，策略评价 18 项中并无真夏普率。",
		{},
		async () => {
			try {
				const result = await get("/mcp/backtest/performance")
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取回测绩效失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_backtest_equity_curve",
		"查询回测资金曲线，读取资金曲线.csv。返回每日净值、涨跌幅、回撤等数据。支持 step 参数抽样降采样以减少数据量（如 step=10 表示每10条取1条）。资金曲线可能包含数千条记录，建议设置 step=5~20。",
		{
			step: z
				.number()
				.optional()
				.describe(
					"抽样步长，每 N 条取 1 条。默认 1=全量。建议 5~20 减少数据量",
				),
		},
		async ({ step }) => {
			try {
				const stepQuery = step ? `?step=${step}` : ""
				const result = await get(`/mcp/backtest/equity-curve${stepQuery}`)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取资金曲线失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	// ============================================================
	// 策略开发闭环：文件管理 / 校验 / 评估 / 提交
	// ============================================================

	server.tool(
		"get_strategy_workspace_root",
		"获取策略工作区的绝对路径。Agent 在调用 write_strategy_file 后，可用此路径拼接 import_strategy 所需的 configFilePath 绝对路径。",
		{},
		async () => {
			try {
				const root = getWorkspaceRoot()
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ workspaceRoot: root }, null, 2),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取工作区根目录失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	// 策略文件管理
	server.tool(
		"list_strategies",
		"列出策略工作区下的所有 run 和 variant；不传 runId 时附带 runStatus（各已关闭 run 的 status/closeReason）",
		{
			runId: z.string().optional().describe("可选：指定 run ID"),
		},
		async ({ runId }) => {
			try {
				if (runId) {
					const variants = listVariants(runId)
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ runId, variants }, null, 2),
							},
						],
					}
				}
				const runs = listRuns()
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ runs, runStatus: getRunStatuses() },
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `列出策略失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"read_strategy_file",
		"读取指定策略文件内容",
		{
			runId: z.string().describe("Run ID"),
			variantId: z.string().describe("Variant ID，例如 v1"),
			filename: z.string().describe("文件名，例如 config.py"),
		},
		async ({ runId, variantId, filename }) => {
			try {
				const content = readStrategyFile(runId, variantId, filename)
				return {
					content: [{ type: "text", text: content }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `读取失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"write_strategy_file",
		"写入策略文件内容",
		{
			runId: z.string().describe("Run ID"),
			variantId: z.string().describe("Variant ID，例如 v1"),
			filename: z.string().describe("文件名，例如 config.py"),
			content: z.string().describe("文件内容"),
		},
		async ({ runId, variantId, filename, content }) => {
			try {
				writeStrategyFile(runId, variantId, filename, content)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ success: true, path: `${runId}/${variantId}/${filename}` },
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `写入失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"write_factor_file",
		"写入自定义因子文件。kind=factor 时写 因子库/<category>/<factorName>.py（category 必填）；kind=cross_factor 时写 截面因子库/[category/]<factorName>.py（category 可选）。自动补 __init__.py。写入前强制静态检查：时序因子仅允许 pandas/numpy/math 等纯计算库与 add_factor/fin_cols 接口；截面因子额外要求 ov_cols、放宽 core/scipy 导入。禁止 os/sys/subprocess/网络/IO/exec/eval 等。检查不通过则拒绝写入。",
		{
			runId: z.string().describe("Run ID"),
			variantId: z.string().describe("Variant ID，例如 v1"),
			kind: z
				.enum(["factor", "cross_factor"])
				.optional()
				.default("factor")
				.describe("因子类型：factor=时序因子，cross_factor=截面因子"),
			category: z
				.string()
				.optional()
				.describe(
					"因子类目（如 动量、波动、规模）。kind=factor 时必填；cross_factor 时可选（缺省平铺）",
				),
			factorName: z.string().describe("因子名（如 动量5，不含 .py 后缀）"),
			content: z
				.string()
				.describe(
					"因子源码（须含 fin_cols 与 add_factor；截面因子还须含 ov_cols）",
				),
		},
		async ({ runId, variantId, kind, category, factorName, content }) => {
			try {
				if (kind === "factor" && !category) {
					return {
						content: [
							{
								type: "text",
								text: "写入因子失败: kind=factor 时 category 必填（类目，如 动量）",
							},
						],
						isError: true,
					}
				}
				const check = checkFactorSource(content, kind)
				if (!check.ok) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: false,
										reason: "因子静态检查未通过，未写入",
										errors: check.errors,
										warnings: check.warnings,
									},
									null,
									2,
								),
							},
						],
						isError: true,
					}
				}
				const filePath = writeFactorFile(
					runId,
					variantId,
					category,
					factorName,
					content,
					kind,
				)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									path: filePath,
									warnings: check.warnings,
									interface: check.interface,
								},
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `写入因子失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"validate_strategy",
		"校验 config.py 策略配置是否合法",
		{
			configFilePath: z.string().describe("config.py 的绝对路径"),
		},
		async ({ configFilePath }) => {
			try {
				const result = validateStrategy(configFilePath)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `校验失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"evaluate_backtest",
		"根据阈值评估多次回测结果，返回最优 variant。指标口径：calmar_ratio = 年化收益/最大回撤（Calmar），sharpe_ratio 为其历史误名，两者可混用但输出统一为 calmar_ratio。最优选择语义：先比达标率 score，同分比年化收益，再同分比复杂度（低优先），全部相同保留先出现者。",
		{
			performances: z.array(
				z.object({
					variantId: z.string(),
					annual_return_pct: z.number().optional(),
					max_drawdown_pct: z.number().optional(),
					calmar_ratio: z.number().optional(),
					sharpe_ratio: z
						.number()
						.optional()
						.describe("已废弃别名，等同 calmar_ratio"),
					win_rate_pct: z.number().optional(),
					profit_loss_ratio: z.number().optional(),
					complexity: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("旋钮计数，同分时低复杂度优先（防过拟合）"),
				}),
			),
			thresholds: z.object({
				annual_return_pct: z.number().optional(),
				max_drawdown_pct: z.number().optional(),
				calmar_ratio: z.number().optional(),
				sharpe_ratio: z
					.number()
					.optional()
					.describe("已废弃别名，等同 calmar_ratio"),
				win_rate_pct: z.number().optional(),
				profit_loss_ratio: z.number().optional(),
			}),
		},
		async ({ performances, thresholds }) => {
			try {
				const result = evaluateBacktest(performances, thresholds)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `评估失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"compare_backtest_variants",
		'对比多个 variant 的回测绩效，按阈值返回最优 variant（score→年化→复杂度语义，与 evaluate_backtest 一致）。指标来源：trace.jsonl 有带 metrics 的 dev 记录时优先取最近一次 dev 条目（walkforward 最劣窗口口径，与 get_run_summary 的 SOTA 一致，标注 source="trace"）；无记录才回退读 策略评价.csv（内核按名覆盖写的残留口径，标注 source="csv"）。返回 performances/evaluation/errors/validationWarnings（config 校验未通过时对外可见）。指标中的 calmar_ratio 为「年化收益/回撤比」口径，sharpe_ratio 是其兼容镜像。',
		{
			runId: z.string().describe("Run ID，例如 run-momentum-002"),
			variantIds: z
				.array(z.string())
				.describe('需要对比的 variant ID 列表，例如 ["v1", "v2"]'),
			thresholds: z.object({
				annual_return_pct: z.number().optional(),
				max_drawdown_pct: z.number().optional(),
				calmar_ratio: z.number().optional(),
				sharpe_ratio: z
					.number()
					.optional()
					.describe("已废弃别名，等同 calmar_ratio"),
				win_rate_pct: z.number().optional(),
				profit_loss_ratio: z.number().optional(),
			}),
			quantDataPath: z
				.string()
				.optional()
				.describe(
					"QuantData 根目录，默认读取环境变量 ALL_DATA_PATH 或 D:/QuantClassSpace/QuantData",
				),
		},
		async ({ runId, variantIds, thresholds, quantDataPath }) => {
			try {
				const { performances, errors, validationWarnings } =
					resolveVariantPerformances(runId, variantIds, quantDataPath)
				const evaluation = evaluateBacktest(performances, thresholds)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									performances,
									evaluation,
									errors: errors.length > 0 ? errors : undefined,
									validationWarnings:
										validationWarnings.length > 0
											? validationWarnings
											: undefined,
								},
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `对比失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"submit_strategy_for_review",
		"生成候选策略报告并等待人工确认。可选 oosEvaluation/oosWindow/oosNote 附带样本外验证结果，报告将并排展示样本内与样本外对照。",
		{
			runId: z.string().describe("Run ID"),
			variantId: z.string().describe("Variant ID"),
			evaluation: z.object({
				passed: z.boolean(),
				score: z.number(),
				details: z.record(
					z.object({
						value: z.number(),
						threshold: z.number().optional(),
						passed: z.boolean(),
					}),
				),
			}),
			strategyPath: z.string().describe("策略文件路径"),
			summary: z.string().describe("策略说明摘要"),
			oosWindow: z
				.string()
				.optional()
				.describe("样本外验证窗口描述（如 2025-01-01 至今）"),
			oosEvaluation: z
				.object({
					passed: z.boolean(),
					score: z.number(),
					details: z.record(
						z.object({
							value: z.number(),
							threshold: z.number().optional(),
							passed: z.boolean(),
						}),
					),
				})
				.optional()
				.describe("样本外评估结果（与 evaluation 同构）"),
			oosNote: z
				.string()
				.optional()
				.describe("样本外评估结论（余量规则的文字判断）"),
		},
		async (params) => {
			try {
				const { reportPath, report } = submitForReview(
					getWorkspaceRoot(),
					params,
				)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ reportPath, report }, null, 2),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `生成报告失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	// ============================================================
	// 研究工作流：run / trace / 总结（RDAgent 风格进化循环）
	// ============================================================

	server.tool(
		"create_research_run",
		"创建研究 run：在工作区写入 brief.json（研究目标、达标阈值、回测区间、进化轮数；可选 walkforward 多窗口配置，配置后 dev 实验强制走 run_dev_walkforward 最劣窗口口径）。runId 已存在则报错，不会覆盖。brief 含 backtest 窗口时会自动同步到客户端回测配置（响应含 configSync；客户端不可达时降级为 warning，不影响 run 创建）。",
		{
			runId: z.string().describe("Run ID，例如 run-momentum-001"),
			brief: researchBriefSchema.describe("研究任务书"),
		},
		async ({ runId, brief }) => {
			try {
				const result = createResearchRun(runId, brief)
				const response: Record<string, unknown> = { ...result }
				// brief.backtest 自动同步到客户端回测配置，避免首轮回测用错窗口/股票池；
				// 客户端不可达时降级为 warning，run 已创建不回滚
				if (result.brief.backtest) {
					try {
						const putResp = (await put(
							"/mcp/backtest/config",
							backtestWindowToConfigBody(result.brief.backtest),
						)) as Record<string, unknown>
						response.configSync = {
							applied: true,
							updated: (putResp?.data as Record<string, unknown> | undefined)
								?.updated,
						}
					} catch (error) {
						response.configSync = {
							applied: false,
							error: error instanceof Error ? error.message : String(error),
						}
						response.warning =
							"brief.backtest 配置同步失败（客户端不可达？），请手动 set_backtest_config 校正"
					}
				}
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `创建研究 run 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"record_experiment",
		"记录一次实验到 run 的 trace.jsonl（假设、变更、绩效、评估、结论、教训）。ts 缺省时自动填当前时间。fromLatestBacktest=true 时自动把最近一次回测的绩效数值填入 metrics（缺省时）、并把内核版本填入 kernelVersion（缺省时），避免手工誊抄。verdict 缺省时自动判定（validation 条目→completed；无 metrics/evaluation→failed；成为当前最优→sota，否则 completed）；complexity 缺省时自动从 variant 的 config.py 统计旋钮数；entry.type 支持 dev（默认，计入迭代预算与 SOTA）/ validation（终局样本外验证，不进 SOTA 与趋势）。brief 含 evolving_n 时响应附带 budget（used/remaining）；迭代预算是硬闸门——dev 条目达 evolving_n 上限后写入前直接报错（提示 close_run 或提高预算），validation 条目不受限。指标口径：calmar_ratio 为规范名，sharpe_ratio 是兼容别名。注意：brief 配置 walkforward 后，带绩效的 dev 条目必须经 run_dev_walkforward 写入（含分窗口明细），本工具仅放行无绩效的失败记录。entry 新增可选字段：basedOn（分叉父 variantId）、hypothesisSource（假设来源引用，推荐 knowledge:<id>/trace:<runId>/<variantId>）、nextHypothesis（预埋下一轮假设种子）。lesson 传占位文本（待回填/TBD 等）会被拒绝；假设与历史高度相似时返回 warnings（不阻断）。",
		{
			runId: z.string().describe("Run ID"),
			entry: experimentEntrySchema.describe("实验记录"),
			fromLatestBacktest: z
				.boolean()
				.optional()
				.describe(
					"true 时自动抓取最近一次回测绩效到 metrics、内核版本到 kernelVersion（仅在对应字段缺省时生效）",
				),
		},
		async ({ runId, entry, fromLatestBacktest }) => {
			try {
				const merged: Record<string, unknown> = { ...entry }
				if (fromLatestBacktest) {
					if (merged.metrics === undefined) {
						const perf = (await get("/mcp/backtest/performance")) as Record<
							string,
							unknown
						>
						const parsed = (perf?.data as Record<string, unknown>)?.parsed
						if (!parsed || typeof parsed !== "object") {
							return {
								content: [
									{
										type: "text",
										text: "记录实验失败: fromLatestBacktest=true 但最近一次回测无绩效数据（请先成功执行 run_backtest）",
									},
								],
								isError: true,
							}
						}
						merged.metrics = parsed
					}
					if (merged.kernelVersion === undefined) {
						merged.kernelVersion = lastBacktestInfo?.kernelVersion
					}
				}
				const result = recordExperiment(runId, merged)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `记录实验失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_experiment_trace",
		"读取 run 的实验 trace（trace.jsonl）。tail=N 时只返回最近 N 条以控制上下文体积。",
		{
			runId: z.string().describe("Run ID"),
			tail: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("只返回最近 N 条记录"),
		},
		async ({ runId, tail }) => {
			try {
				const result = getExperimentTrace(runId, tail)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `读取实验 trace 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_run_summary",
		"汇总 run 的实验情况：实验总数、各 verdict 计数、当前 SOTA、距阈值差距、各指标趋势。",
		{
			runId: z.string().describe("Run ID"),
		},
		async ({ runId }) => {
			try {
				const result = getRunSummary(runId)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `汇总 run 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"record_knowledge",
		"记录一条跨 run 知识到 workspace 级 knowledge.jsonl（旋钮级实验发现的结构化沉淀，只增不改）。证据链 evidence 必填。负面发现（旋钮恶化）同样值得记录。",
		{
			knob: z.string().describe("旋钮/组件标识，如 波动.波动率20 过滤阈值"),
			change: z.string().describe("做了什么变更，如 pct:<=0.25 → 0.20"),
			effect: z
				.string()
				.describe("效果（含方向与幅度），如 最劣窗口回撤 -0.1pp，年化 +0.19pp"),
			evidence: z
				.array(
					z.object({
						runId: z.string(),
						from: z.string().optional(),
						to: z.string().optional(),
					}),
				)
				.describe("证据链，如 [{runId:'run-calmar-001',from:'v3',to:'v5'}]"),
			regime: z.string().optional().describe("生效/失效的市场环境"),
			tags: z.array(z.string()).optional(),
		},
		async (args) => {
			try {
				const result = recordKnowledge(args)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `记录知识失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_knowledge",
		"读取跨 run 知识库（knowledge.jsonl）。knobFilter 按旋钮名子串过滤。Researcher 提假设前必须先调用本工具。",
		{
			knobFilter: z.string().optional().describe("按旋钮名子串过滤"),
		},
		async ({ knobFilter }) => {
			try {
				const result = getKnowledge(knobFilter)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `读取知识库失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"close_run",
		"关闭研究 run 并记录关闭决策（写入 brief.json 的 status/closedAt/closeReason）。status: achieved（要求存在 SOTA）/ abandoned / paused。已关闭的 run 默认拒绝再次关闭（幂等保护），确需改判时显式传 force=true，响应回显被覆盖的 previousStatus/previousCloseReason。循环退出后必须调用本工具，杜绝烂尾 run。",
		{
			runId: z.string().describe("Run ID"),
			status: z.enum(["achieved", "abandoned", "paused"]).describe("关闭状态"),
			reason: z.string().describe("关闭原因（必填，一句话）"),
			force: z
				.boolean()
				.optional()
				.describe("已关闭的 run 再次关闭（改判）时显式传 true"),
		},
		async ({ runId, status, reason, force }) => {
			try {
				const result = closeRun(runId, status, reason, force)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `关闭 run 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"list_factor_components",
		"枚举 real_trading 因子库/截面因子库的可用组件（类目 → 因子名列表）。提假设前用于确认因子真实存在，避免假设落到不存在的组件上。",
		{},
		async () => {
			try {
				const result = listFactorComponents()
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `枚举因子组件失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_backtest_diagnostics",
		"回测诊断：基于当前回测的资金曲线计算分年度收益与回撤区间（峰值/谷底/深度/修复日期/持续天数），用于撰写实验 lesson 时的归因分析（例如「过滤砍掉了哪段收益」）。数据来自最近一次回测产物（资金曲线.csv），无需重新回测。",
		{
			topN: z
				.number()
				.int()
				.positive()
				.max(10)
				.optional()
				.describe("返回最深的 N 段回撤，默认 3"),
		},
		async ({ topN }) => {
			try {
				const result = (await get(
					"/mcp/backtest/equity-curve?step=1",
					60_000,
				)) as Record<string, unknown>
				const rows = (result?.data ?? []) as Array<Record<string, unknown>>
				const points = parseEquityRows(rows)
				if (points.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "资金曲线为空或无法解析，请先执行回测",
							},
						],
						isError: true,
					}
				}
				const payload = {
					tradingDays: points.length,
					span: {
						start: points[0].date,
						end: points[points.length - 1].date,
					},
					yearlyReturns: computeYearlyReturns(points),
					drawdownEpisodes: computeDrawdownEpisodes(points, topN ?? 3),
				}
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `诊断失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"run_validation",
		"启动 validation 闸门：读取 run 的 brief.validation 窗口，校验当前回测策略与待验证 variant 一致 → 快照当前回测配置 → 切换到 validation 窗口 → 启动异步回测（返回 taskId，用 get_backtest_task 轮询）。回测成功后必须调用 complete_validation 恢复原配置并记录样本外结果。brief 未定义 validation 窗口、或已有进行中的 validation 时报错。",
		{
			runId: z.string().describe("Run ID"),
			variantId: z
				.string()
				.optional()
				.describe(
					"待验证的 variant ID（缺省取当前 SOTA）。当前回测策略与期望不一致时报错，防止样本外验证跑在错误策略上",
				),
		},
		async ({ runId, variantId }) => {
			try {
				const brief = getResearchBrief(runId)
				if (!brief) {
					throw new Error(`run 不存在或无 brief.json: ${runId}`)
				}
				if (readValidationState(runId)) {
					throw new Error(
						`已有进行中的 validation（runId=${runId}），请先 complete_validation`,
					)
				}
				const window = buildValidationWindow(brief)
				const configResp = (await get("/mcp/backtest/config")) as Record<
					string,
					unknown
				>
				const prior = (configResp?.data ?? {}) as Record<string, unknown>

				// 校验当前回测策略是否为待验证 variant（缺省取 SOTA），
				// 防止忘记 import_strategy 时样本外验证静默跑在旧策略上
				const expectedVariantId =
					variantId ?? getRunSummary(runId).sota?.variantId
				let variantWarning: string | undefined
				if (expectedVariantId) {
					let expectedName = `${runId}_${expectedVariantId}`
					try {
						const configPath = join(
							getWorkspaceRoot(),
							runId,
							expectedVariantId,
							"config.py",
						)
						if (existsSync(configPath)) {
							const validation = validateStrategy(configPath)
							expectedName =
								(validation.extracted?.backtest_name as string) || expectedName
						}
					} catch {
						// 配置读取/解析失败时回退默认命名比对
					}
					const currentName =
						typeof prior.backtestName === "string" ? prior.backtestName : ""
					if (currentName !== expectedName) {
						throw new Error(
							`当前回测策略为 ${currentName || "(未设置)"}，与待验证 variant 期望的 ${expectedName} 不一致；请先 import_strategy(<config 路径>) 并设置权重后再 run_validation`,
						)
					}
				} else {
					variantWarning =
						"无法确定待验证 variant（无 SOTA 且未传 variantId），请确认当前回测策略即为目标策略"
				}

				await put("/mcp/backtest/config", window)
				let taskId: string
				try {
					const runResp = (await post(
						"/mcp/backtest/run-async",
						undefined,
						60_000,
					)) as Record<string, unknown>
					taskId = (runResp?.data as Record<string, unknown>)?.taskId as string
					if (!taskId) throw new Error("run-async 未返回 taskId")
				} catch (error) {
					// 回测启动失败：立即恢复原配置，不留半截状态
					await put(
						"/mcp/backtest/config",
						priorConfigToRestoreBody(prior),
					).catch(() => {})
					throw error
				}
				saveValidationState(runId, {
					taskId,
					startedAt: new Date().toISOString(),
					priorConfig: prior,
				})
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									taskId,
									validationWindow: window,
									priorConfigSaved: true,
									validatedVariantId: expectedVariantId,
									warning: variantWarning,
									next: "用 get_backtest_task 轮询；成功后调用 complete_validation 恢复原配置并记录样本外结果",
								},
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `启动 validation 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"complete_validation",
		"完成 validation 闸门：恢复 run_validation 之前的回测配置（无论记录是否成功都会恢复），并按需把最近一次回测（validation 窗口）绩效记录为 type=validation 的 trace 条目（不进 SOTA/趋势、不消耗迭代预算，自动按 brief.thresholds 评估）。要求在 run_validation 之后、确认回测任务成功后调用。",
		{
			runId: z.string().describe("Run ID"),
			variantId: z
				.string()
				.describe("被验证的 variant ID（通常为 dev 阶段 SOTA）"),
			record: z.boolean().optional().describe("是否记录 trace 条目，默认 true"),
			hypothesis: z
				.string()
				.optional()
				.describe("缺省填「validation 窗口样本外验证」"),
			lesson: z.string().optional().describe("样本外结论"),
		},
		async ({ runId, variantId, record, hypothesis, lesson }) => {
			try {
				const state = readValidationState(runId)
				if (!state) {
					throw new Error(
						`没有进行中的 validation（runId=${runId}），请先 run_validation`,
					)
				}
				// 先恢复原配置：即使后续记录失败，配置也不应停留在 validation 窗口
				await put(
					"/mcp/backtest/config",
					priorConfigToRestoreBody(state.priorConfig),
				)
				let recorded: unknown = null
				if (record !== false) {
					const brief = getResearchBrief(runId)
					const perf = (await get("/mcp/backtest/performance")) as Record<
						string,
						unknown
					>
					const parsed = (perf?.data as Record<string, unknown>)?.parsed as
						| Record<string, number>
						| undefined
					if (!parsed) {
						throw new Error(
							"未读到 validation 回测绩效（配置已恢复）。请确认回测任务成功后重试",
						)
					}
					let evaluation: { passed: boolean; score: number } | undefined
					if (brief) {
						const r = evaluateBacktest(
							[{ variantId, ...parsed }],
							brief.thresholds,
						)
						evaluation = { passed: r.passed, score: r.score }
					}
					recorded = recordExperiment(runId, {
						variantId,
						hypothesis: hypothesis ?? "validation 窗口样本外验证",
						type: "validation",
						metrics: parsed,
						evaluation,
						lesson,
					})
				}
				clearValidationState(runId)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									restored: true,
									restoredConfig: priorConfigToRestoreBody(state.priorConfig),
									recorded,
								},
								null,
								2,
							),
						},
					],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `完成 validation 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	console.log("[mcp-server] MCP tools registered successfully")
}
