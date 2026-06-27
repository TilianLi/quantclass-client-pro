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
import { homedir } from "node:os"
import { join } from "node:path"
import { store as electronStore } from "@/main/store/index.js"
import logger from "@/main/utils/wiston.js"
import { app, ipcMain, webContents } from "electron"

const MCP_STATUS_CHANNEL = "mcp-status-change"
const MCP_STATUS_POLL_INTERVAL_MS = 5_000
const MCP_STATUS_HTTP_TIMEOUT_MS = 10_000

let mcpStatusTimer: ReturnType<typeof setInterval> | null = null
let lastEmittedConnected: boolean | null = null

/**
 * 从 electron-store 读取 Hono server 端口；若未启动则返回 null。
 *
 * 端口在 `app.on("ready")` 中通过 `startServerOnAvailablePort()` 写入
 * `server_port`，是 main 侧最权威的"当前端口"来源。
 */
async function readServerPort(): Promise<number | null> {
	const port = await electronStore.get("server_port")
	if (typeof port === "number" && port > 0) return port
	if (typeof port === "string") {
		const parsed = Number.parseInt(port, 10)
		if (!Number.isNaN(parsed) && parsed > 0) return parsed
	}
	return null
}

/**
 * 兜底：从 ~/.quantclass/mcp-port 读取端口（Hono 启动时由 writeMcpPortFile 写入）。
 */
function readMcpPortFile(): number | null {
	try {
		const portFile = join(homedir(), ".quantclass", "mcp-port")
		if (!existsSync(portFile)) return null
		const parsed = Number.parseInt(readFileSync(portFile, "utf-8").trim(), 10)
		return Number.isNaN(parsed) ? null : parsed
	} catch {
		return null
	}
}

/**
 * 通过 GET 请求探测 MCP /mcp/status，10s 超时。
 *
 * MCP Server 是独立 Node 进程，main 侧无法直接观察其存活；
 * Hono /mcp/status 接口可用于间接判断：MCP Server 一旦启动，
 * 会持续通过 HTTP 调用该端点完成 list_tools / list_resources /
 * 业务调用。但单次 GET 请求只能确认 Hono 在线、不能确认 MCP
 * Server 在线；这里返回"Hono 可达且 /mcp/status 路由已注册"作为
 * available 判定的保守信号，UI 文案说明这是"App 端 MCP API"可用性。
 *
 * 注：/mcp/status 为只读状态接口，已豁免鉴权，探测无需携带 token。
 */
async function probeMcpAvailable(port: number): Promise<boolean> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), MCP_STATUS_HTTP_TIMEOUT_MS)
	try {
		const res = await fetch(`http://127.0.0.1:${port}/mcp/status`, {
			method: "GET",
			signal: controller.signal,
		})
		return res.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

/**
 * 把 MCP 连接状态广播到所有 webContents（main + terminal 子窗口）。
 * 仅在状态翻转时推送，避免每 5s 刷一次 IPC。
 */
function broadcastMcpStatus(connected: boolean, clientCount = 1) {
	for (const wc of webContents.getAllWebContents()) {
		if (!wc.isDestroyed()) {
			wc.send(MCP_STATUS_CHANNEL, { connected, clientCount })
		}
	}
}

async function pollMcpStatusOnce(): Promise<boolean> {
	const port = (await readServerPort()) ?? readMcpPortFile()
	if (port === null) return false
	return probeMcpAvailable(port)
}

function startMcpStatusPolling() {
	if (mcpStatusTimer) return
	// 立即跑一次，避免渲染端打开 realtime-data 时一直看不到真实状态
	void pollMcpStatusOnce().then((connected) => {
		lastEmittedConnected = connected
		broadcastMcpStatus(connected)
	})
	mcpStatusTimer = setInterval(async () => {
		const connected = await pollMcpStatusOnce()
		if (connected !== lastEmittedConnected) {
			lastEmittedConnected = connected
			broadcastMcpStatus(connected)
			logger.info(`[mcp] 连接状态变化: ${connected ? "可用" : "不可用"}`)
		}
	}, MCP_STATUS_POLL_INTERVAL_MS)
}

function stopMcpStatusPolling() {
	if (mcpStatusTimer) {
		clearInterval(mcpStatusTimer)
		mcpStatusTimer = null
	}
}

function getMcpServerInfoHandler() {
	ipcMain.handle("get-mcp-server-info", async () => {
		// 端口优先用 electron-store，未启动时回退到 port 文件，再回退到 8787
		const port = (await readServerPort()) ?? readMcpPortFile() ?? 8787

		// MCP Server 脚本路径
		const mcpServerPath = join(
			app.isPackaged
				? process.resourcesPath
				: join(app.getAppPath(), "resources"),
			"mcp-server",
			"index.js",
		)

		return { port, mcpServerPath }
	})
}

function getMcpConnectionStatusHandler() {
	ipcMain.handle("get-mcp-connection-status", async () => {
		// 返回真实探测结果（HTTP GET /mcp/status，10s 超时），不再只看 port 文件是否存在
		const port = (await readServerPort()) ?? readMcpPortFile() ?? 8787
		const available = await probeMcpAvailable(port)
		return { available, port }
	})
}

export const regMcpIPC = () => {
	getMcpServerInfoHandler()
	getMcpConnectionStatusHandler()
	startMcpStatusPolling()

	// 应用退出前清理定时器，避免悬挂
	app.on("before-quit", () => {
		stopMcpStatusPolling()
	})

	console.log("[reg] mcp-ipc")
}
