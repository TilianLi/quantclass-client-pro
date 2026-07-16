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
import { get } from "./client.js"

export function registerResources(server: McpServer): void {
	server.resource(
		"status",
		"quantclass://status",
		{ description: "QuantClass 系统当前运行状态快照" },
		async (uri) => {
			try {
				const result = await get("/mcp/status")
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "application/json",
							text: JSON.stringify(result, null, 2),
						},
					],
				}
			} catch (error) {
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "text/plain",
							text: `获取系统状态失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				}
			}
		},
	)

	server.resource(
		"trading-config",
		"quantclass://config/trading",
		{ description: "QuantClass 当前交易配置信息" },
		async (uri) => {
			try {
				const result = await get("/mcp/config/trading")
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "application/json",
							text: JSON.stringify(result, null, 2),
						},
					],
				}
			} catch (error) {
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "text/plain",
							text: `获取交易配置失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				}
			}
		},
	)
}
