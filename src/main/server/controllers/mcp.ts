/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import fs from "node:fs"
import path from "node:path"
import {
	getBuyInfoList,
	getBuyTimingInfoList,
	getJsonDataFromFile,
	getSellInfoList,
	getSellTimingInfoList,
} from "@/main/core/dataList.js"
import windowManager from "@/main/lib/WindowManager.js"
import { execBin } from "@/main/lib/process.js"
import {
	setAutoMinData,
	setAutoTrading,
	setAutoUpdate,
	systemState,
} from "@/main/lib/scheduler.js"
import { parsePythonConfig } from "@/main/pythonRunner.js"
import storeApi, { rStore, store } from "@/main/store/index.js"
import { getMcpToken } from "@/main/utils/tools.js"
import {
	LIBRARY_TYPE,
	POS_MGMT_STRATEGY_CONFIG,
	SELECT_STOCK_STRATEGY_CONFIG,
} from "@/shared/constants.js"
import { parse } from "csv-parse/sync"
import type { Context, MiddlewareHandler } from "hono"
import { Hono } from "hono"
import type { Env } from "../types/index.js"

const mcpRouter = new Hono<Env>()

/**
 * MCP 鉴权中间件：校验 Authorization: Bearer <token>。
 *
 * - /mcp/status 为只读状态接口，供应用内 UI 探测，豁免鉴权
 * - 其余路由（toggle/exec/config）均需携带有效 token
 * - token 由主进程在 Hono 启动时生成，写入 ~/.quantclass/mcp-token
 */
const mcpAuth: MiddlewareHandler<Env> = async (c, next) => {
	// 只读状态接口豁免，供应用内探测使用
	if (c.req.path.endsWith("/status")) {
		await next()
		return undefined
	}
	const token = getMcpToken()
	if (!token) {
		return c.json({ code: 500, message: "MCP 鉴权 token 尚未就绪" }, 500)
	}
	const auth = c.req.header("Authorization")
	if (auth !== `Bearer ${token}`) {
		return c.json({ code: 401, message: "未授权：无效或缺失的 MCP token" }, 401)
	}
	await next()
	return undefined
}

mcpRouter.use("*", mcpAuth)

/**
 * GET /mcp/status - 获取系统状态
 */
mcpRouter.get("/status", (c: Context) => {
	return c.json({
		code: 0,
		data: {
			isSetAutoUpdate: systemState.isSetAutoUpdate,
			isSetAutoTrading: systemState.isSetAutoTrading,
			isSetAutoMinData: systemState.isSetAutoMinData,
			minDataMode: systemState.minDataMode,
			minDataAccurate: systemState.minDataAccurate,
			minDataFuzzy: systemState.minDataFuzzy,
			isOnline: systemState.isOnline,
		},
		message: "ok",
	})
})

/**
 * POST /mcp/min-data/toggle - 开启/关闭实时数据定时任务
 */
mcpRouter.post("/min-data/toggle", async (c: Context) => {
	const body = await c.req.json()
	const { isOn, mode, autoAccurate, autoFuzzy } = body

	if (typeof isOn !== "boolean") {
		return c.json({ code: 400, message: "参数 isOn 必须为 boolean" }, 400)
	}

	setAutoMinData({ isOn, mode, autoAccurate, autoFuzzy })

	return c.json({
		code: 0,
		data: {
			isSetAutoMinData: systemState.isSetAutoMinData,
			minDataMode: systemState.minDataMode,
			minDataAccurate: systemState.minDataAccurate,
			minDataFuzzy: systemState.minDataFuzzy,
		},
		message: isOn ? "实时数据定时任务已开启" : "实时数据定时任务已关闭",
	})
})

/**
 * POST /mcp/min-data/exec - 手动执行一次数据获取
 *
 * 参数映射（与 scheduler.ts wakeUpMinData 保持一致）：
 * - type=fuzzy → execBin(["min_data_fuzzy"])
 * - type=accurate + mode=stable → execBin(["min_data", "thread"])
 * - type=accurate + mode=fast(默认) → execBin(["min_data"])
 */
mcpRouter.post("/min-data/exec", async (c: Context) => {
	const body = await c.req.json().catch(() => ({}))
	const { type, mode } = body as { type?: string; mode?: string }

	let args: string[]
	let action: string
	if (type === "fuzzy") {
		args = ["min_data_fuzzy"]
		action = "MCP手动获取模糊QMT数据"
	} else {
		args = mode === "stable" ? ["min_data", "thread"] : ["min_data"]
		action = `MCP手动获取准确QMT数据-${mode === "stable" ? "稳定" : "极速"}模式`
	}

	try {
		await execBin(args, action)
		return c.json({
			code: 0,
			data: { type: type ?? "accurate", mode: mode ?? "fast" },
			message: "实时数据获取已触发",
		})
	} catch (error) {
		return c.json(
			{
				code: 500,
				message: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
			},
			500,
		)
	}
})

/**
 * GET /mcp/config/trading - 读取交易配置
 *
 * 返回字段与 PUT 白名单保持一致；auto_real_trading 由独立的
 * toggle_auto_trading Tool 控制，不在此返回，避免 AI 客户端误用。
 */
