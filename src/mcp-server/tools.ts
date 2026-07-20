/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
	type BacktestPerformance,
	evaluateBacktest,
	performanceCsvToMetrics,
} from "./backtest-evaluator.js"
import { get, post, put } from "./client.js"
import {
	createResearchRun,
	experimentEntrySchema,
	getExperimentTrace,
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
	writeStrategyFile,
} from "./strategy-files.js"
import { validateStrategy } from "./strategy-validator.js"

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
		"执行策略回测。根据当前策略库类型自动选择内核（选股→aqua，仓位管理→zeus）。回测是长耗时操作（可能几分钟到几十分钟），会阻塞直到回测完成。回测期间不能同时运行实盘。建议在非交易时段使用。",
		{},
		async () => {
			try {
				// 回测是长耗时操作，设置 30 分钟超时
				const result = await post("/mcp/backtest/run", undefined, 1_800_000)
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
		"设置库内策略组的资金占比（0-1）。三层同步：客户端配置、界面 localStorage、real_market_25.json（zeus 回测实际读取的策略注册表）。pos 模式回测范围为全部 weight>0 策略的融合组合，回测某 variant 前应将其余策略组权重设为 0 以隔离回测范围。",
		{
			name: z
				.string()
				.describe("策略组名称（精确匹配，如 run-momentum-001_v1）"),
			weight: z
				.number()
				.min(0)
				.max(1)
				.describe("资金占比 0-1，0=停用（跳过），1=100%"),
		},
		async ({ name, weight }) => {
			try {
				const result = await post(
					"/mcp/strategy/weight",
					{ name, weight },
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
							text: `设置策略权重失败: ${error instanceof Error ? error.message : String(error)}`,
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
		"查询回测绩效指标，读取策略评价.csv。返回累积净值、年化收益、最大回撤、胜率、盈亏收益比等 18 项绩效指标。AI Agent 可据此判断策略好坏。需先执行 run_backtest 生成结果。",
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
		"列出策略工作区下的所有 run 和 variant",
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
					content: [{ type: "text", text: JSON.stringify({ runs }, null, 2) }],
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
		"根据阈值评估多次回测结果，返回最优 variant",
		{
			performances: z.array(
				z.object({
					variantId: z.string(),
					annual_return_pct: z.number().optional(),
					max_drawdown_pct: z.number().optional(),
					sharpe_ratio: z.number().optional(),
					win_rate_pct: z.number().optional(),
					profit_loss_ratio: z.number().optional(),
				}),
			),
			thresholds: z.object({
				annual_return_pct: z.number().optional(),
				max_drawdown_pct: z.number().optional(),
				sharpe_ratio: z.number().optional(),
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
		"读取多个 variant 的策略评价 CSV，按阈值对比并返回最优 variant。",
		{
			runId: z.string().describe("Run ID，例如 run-momentum-002"),
			variantIds: z
				.array(z.string())
				.describe('需要对比的 variant ID 列表，例如 ["v1", "v2"]'),
			thresholds: z.object({
				annual_return_pct: z.number().optional(),
				max_drawdown_pct: z.number().optional(),
				sharpe_ratio: z.number().optional(),
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
				const dataRoot =
					quantDataPath ||
					process.env.ALL_DATA_PATH ||
					"D:/QuantClassSpace/QuantData"
				const workspaceRoot = getWorkspaceRoot()
				const performances: BacktestPerformance[] = []
				const errors: string[] = []

				for (const variantId of variantIds) {
					const configPath = join(workspaceRoot, runId, variantId, "config.py")
					if (!existsSync(configPath)) {
						errors.push(`config.py 不存在: ${variantId}`)
						continue
					}
					const validation = validateStrategy(configPath)
					const backtestName =
						(validation.extracted?.backtest_name as string) ||
						`${runId}_${variantId}`
					const csvPath = join(
						dataRoot,
						"real_trading",
						"data",
						"回测结果",
						backtestName,
						"策略评价.csv",
					)
					if (!existsSync(csvPath)) {
						errors.push(`策略评价.csv 不存在: ${variantId} (${backtestName})`)
						continue
					}
					const csvText = readFileSync(csvPath, "utf-8")
					performances.push(performanceCsvToMetrics(variantId, csvText))
				}

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
		"生成候选策略报告并等待人工确认",
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
		"创建研究 run：在工作区写入 brief.json（研究目标、达标阈值、回测区间、进化轮数）。runId 已存在则报错，不会覆盖。",
		{
			runId: z.string().describe("Run ID，例如 run-momentum-001"),
			brief: researchBriefSchema.describe("研究任务书"),
		},
		async ({ runId, brief }) => {
			try {
				const result = createResearchRun(runId, brief)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
		"记录一次实验到 run 的 trace.jsonl（假设、变更、绩效、评估、结论、教训）。ts 缺省时自动填当前时间。",
		{
			runId: z.string().describe("Run ID"),
			entry: experimentEntrySchema.describe("实验记录"),
		},
		async ({ runId, entry }) => {
			try {
				const result = recordExperiment(runId, entry)
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

	console.log("[mcp-server] MCP tools registered successfully")
}
