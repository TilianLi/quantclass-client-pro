/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { get, post, put } from "./client.js"

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
		"更新交易配置中的指定字段（field 支持 dot-key 路径，如 real_market_config.account_id）",
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
}