mcpRouter.get("/config/trading", (c: Context) => {
	const config = {
		account_id: store.get("real_market_config.account_id", "0"),
		use_fuzzy: store.get("real_market_config.use_fuzzy", "1"),
		use_open_sell: store.get("real_market_config.use_open_sell", "0"),
	}

	return c.json({
		code: 0,
		data: config,
		message: "ok",
	})
})

/**
 * PUT /mcp/config/trading - 更新交易配置
 *
 * 仅允许更新白名单字段，非白名单字段会被拒绝并提示。
 */
mcpRouter.put("/config/trading", async (c: Context) => {
	const body = await c.req.json().catch(() => ({}))
	const allowedKeys = [
		"real_market_config.account_id",
		"real_market_config.use_fuzzy",
		"real_market_config.use_open_sell",
	]

	const updated: Record<string, unknown> = {}
	const rejected: string[] = []
	for (const [key, value] of Object.entries(body)) {
		if (allowedKeys.includes(key)) {
			store.set(key, value)
			updated[key] = value
		} else {
			rejected.push(key)
		}
	}

	return c.json({
		code: 0,
		data: { updated, rejected },
		message:
			rejected.length > 0
				? `部分字段被拒绝（不在白名单）: ${rejected.join(", ")}`
				: "交易配置已更新",
	})
})

/**
 * POST /mcp/trading/toggle - 开启/关闭自动交易
 */
mcpRouter.post("/trading/toggle", async (c: Context) => {
	const body = await c.req.json()
	const { isOn } = body

	if (typeof isOn !== "boolean") {
		return c.json({ code: 400, message: "参数 isOn 必须为 boolean" }, 400)
	}

	setAutoTrading(isOn)

	return c.json({
		code: 0,
		data: { isSetAutoTrading: systemState.isSetAutoTrading },
		message: isOn ? "自动交易已开启" : "自动交易已关闭",
	})
})

/**
 * POST /mcp/history-data/toggle - 开启/关闭历史数据自动更新
 */
mcpRouter.post("/history-data/toggle", async (c: Context) => {
	const body = await c.req.json()
	const { isOn } = body

	if (typeof isOn !== "boolean") {
		return c.json({ code: 400, message: "参数 isOn 必须为 boolean" }, 400)
	}

	setAutoUpdate(isOn)

	return c.json({
		code: 0,
		data: { isSetAutoUpdate: systemState.isSetAutoUpdate },
		message: isOn ? "历史数据自动更新已开启" : "历史数据自动更新已关闭",
	})
})

// ============================================================
// 第一优先级：交易数据查询（只读）
// ============================================================

/**
 * GET /mcp/trading/buy-signals - 查询实盘买入信号列表
 */
mcpRouter.get("/trading/buy-signals", async (c: Context) => {
	const data = await getBuyInfoList()
	return c.json({ code: 0, data, message: "ok" })
})

/**
 * GET /mcp/trading/sell-signals - 查询实盘卖出信号列表
 */
mcpRouter.get("/trading/sell-signals", async (c: Context) => {
	const data = await getSellInfoList()
	return c.json({ code: 0, data, message: "ok" })
})

/**
 * GET /mcp/trading/stock-timing-plans - 查询个股择时买入/卖出计划
 * Query: type=buy|sell (默认 buy)
 */
mcpRouter.get("/trading/stock-timing-plans", async (c: Context) => {
	const type = c.req.query("type") ?? "buy"
	const data =
		type === "sell"
			? await getSellTimingInfoList()
			: await getBuyTimingInfoList()
	return c.json({ code: 0, data, message: "ok" })
})

/**
 * GET /mcp/trading/account - 查询实盘账户信息（资金、持仓）
 */
mcpRouter.get("/trading/account", async (c: Context) => {
	const data = await getJsonDataFromFile(
		["real_trading", "rocket", "data", "account.json"],
		"获取账户信息失败",
	)
	return c.json({ code: 0, data, message: "ok" })
})

/**
 * GET /mcp/trading/info - 查询 Aqua 交易信息
 */
mcpRouter.get("/trading/info", async (c: Context) => {
	const data = await getJsonDataFromFile(
		["real_trading", "data", "trading_info.json"],
		"获取交易信息失败",
	)
	return c.json({ code: 0, data, message: "ok" })
})

// ============================================================
// 第一优先级：回测工具
// ============================================================

/**
 * GET /mcp/backtest/config - 查询回测配置
 *
 * 返回当前策略库类型（选股/仓位管理）、初始资金、起止日期、
 * 过滤板块（科创板/创业板/北交所）、策略名称。
 */
mcpRouter.get("/backtest/config", (c: Context) => {
	const libraryType = store.get(LIBRARY_TYPE, "select") as string
	const configKey =
		libraryType === "pos"
			? POS_MGMT_STRATEGY_CONFIG
			: SELECT_STOCK_STRATEGY_CONFIG

	const data = {
		libraryType,
		configKey,
		initialCash: store.get(`${configKey}.initial_cash`, 100000),
		startDate: store.get(`${configKey}.start_date`, ""),
		endDate: store.get(`${configKey}.end_date`, null),
		backtestName: store.get(`${configKey}.backtest_name`, "策略库"),
		filterKcb: store.get("real_market_config.filter_kcb", "0"),
		filterCyb: store.get("real_market_config.filter_cyb", "0"),
		filterBj: store.get("real_market_config.filter_bj", "0"),
	}

	return c.json({ code: 0, data, message: "ok" })
})

