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
import { describe, it } from "node:test"
import {
	computeDrawdownEpisodes,
	computeYearlyReturns,
	parseEquityRows,
} from "../../src/mcp-server/backtest-diagnostics.ts"

describe("backtest-diagnostics", () => {
	it("parses equity curve csv rows into date/nav points, skipping bad rows", () => {
		const rows = [
			{ 交易日期: "2024-01-02", 净值: "1.0" },
			{ 交易日期: "2024-01-03", 净值: "1.01" },
			{ 交易日期: "", 净值: "1.02" }, // 缺日期
			{ 交易日期: "2024-01-04", 净值: "abc" }, // 非法净值
		]
		assert.deepStrictEqual(parseEquityRows(rows), [
			{ date: "2024-01-02", nav: 1.0 },
			{ date: "2024-01-03", nav: 1.01 },
		])
	})

	it("computes per-year returns chained from previous year end", () => {
		const points = [
			{ date: "2023-01-02", nav: 1.0 },
			{ date: "2023-06-30", nav: 1.1 },
			{ date: "2023-12-29", nav: 1.2 },
			{ date: "2024-06-28", nav: 1.0 },
			{ date: "2024-12-31", nav: 1.5 },
		]
		const yearly = computeYearlyReturns(points)
		assert.deepStrictEqual(yearly, [
			// 首年：从首个净值算起 1.0 → 1.2
			{ year: "2023", returnPct: 20 },
			// 次年：从上年末净值算起 1.2 → 1.5
			{ year: "2024", returnPct: 25 },
		])
	})

	it("returns empty array for empty input", () => {
		assert.deepStrictEqual(computeYearlyReturns([]), [])
		assert.deepStrictEqual(computeDrawdownEpisodes([]), [])
	})

	it("extracts drawdown episodes with trough, depth and recovery", () => {
		const points = [
			{ date: "2024-01-01", nav: 1.0 },
			{ date: "2024-02-01", nav: 1.2 }, // 峰值
			{ date: "2024-03-01", nav: 0.9 }, // 谷底 -25%
			{ date: "2024-04-01", nav: 1.1 },
			{ date: "2024-05-01", nav: 1.25 }, // 修复（回到前高之上）
			{ date: "2024-06-01", nav: 1.1 },
			{ date: "2024-07-01", nav: 1.0 }, // 第二段回撤谷底 -20%（相对 1.25）
		]
		const episodes = computeDrawdownEpisodes(points, 3)
		assert.strictEqual(episodes.length, 2)
		// 按深度排序：最深的在前
		assert.strictEqual(episodes[0].peakDate, "2024-02-01")
		assert.strictEqual(episodes[0].troughDate, "2024-03-01")
		assert.strictEqual(episodes[0].depthPct, -25)
		assert.strictEqual(episodes[0].recoveryDate, "2024-05-01")
		assert.strictEqual(episodes[0].peakToTroughDays, 29)
		assert.strictEqual(episodes[0].recoveryDays, 61)
		// 第二段未修复
		assert.strictEqual(episodes[1].depthPct, -20)
		assert.strictEqual(episodes[1].recoveryDate, null)
		assert.strictEqual(episodes[1].recoveryDays, null)
	})

	it("respects topN limit", () => {
		const points = [
			{ date: "2024-01-01", nav: 1.0 },
			{ date: "2024-02-01", nav: 0.5 }, // -50%
			{ date: "2024-03-01", nav: 1.0 },
			{ date: "2024-04-01", nav: 0.9 }, // -10%
			{ date: "2024-05-01", nav: 1.0 },
		]
		const top1 = computeDrawdownEpisodes(points, 1)
		assert.strictEqual(top1.length, 1)
		assert.strictEqual(top1[0].depthPct, -50)
	})
})
