/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { ipcRenderer } from "electron"

export const mcpIPC = {
	// 获取 MCP Server 信息（路径、端口）
	getMcpServerInfo: () => ipcRenderer.invoke("get-mcp-server-info"),
	// 获取 MCP 连接状态
	getMcpConnectionStatus: () => ipcRenderer.invoke("get-mcp-connection-status"),
	// 监听 MCP 状态变化
	onMcpStatusChange: (
		callback: (
			event: Electron.IpcRendererEvent,
			status: { connected: boolean; clientCount: number },
		) => void,
	) => {
		ipcRenderer.on("mcp-status-change", callback)
	},
	removeMcpStatusChangeListener: () => {
		ipcRenderer.removeAllListeners("mcp-status-change")
	},
}