/**
 * POST /mcp/backtest/run - 执行策略回测
 *
 * 根据 libraryType 选择内核：选股→aqua，仓位管理→zeus。
 * 回测是长耗时操作（可能几分钟到几十分钟），请求会阻塞至回测完成。
 * 回测期间不能同时运行实盘。
 */
mcpRouter.post("/backtest/run", async (c: Context) => {
	const libraryType = store.get(LIBRARY_TYPE, "select") as string
	const kernel = libraryType === "pos" ? "zeus" : "aqua"

	const startedAt = Date.now()
	try {
		await execBin(["select"], "MCP策略回测", kernel)
	} catch (error) {
		return c.json(
			{
				code: 500,
				message: `回测失败: ${error instanceof Error ? error.message : String(error)}`,
			},
			500,
		)
	}

	// 内核异常（如因子缺失）也会以 exit 0 退出，仅凭进程退出码无法识别失败，
	// 必须校验本次回测已产出 策略评价.csv（存在且为本次运行所写）。
	const configKey =
		libraryType === "pos"
			? POS_MGMT_STRATEGY_CONFIG
			: SELECT_STOCK_STRATEGY_CONFIG
	const backtestName = store.get(
		`${configKey}.backtest_name`,
		"策略库",
	) as string
	const csvPath = await storeApi.getAllDataPath([
		"real_trading",
		"data",
		"回测结果",
		backtestName,
		"策略评价.csv",
	])
	if (!fs.existsSync(csvPath) || fs.statSync(csvPath).mtimeMs < startedAt) {
		return c.json(
			{
				code: 500,
				message: `回测未产出结果：内核可能执行失败（未见本次运行生成的 策略评价.csv），请检查 real_trading/logs/${kernel}.log 中的错误详情`,
			},
			500,
		)
	}

	return c.json({
		code: 0,
		data: { kernel, libraryType },
		message: "策略回测已完成",
	})
})

/**
 * GET /mcp/backtest/result - 查询回测选股结果
 *
 * 解析 real_trading/data/回测结果/{backtest_name}/最新选股结果.csv，
 * 返回选股日期、股票代码、目标资金占比、预计股数等字段。
 */
mcpRouter.get("/backtest/result", async (c: Context) => {
	try {
		const libraryType = store.get(LIBRARY_TYPE, "select") as string
		const configKey =
			libraryType === "pos"
				? POS_MGMT_STRATEGY_CONFIG
				: SELECT_STOCK_STRATEGY_CONFIG
		const backtestName = store.get(
			`${configKey}.backtest_name`,
			"策略库",
		) as string

		const filePath = await storeApi.getAllDataPath([
			"real_trading",
			"data",
			"回测结果",
			backtestName,
			"最新选股结果.csv",
		])

		if (!fs.existsSync(filePath)) {
			return c.json({
				code: 0,
				data: [],
				message: "回测结果文件不存在，请先执行回测",
			})
		}

		const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "")
		const records = parse(content, {
			columns: true,
			skip_empty_lines: true,
		})
		const data = JSON.parse(JSON.stringify(records))

		return c.json({
			code: 0,
			data,
			message: `成功读取 ${data.length} 条选股结果`,
		})
	} catch (error) {
		return c.json(
			{
				code: 500,
				message: `读取回测结果失败: ${error instanceof Error ? error.message : String(error)}`,
			},
			500,
		)
	}
})

// ============================================================
// 第二批次：策略开发闭环工具
// ============================================================

/**
 * GET /mcp/strategy/template - 返回 config.py 格式说明和策略库目录结构
 *
 * 供 AI Agent 了解如何编写策略文件和组织目录结构。
 */
