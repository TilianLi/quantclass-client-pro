/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-valgate-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const {
	buildValidationWindow,
	clearValidationState,
	priorConfigToRestoreBody,
	readValidationState,
	saveValidationState,
} = await import("../../src/mcp-server/validation-gate.ts")

describe("validation-gate", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("maps brief.validation window to set-config body (snake_case, null end kept)", () => {
		const body = buildValidationWindow({
			goal: "g",
			thresholds: {},
			runId: "run-v",
			createdAt: "2026-07-25T00:00:00.000Z",
			validation: {
				initial_cash: 1000000,
				start_date: "2025-01-01",
				end_date: null,
				filter_kcb: "1",
				filter_cyb: "0",
				filter_bj: "1",
			},
		})
		assert.deepStrictEqual(body, {
			initial_cash: 1000000,
			start_date: "2025-01-01",
			end_date: null,
			filter_kcb: "1",
			filter_cyb: "0",
			filter_bj: "1",
		})
	})

	it("omits undefined keys from validation window body", () => {
		const body = buildValidationWindow({
			goal: "g",
			thresholds: {},
			runId: "run-v",
			createdAt: "2026-07-25T00:00:00.000Z",
			validation: { start_date: "2025-01-01" },
		})
		assert.deepStrictEqual(body, { start_date: "2025-01-01" })
	})

	it("throws when brief has no validation window", () => {
		assert.throws(
			() =>
				buildValidationWindow({
					goal: "g",
					thresholds: {},
					runId: "run-v",
					createdAt: "2026-07-25T00:00:00.000Z",
				}),
			/validation/,
		)
	})

	it("maps prior config (camelCase) back to restore body (snake_case), filters normalized to boolean", () => {
		const body = priorConfigToRestoreBody({
			initialCash: 1000000,
			startDate: "2023-01-01",
			endDate: "2024-12-31",
			filterKcb: "1",
			filterCyb: "0",
			filterBj: "1",
		})
		// filter_* 回传前归一为 boolean（与主进程存储口径一致），
		// 避免字符串 "0" 被 Python 按真值误判为「过滤」
		assert.deepStrictEqual(body, {
			initial_cash: 1000000,
			start_date: "2023-01-01",
			end_date: "2024-12-31",
			filter_kcb: true,
			filter_cyb: false,
			filter_bj: true,
		})
		// boolean 输入原样归一
		const bodyBool = priorConfigToRestoreBody({
			filterKcb: true,
			filterCyb: false,
		})
		assert.deepStrictEqual(bodyBool, { filter_kcb: true, filter_cyb: false })
		// endDate 为 null（回测至今）时必须显式还原为 null，而不是省略
		const body2 = priorConfigToRestoreBody({
			startDate: "2025-01-01",
			endDate: null,
		})
		assert.deepStrictEqual(body2, { start_date: "2025-01-01", end_date: null })
	})

	it("saves, reads and clears validation state", () => {
		assert.strictEqual(readValidationState("run-s"), null)
		saveValidationState("run-s", {
			taskId: "fusion_123",
			startedAt: "2026-07-25T04:40:00+08:00",
			priorConfig: { startDate: "2023-01-01", endDate: "2024-12-31" },
		})
		const state = readValidationState("run-s")
		assert.strictEqual(state?.taskId, "fusion_123")
		assert.strictEqual(state?.priorConfig.startDate, "2023-01-01")
		clearValidationState("run-s")
		assert.strictEqual(readValidationState("run-s"), null)
	})
})
