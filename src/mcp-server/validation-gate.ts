/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

// ============================================================
// Validation 闸门状态管理
//
// run_validation 开始前把当前回测配置快照到 run 目录下的
// validation-state.json；complete_validation 据此恢复原配置。
// 状态落盘（而非内存）保证 MCP Server 重启后仍能恢复。
// ============================================================

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { BriefFile } from "./research-run.ts"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
	getWorkspaceRoot,
} from "./strategy-files.ts"

/** GET /mcp/backtest/config 返回的回测配置（camelCase），仅保留闸门关心的字段 */
export interface BacktestConfigSnapshot {
	initialCash?: number
	startDate?: string
	endDate?: string | null
	filterKcb?: string
	filterCyb?: string
	filterBj?: string
}

export interface ValidationState {
	taskId: string
	startedAt: string
	priorConfig: BacktestConfigSnapshot
}

function statePath(runId: string): string {
	assertSafePathComponent(runId, "runId")
	return assertInsideWorkspace(
		join(getWorkspaceRoot(), runId, "validation-state.json"),
	)
}

export function saveValidationState(
	runId: string,
	state: ValidationState,
): void {
	const path = statePath(runId)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
}

export function readValidationState(runId: string): ValidationState | null {
	const path = statePath(runId)
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ValidationState
	} catch {
		throw new Error(`validation-state.json 不是合法 JSON: ${path}`)
	}
}

export function clearValidationState(runId: string): void {
	rmSync(statePath(runId), { force: true })
}

type SetConfigBody = Record<string, string | number | null>

/**
 * 把 brief.validation 窗口映射为 PUT /mcp/backtest/config 的请求体。
 * end_date: null（回测至今）必须保留；undefined 的键省略（不覆盖现值）。
 */
export function buildValidationWindow(brief: BriefFile): SetConfigBody {
	const v = brief.validation
	if (!v) {
		throw new Error(
			`brief.json 未定义 validation 窗口（runId=${brief.runId}），无法启动 validation 闸门`,
		)
	}
	const body: SetConfigBody = {}
	if (v.initial_cash !== undefined) body.initial_cash = v.initial_cash
	if (v.start_date !== undefined) body.start_date = v.start_date
	if (v.end_date !== undefined) body.end_date = v.end_date
	if (v.filter_kcb !== undefined) body.filter_kcb = v.filter_kcb
	if (v.filter_cyb !== undefined) body.filter_cyb = v.filter_cyb
	if (v.filter_bj !== undefined) body.filter_bj = v.filter_bj
	return body
}

/**
 * 把 run_validation 快照的原配置（camelCase）映射回 PUT 请求体（snake_case）。
 * endDate: null 显式还原为 null（省略会保留 validation 窗口的残值）。
 */
export function priorConfigToRestoreBody(
	prior: BacktestConfigSnapshot,
): SetConfigBody {
	const body: SetConfigBody = {}
	if (prior.initialCash !== undefined) body.initial_cash = prior.initialCash
	if (prior.startDate !== undefined) body.start_date = prior.startDate
	if (prior.endDate !== undefined) body.end_date = prior.endDate
	if (prior.filterKcb !== undefined) body.filter_kcb = prior.filterKcb
	if (prior.filterCyb !== undefined) body.filter_cyb = prior.filterCyb
	if (prior.filterBj !== undefined) body.filter_bj = prior.filterBj
	return body
}