mcpRouter.get("/strategy/template", async (c: Context) => {
	// 读取 real_trading/信号库 下的可用信号
	const signalDir = await storeApi.getAllDataPath(["real_trading", "信号库"])
	const availableSignals: string[] = []
	try {
		if (fs.existsSync(signalDir)) {
			for (const file of fs.readdirSync(signalDir)) {
				if (file.endsWith(".py") && !file.startsWith("__")) {
					availableSignals.push(file.replace(/\.py$/, ""))
				}
			}
		}
	} catch {
		// 忽略读取失败
	}

	const data = {
		configPyFormat: {
			description:
				"config.py 是策略入口文件，需放在策略根目录下。解析器通过 AST 提取顶层变量。",
			requiredVariables: {
				strategy_list:
					"策略列表，每个策略包含 name(名称)、cap_weight(资金占比)、hold_period(持仓周期)、select_num(选股数量)、offset_list(偏移列表)、rebalance_time(换仓时间)、factor_list(因子列表)、filter_list(过滤因子列表)、timing(择时配置)、buy_time(买入时间)、sell_time(卖出时间)、split_order_amount(拆单金额6000-12000)等字段",
				backtest_name:
					"策略名称，用于标识当前策略组合（如'小市值定3-2KDJ'）。建议同一系列 variant 命名为 xxx_v1/xxx_v2，以便 import_strategy 自动隔离旧版本。",
			},
			optionalVariables: {
				re_timing: "资金曲线再择时配置，可选",
			},
		},
		directoryStructure: {
			description:
				"config.py 所在目录下可包含以下子目录，导入时会复制到 real_trading/ 下。注意：因子库/信号库/截面因子库 的子目录下必须包含 __init__.py，否则 zeus 无法以模块方式导入。",
			dirs: {
				策略库: "策略 .py 文件目录（复制到 real_trading/策略库/）",
				因子库:
					"因子 .py 文件目录（复制到 real_trading/因子库/）。子目录必须含 __init__.py。",
				信号库:
					"择时信号 .py 文件目录（复制到 real_trading/信号库/）。子目录必须含 __init__.py。",
				外部数据: "外部数据文件（复制到 real_trading/外部数据/）",
				截面因子库:
					"截面因子 .py 文件目录（复制到 real_trading/截面因子库/）。子目录必须含 __init__.py。",
			},
		},
		timingExamples: {
			description:
				"择时配置分为 strategy-level 的 timing（开仓）/ override（离场）以及个股级别的 stock_timing_list。",
			availableSignals,
			notes: [
				"stock_timing_list 中的 period 目前通常使用 '1H'（小时线）。若使用 '1D'，需确保对应因子也按日线计算，否则会出现 kline 与因子行数不一致的错误。",
				"个股择时信号依赖信号库中的 .py 文件以及对应的因子（如 N日均价、N日最高收盘价等），需在 因子库 中提供。",
				"timing/override 字段结构参考: { name: '信号名', limit: number, factor_list: [...], params: any, signal_time?: string, recall_days?: number, fallback_position?: number }。",
			],
			stockTimingListExample: [
				{
					name: "个股择时_均线",
					factor_list: [["N日均价", true, 20, 1]],
					params: 0,
					weight: 1,
					period: "1H",
				},
			],
		},
		note: "导入时可通过 capWeight 参数设置资金占比（0-1，如 1=100%），不传则重置为 0（安全默认）。回测和实盘共享同一份 real_trading/ 目录下的策略文件。",
	}

	return c.json({ code: 0, data, message: "ok" })
})

/**
 * POST /mcp/strategy/import - 导入策略
 *
 * 根据 libraryType 自动选择导入方式：
 * - libraryType="select"（选股策略库）：解析 strategy_list，存 select_stock.* ，写 localStorage selectStockStrategy25
 * - libraryType="pos"（综合策略库）：解析 strategies/pos_strategy/strategy_list，存 pos_mgmt.*，写 localStorage fusion
 *
 * 自动检测导入类型（与 importFusionHandler 一致）：
 * - 有 strategies → fusion（综合策略）
 * - 有 pos_strategy → pos（仓位管理策略）
 * - 有 strategy_list → select（选股策略）
 *
 * 复制目录与原有逻辑完全一致，综合策略库额外复制"仓位管理"目录。
 * 通过 webContents.executeJavaScript 写入前端 localStorage 使界面同步更新。
 */
/**
 * 从 backtest_name 中提取 variant 分组前缀。
 * 例如 "小市值低波动选股策略_v9" -> "小市值低波动选股策略_"
 * 不匹配时返回 undefined，表示不自动隔离。
 */
function getStrategyGroupPrefix(name: string): string | undefined {
	const match = name.match(/^(.*_v)\d+$/)
	return match ? match[1] : undefined
}

