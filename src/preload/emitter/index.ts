/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

/** 调度器状态（与 src/main/lib/scheduler.ts 的 send-schedule-status 载荷一致） */
type LoopStatus =
	| "init"
	| "error"
	| "start"
	| "outline"
	| "done"
	| "fuel_start"
	| "aqua_start"
	| "noTradingTime"
	| "rocket_start"

import type { IpcRendererEvent } from "electron"
import { ipcRenderer } from "electron"

export const emitterIPC = {
	sendUpdateStatus: (callback: any) =>
		ipcRenderer.on("send-update-status", callback),
	removeSendUpdateStatusListener: () => {
		ipcRenderer.removeAllListeners("send-update-status")
	},
	// onNetworkStatusChange: (callback: any) =>
	// 	ipcRenderer.on("network-status", callback),
	subscribeScheduleStatus: (
		callback: (event: IpcRendererEvent, status: LoopStatus) => void,
	) => ipcRenderer.on("send-schedule-status", callback),
	unSubscribeSendScheduleStatusListener: () => {
		ipcRenderer.removeAllListeners("send-schedule-status")
	},
	logHandle: (
		msg: Partial<{
			message: string | Event
			source: string
			lineno: number
			colno: number
			error: Error
		}>,
	) => ipcRenderer.send("log-error", msg),
	openUrl: (url: string) => ipcRenderer.send("open-url", url),
}
