/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { execBin } from "@/main/lib/process.js"
import {
	setAutoMinData,
	setAutoTrading,
	setAutoUpdate,
	systemState,
} from "@/main/lib/scheduler.js"
import { store } from "@/main/store/index.js"
import type { Context } from "hono"
import { Hono } from "hono"
import type { Env } from "../types/index.js"

const mcpRouter = new Hono<Env>()

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
 */
mcpRouter.post("/min-data/exec", async (c: Context) => {
	try {
		await execBin(["min_data"], "MCP手动获取实时数据")
		return c.json({
			code: 0,
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
 */
mcpRouter.get("/config/trading", (c: Context) => {
	const config = {
		account_id: store.get("real_market_config.account_id", "0"),
		use_fuzzy: store.get("real_market_config.use_fuzzy", "1"),
		use_open_sell: store.get("real_market_config.use_open_sell", "0"),
		auto_real_trading: store.get("auto_real_trading", false),
	}

	return c.json({
		code: 0,
		data: config,
		message: "ok",
	})
})

/**
 * PUT /mcp/config/trading - 更新交易配置
 */
mcpRouter.put("/config/trading", async (c: Context) => {
	const body = await c.req.json()
	const allowedKeys = [
		"real_market_config.account_id",
		"real_market_config.use_fuzzy",
		"real_market_config.use_open_sell",
	]

	const updated: Record<string, unknown> = {}
	for (const key of allowedKeys) {
		if (body[key] !== undefined) {
			store.set(key, body[key])
			updated[key] = body[key]
		}
	}

	return c.json({
		code: 0,
		data: updated,
		message: "交易配置已更新",
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

export { mcpRouter }