mcpRouter.post("/strategy/import", async (c: Context) => {
	const body = await c.req.json().catch(() => ({}))
	const {
		configFilePath,
		capWeight,
		isolate = true,
	} = body as {
		configFilePath?: string
		capWeight?: number
		isolate?: boolean
	}

	if (!configFilePath) {
		return c.json({ code: 400, message: "参数 configFilePath 必填" }, 400)
	}

	// -- 检查 config.py 文件是否存在
	if (!fs.existsSync(configFilePath)) {
		return c.json(
			{ code: 400, message: `config.py 文件不存在: ${configFilePath}` },
			400,
		)
	}

	const libraryType = store.get(LIBRARY_TYPE, "select") as string

	// -- 解析 config.py（综合模式解析所有可能的变量，与 importFusionHandler 一致）
	const varNames =
		libraryType === "pos"
			? ["strategies", "pos_strategy", "strategy_list", "backtest_name"]
			: ["strategy_list", "backtest_name", "re_timing"]

	let parseResult: Record<string, unknown>
	try {
		parseResult = await parsePythonConfig(configFilePath, varNames)
	} catch (error) {
		return c.json(
			{
				code: 500,
				message: `解析 config.py 失败: ${error instanceof Error ? error.message : String(error)}`,
			},
			500,
		)
	}

	const backtestName = (parseResult.backtest_name as string) ?? "默认策略"

	// -- 自动检测导入类型和策略数据
	let importType: "fusion" | "pos" | "select"
	let strategyData: unknown

	if (parseResult.strategies) {
		importType = "fusion"
		strategyData = parseResult.strategies
	} else if (parseResult.pos_strategy) {
		importType = "pos"
		strategyData = parseResult.pos_strategy
	} else if (parseResult.strategy_list) {
		importType = "select"
		strategyData = parseResult.strategy_list
	} else {
		return c.json(
			{
				code: 400,
				message:
					"config.py 中未找到 strategies/pos_strategy/strategy_list 变量",
			},
			400,
		)
	}

	// -- 复制策略文件（路径与原有逻辑一致）
	const realTradingPath = await storeApi.getAllDataPath(["real_trading"], true)

	const copyFiles = (sourcePath: string, targetPath: string) => {
		if (fs.existsSync(targetPath)) {
			fs.rmSync(targetPath, { recursive: true, force: true })
		}
		fs.mkdirSync(targetPath, { recursive: true })
		const files = fs.readdirSync(sourcePath)
		for (const file of files) {
			const sourceFile = path.join(sourcePath, file)
			const targetFile = path.join(targetPath, file)
			if (fs.statSync(sourceFile).isDirectory()) {
				copyFiles(sourceFile, targetFile)
			} else {
				fs.copyFileSync(sourceFile, targetFile)
			}
		}
	}

	const rootPath = path.dirname(configFilePath)

	// -- 复制策略库/因子库/信号库/截面因子库/外部数据（与原有一致）
	const dirsToCopy: Array<[string, string]> = [
		["策略库", path.join(realTradingPath, "策略库")],
		["因子库", path.join(realTradingPath, "因子库")],
		["信号库", path.join(realTradingPath, "信号库")],
		["截面因子库", path.join(realTradingPath, "截面因子库")],
	]
	// 综合策略库额外复制"仓位管理"目录（与 importFusionHandler 一致）
	if (libraryType === "pos") {
		dirsToCopy.push(["仓位管理", path.join(realTradingPath, "仓位管理")])
	}
	// 外部数据复制到 real_trading/外部数据/（与原有一致）
	const externalDataTarget = await storeApi.getAllDataPath(
		["real_trading", "外部数据"],
		true,
	)
	dirsToCopy.push(["外部数据", externalDataTarget])

	const copiedDirs: string[] = []
	for (const [dirName, targetPath] of dirsToCopy) {
		const sourcePath = path.join(rootPath, dirName)
		if (fs.existsSync(sourcePath)) {
			copyFiles(sourcePath, targetPath)
			copiedDirs.push(dirName)
		}
	}

	// -- 保存 backtest_name 到正确的 store key（与前端一致）
	if (libraryType === "pos") {
		store.set("pos_mgmt.backtest_name", backtestName)
	} else {
		store.set("select_stock.backtest_name", backtestName)
		store.set("select_stock.re_timing", parseResult.re_timing ?? null)
	}

	// -- 计算资金占比：传入有效 capWeight 则使用，否则重置为 0（安全默认）
	const weight =
		typeof capWeight === "number" && capWeight >= 0 && capWeight <= 1
			? capWeight
			: 0

	// -- 将策略列表 cap_weight 设置为 weight（与前端一致，安全考虑）
	// 注意：顶层策略/策略组 cap_weight 统一设为 weight；嵌套在 group 内的
	// strategy_list 也应用 weight，保证 MCP 传入的 capWeight 能真正覆盖到
	// 写入 electron-store 的内核策略配置，而不是只影响前端展示。
	const resetCapWeight = (strategies: unknown): unknown => {
		if (Array.isArray(strategies)) {
			return strategies.map((item) => {
				if (item && typeof item === "object") {
					const obj = { ...item, cap_weight: weight }
					// 递归处理策略组/仓位管理中的子策略
					if ("strategy_list" in obj && Array.isArray(obj.strategy_list)) {
						obj.strategy_list = obj.strategy_list.map(
							(s: Record<string, unknown>) => ({
								...s,
								cap_weight: weight,
							}),
						)
					}
					if ("strategy_pool" in obj && Array.isArray(obj.strategy_pool)) {
						obj.strategy_pool = resetCapWeight(obj.strategy_pool)
					}
					return obj
				}
				return item
			})
		}
		return strategies
	}

	// -- 生成内核格式的选股策略信息（与 renderer/utils/strategy.ts genSelectStgInfo 一致）
	const genSelectStgInfoForKernel = (
		strategy: Record<string, unknown>,
		includeInfo = true,
	): Record<string, unknown> => {
		return {
			name: strategy.name,
			cap_weight: strategy.cap_weight,
			hold_period: strategy.hold_period,
			offset_list: strategy.offset_list,
			select_num: Number.parseInt(String(strategy.select_num)),
			factor_list: strategy.factor_list,
			filter_list: strategy.filter_list,
			...(strategy.filter_list_post !== undefined
				? { filter_list_post: strategy.filter_list_post }
				: {}),
			...(strategy.cross_sections !== undefined
				? { cross_sections: strategy.cross_sections }
				: {}),
			...(strategy.stock_timing_list !== undefined
				? { stock_timing_list: strategy.stock_timing_list }
				: {}),
			rebalance_time: strategy.rebalance_time,
			timing: strategy.timing ?? null,
			scalein_targets: strategy.scalein_targets ?? null,
			override: strategy.override ?? null,
			...(includeInfo ? { info: strategy.info ?? {} } : {}),
		}
	}

	// 综合策略库的 select 类型需要包装成策略组（与前端 import-btn.tsx 一致）
	let finalStrategies: unknown[]
	let kernelStrategies: unknown[] // 内核格式的策略列表，直接写入 electron-store
	const weightedStrategyData = resetCapWeight(strategyData) as Array<
		Record<string, unknown>
	>
	if (libraryType === "pos" && importType === "select") {
		finalStrategies = [
			{
				name: backtestName,
				type: "group",
				strategy_list: weightedStrategyData,
				cap_weight: weight,
				isFold: false,
			},
		]
		// 内核格式：group 包装 select 策略（与 saveStrategyListFusion group 分支一致）
		kernelStrategies = [
			{
				name: backtestName,
				cap_weight: weight,
				strategy_list: weightedStrategyData.map((s) =>
					genSelectStgInfoForKernel(s),
				),
				re_timing: parseResult.re_timing ?? null,
			},
		]
	} else if (libraryType === "pos" && importType === "pos") {
		finalStrategies = [resetCapWeight(strategyData)]
		// pos 类型策略的内核格式转换较复杂（含 strategy_pool 递归），暂用 finalStrategies
		kernelStrategies = finalStrategies
	} else if (libraryType === "pos" && importType === "fusion") {
		finalStrategies = resetCapWeight(strategyData) as unknown[]
		// fusion 类型策略的内核格式转换较复杂，暂用 finalStrategies
		kernelStrategies = finalStrategies
	} else {
		// 选股策略库（select）：扁平列表
		finalStrategies = weightedStrategyData
		// 内核格式：genSelectStgInfo(stg, false)，不含 info 字段
		kernelStrategies = weightedStrategyData.map((s) =>
			genSelectStgInfoForKernel(s, false),
		)
	}

	// -- 隔离同组旧 variant（自动替换 _vN 系列，避免 config.json 堆积导致内核报错）
	const groupPrefix = isolate ? getStrategyGroupPrefix(backtestName) : undefined
	const shouldRemove = (item: unknown) => {
		if (!groupPrefix || typeof item !== "object" || item === null) return false
		const name = (item as Record<string, unknown>).name
		return typeof name === "string" && name.startsWith(groupPrefix)
	}

	// -- 追加到 electron-store 中已有的策略列表（与前端 addFusionStrategies 语义一致）
	// 若开启 isolate，先移除同组旧策略，再追加新策略。
	const storeKey =
		libraryType === "pos" ? "pos_mgmt.strategies" : "select_stock.strategy_list"
	const existingStrategies = (store.get(storeKey, []) as unknown[]) ?? []
	const filteredStrategies = existingStrategies.filter(
		(item) => !shouldRemove(item),
	)
	const removedCount = existingStrategies.length - filteredStrategies.length
	const mergedKernelStrategies = [...filteredStrategies, ...kernelStrategies]
	store.set(storeKey, mergedKernelStrategies)
	const storeUpdated = true

	// -- 通过 executeJavaScript 将新策略追加到前端 localStorage，使界面同步更新
	const mainWindow = windowManager.getWindow()
	let localStorageUpdated = false
	if (mainWindow && !mainWindow.isDestroyed()) {
		try {
			const storageKey =
				libraryType === "pos" ? "fusion" : "selectStockStrategy25"
			const strategiesJson = JSON.stringify(finalStrategies)
			// 读取现有 localStorage 值，过滤同组旧策略后追加新策略
			const js = `
				(function() {
					var key = ${JSON.stringify(storageKey)};
					var existing = [];
					try {
						var raw = localStorage.getItem(key);
						if (raw) { existing = JSON.parse(raw); if (!Array.isArray(existing)) existing = []; }
					} catch (e) { existing = []; }
					var groupPrefix = ${JSON.stringify(groupPrefix)};
					var filtered = groupPrefix
						? existing.filter(function(item) { return !(item && item.name && typeof item.name === 'string' && item.name.startsWith(groupPrefix)); })
						: existing;
					var newArrival = JSON.parse(${JSON.stringify(strategiesJson)});
					var merged = filtered.concat(newArrival);
					var mergedJson = JSON.stringify(merged);
					localStorage.setItem(key, mergedJson);
					window.dispatchEvent(new StorageEvent('storage', { key: key, newValue: mergedJson }));
					return merged.length;
				})()
			`
			await mainWindow.webContents.executeJavaScript(js, true)
			localStorageUpdated = true
		} catch (error) {
			// executeJavaScript 失败不阻断导入，策略文件已复制成功
			console.error("[MCP] 写入 localStorage 失败:", error)
		}
	}

	return c.json({
		code: 0,
		data: {
			backtestName,
			importType,
			libraryType,
			capWeight: weight,
			copiedDirs,
			importedStrategies: finalStrategies,
			// 库内清单只返回名称与权重（全量策略定义体积可达数十 KB，
			// 会挤占 AI 客户端上下文；权重隔离场景只需要这两个字段）
			libraryStrategies: (
				mergedKernelStrategies as Array<Record<string, unknown>>
			).map((g) => ({ name: g?.name, cap_weight: g?.cap_weight })),
			strategyCount: mergedKernelStrategies.length,
			reTiming: parseResult.re_timing ?? null,
			localStorageUpdated,
			storeUpdated,
			isolate,
			removedCount,
		},
		message: `策略导入成功: ${backtestName}（类型: ${importType}，资金占比: ${(weight * 100).toFixed(1)}%，已复制: ${copiedDirs.join(", ") || "无"}，当前共 ${mergedKernelStrategies.length} 个策略${removedCount > 0 ? `，已隔离/替换 ${removedCount} 个同组旧策略` : ""}${storeUpdated ? "，配置已写入" : "，配置未写入"}${localStorageUpdated ? "，界面已同步" : "，界面未同步请刷新"}）`,
	})
})

/**
 * POST /mcp/strategy/weight - 设置策略资金占比
 *
 * 三层同步：config.json（electron-store）、renderer localStorage（界面与
 * 启动全量同步源）、real_market_25.json（zeus 实际读取的策略注册表）。
 * 注意：pos 模式回测范围为全部 weight>0 策略的融合组合，回测某个
 * variant 前应先用本接口将其余策略组权重设为 0。
 */
mcpRouter.post("/strategy/weight", async (c: Context) => {
	const body = await c.req.json().catch(() => ({}))
	const { name, weight } = body as { name?: string; weight?: number }

	if (!name || typeof name !== "string") {
		return c.json({ code: 400, message: "参数 name 必填（策略组名称）" }, 400)
	}
	if (typeof weight !== "number" || weight < 0 || weight > 1) {
		return c.json({ code: 400, message: "参数 weight 必须是 0-1 的数字" }, 400)
	}

	const libraryType = store.get(LIBRARY_TYPE, "select") as string
	const storeKey =
		libraryType === "pos" ? "pos_mgmt.strategies" : "select_stock.strategy_list"
	const list = (store.get(storeKey, []) as Array<Record<string, unknown>>) ?? []

	let matched = 0
	for (const item of list) {
		if (item?.name !== name) continue
		matched++
		item.cap_weight = weight
		if (Array.isArray(item.strategy_list)) {
			for (const s of item.strategy_list as Array<Record<string, unknown>>) {
				s.cap_weight = weight
			}
		}
	}

	if (matched === 0) {
		const available = list.map((i) => i?.name).filter(Boolean)
		return c.json(
			{
				code: 404,
				message: `未找到策略: ${name}，当前库内策略: ${available.join("、") || "（空）"}`,
			},
			404,
		)
	}

	store.set(storeKey, list)

	// -- 同步 renderer localStorage（界面与启动时的全量同步源）
	const mainWindow = windowManager.getWindow()
	let localStorageUpdated = false
	if (mainWindow && !mainWindow.isDestroyed()) {
		try {
			const storageKey =
				libraryType === "pos" ? "fusion" : "selectStockStrategy25"
			const js = `
				(function() {
					var key = ${JSON.stringify(storageKey)};
					var target = ${JSON.stringify(name)};
					var w = ${JSON.stringify(weight)};
					var list = [];
					try {
						var raw = localStorage.getItem(key);
						if (raw) { list = JSON.parse(raw); if (!Array.isArray(list)) list = []; }
					} catch (e) { list = []; }
					var n = 0;
					for (var i = 0; i < list.length; i++) {
						var item = list[i];
						if (!item || item.name !== target) continue;
						n++;
						item.cap_weight = w;
						if (Array.isArray(item.strategy_list)) {
							for (var j = 0; j < item.strategy_list.length; j++) {
								item.strategy_list[j].cap_weight = w;
							}
						}
					}
					if (n > 0) {
						var mergedJson = JSON.stringify(list);
						localStorage.setItem(key, mergedJson);
						window.dispatchEvent(new StorageEvent('storage', { key: key, newValue: mergedJson }));
					}
					return n;
				})()
			`
			localStorageUpdated = Boolean(
				await mainWindow.webContents.executeJavaScript(js, true),
			)
		} catch (error) {
			console.error("[MCP] 同步 localStorage 权重失败:", error)
		}
	}

	// -- 同步 real_market_25.json（zeus 回测实际读取的策略注册表）
	let rStoreSlots = 0
	try {
		for (const [key, entry] of Object.entries(rStore.store ?? {})) {
			if (!key.startsWith("strategy_")) continue
			const e = entry as Record<string, unknown> | undefined
			if (typeof e?.name === "string" && e.name.endsWith(`-${name}`)) {
				rStore.set(`${key}.strategy_weight`, weight)
				rStoreSlots++
			}
		}
	} catch (error) {
		console.error("[MCP] 同步 real_market_25 权重失败:", error)
	}

	return c.json({
		code: 0,
		data: {
			name,
			weight,
			libraryType,
			matched,
			localStorageUpdated,
			rStoreSlots,
		},
		message: `已设置 ${name} 资金占比为 ${(weight * 100).toFixed(1)}%（匹配 ${matched} 组，real_market_25 槽位 ${rStoreSlots} 个）`,
	})
})

/**
 * PUT /mcp/backtest/config - 设置回测配置
 *
 * 支持设置初始资金、起止日期、板块过滤。字段白名单控制。
 */
mcpRouter.put("/backtest/config", async (c: Context) => {
	const body = await c.req.json().catch(() => ({}))

	const libraryType = store.get(LIBRARY_TYPE, "select") as string
	const configKey =
		libraryType === "pos"
			? POS_MGMT_STRATEGY_CONFIG
			: SELECT_STOCK_STRATEGY_CONFIG

	const allowedKeys: Record<string, string> = {
		initial_cash: `${configKey}.initial_cash`,
		start_date: `${configKey}.start_date`,
		end_date: `${configKey}.end_date`,
		filter_kcb: "real_market_config.filter_kcb",
		filter_cyb: "real_market_config.filter_cyb",
		filter_bj: "real_market_config.filter_bj",
	}

	const updated: Record<string, unknown> = {}
	const rejected: string[] = []

	for (const [key, value] of Object.entries(body)) {
		if (key in allowedKeys) {
			store.set(allowedKeys[key], value)
			updated[key] = value
		} else {
			rejected.push(key)
		}
	}

	return c.json({
		code: 0,
		data: { updated, rejected, configKey, libraryType },
		message:
			rejected.length > 0
				? `部分字段被拒绝（不在白名单）: ${rejected.join(", ")}`
				: "回测配置已更新",
	})
})

/** 绩效中文指标 → 工作流标准字段（evaluate_backtest / record_experiment 入参键） */
const PERFORMANCE_METRIC_MAP: Record<string, string> = {
	年化收益: "annual_return_pct",
	最大回撤: "max_drawdown_pct",
	"年化收益/回撤比": "sharpe_ratio",
	"胜率（含0/去0）": "win_rate_pct",
	盈亏收益比: "profit_loss_ratio",
}

/**
 * 从绩效字符串中提取首个数值。
 * 兼容 "14.97%"、"57.95% / 57.95%"（双值取首个）、"1,234.5"（千分位）形态。
 */
function parseMetricNumber(value: string | undefined): number | undefined {
	if (!value) return undefined
	const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)
	return match ? Number.parseFloat(match[0]) : undefined
}

/**
 * GET /mcp/backtest/performance - 查询回测绩效指标
 *
 * 读取 real_trading/data/回测结果/{backtest_name}/策略评价.csv，
 * 返回年化收益、最大回撤、胜率等 18 项绩效指标。
 * metrics 为原始字符串；parsed 为 5 项工作流标准指标的数值形式，
 * 可直接用于 evaluate_backtest / record_experiment 入参。
 */
mcpRouter.get("/backtest/performance", async (c: Context) => {
	try {
		const libraryType = store.get(LIBRARY_TYPE, "select") as string
		const configKey =
			libraryType === "pos"
				? POS_MGMT_STRATEGY_CONFIG
				: SELECT_STOCK_STRATEGY_CONFIG
		const backtestName = store.get(
			`${configKey}.backtest_name`,
			"策略库",
		) as string

		const filePath = await storeApi.getAllDataPath([
			"real_trading",
			"data",
			"回测结果",
			backtestName,
			"策略评价.csv",
		])

		if (!fs.existsSync(filePath)) {
			return c.json(
				{ code: 404, data: null, message: "策略评价文件不存在，请先执行回测" },
				404,
			)
		}

		const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "")
		// 策略评价.csv 格式：每行 "指标名,值"（无表头），用 csv-parse 不启用 columns
		const records = parse(content, {
			columns: false,
			skip_empty_lines: true,
		}) as Array<Array<string>>

		// 转为 key-value 对象，跳过无效行
		const data: Record<string, string> = {}
		for (const row of records) {
			if (row.length >= 2 && row[0]) {
				data[row[0]] = row[1]
			}
		}

		// 5 项工作流标准指标的数值形式，免除 AI 客户端手工解析字符串
		const parsed: Record<string, number> = {}
		for (const [cnKey, enKey] of Object.entries(PERFORMANCE_METRIC_MAP)) {
			const num = parseMetricNumber(data[cnKey])
			if (num !== undefined) {
				parsed[enKey] = num
			}
		}

		return c.json({
			code: 0,
			data: { backtestName, metrics: data, parsed },
			message: `成功读取策略评价: ${backtestName}`,
		})
	} catch (error) {
		return c.json(
			{
				code: 500,
				message: `读取策略评价失败: ${error instanceof Error ? error.message : String(error)}`,
			},
			500,
		)
	}
})

/**
 * GET /mcp/backtest/equity-curve - 查询回测资金曲线
 *
 * 读取 real_trading/data/回测结果/{backtest_name}/资金曲线.csv，
 * 返回每日净值、涨跌幅、回撤等数据。支持 step 参数抽样降采样。
 *
 * Query: step=N (每 N 条取一条，默认 1=全量；建议 5-20 减少数据量)
 */
mcpRouter.get("/backtest/equity-curve", async (c: Context) => {
	try {
		const libraryType = store.get(LIBRARY_TYPE, "select") as string
		const configKey =
			libraryType === "pos"
				? POS_MGMT_STRATEGY_CONFIG
				: SELECT_STOCK_STRATEGY_CONFIG
		const backtestName = store.get(
			`${configKey}.backtest_name`,
			"策略库",
		) as string

		const filePath = await storeApi.getAllDataPath([
			"real_trading",
			"data",
			"回测结果",
			backtestName,
			"资金曲线.csv",
		])

		if (!fs.existsSync(filePath)) {
			return c.json({
				code: 0,
				data: [],
				message: "资金曲线文件不存在，请先执行回测",
			})
		}

		const stepRaw = Number.parseInt(c.req.query("step") ?? "1", 10)
		const step = Number.isNaN(stepRaw) || stepRaw < 1 ? 1 : stepRaw

		const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "")
		const allRecords = parse(content, {
			columns: true,
			skip_empty_lines: true,
		})
		const data = JSON.parse(JSON.stringify(allRecords))

		// 抽样降采样
		const sampled =
			step > 1 ? data.filter((_: unknown, i: number) => i % step === 0) : data

		return c.json({
			code: 0,
			data: sampled,
			message: `成功读取资金曲线: ${backtestName}（共 ${data.length} 条，抽样 ${sampled.length} 条，step=${step}）`,
		})
	} catch (error) {
		return c.json(
			{
				code: 500,
				message: `读取资金曲线失败: ${error instanceof Error ? error.message : String(error)}`,
			},
			500,
		)
	}
})

export { mcpRouter }
