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
	evaluateBacktest,
	parsePerformanceCsv,
	performanceCsvToMetrics,
} from "../../src/mcp-server/backtest-evaluator.ts"

describe("backtest-evaluator", () => {
	it("returns passed when thresholds met", () => {
		const result = evaluateBacktest(
			[
				{
					variantId: "v1",
					annual_return_pct: 20,
					max_drawdown_pct: 15,
					sharpe_ratio: 1.2,
				},
			],
			{
				annual_return_pct: 15,
				max_drawdown_pct: 20,
				sharpe_ratio: 1.0,
			},
		)
		assert.strictEqual(result.passed, true)
		assert.strictEqual(result.bestVariantId, "v1")
		assert.strictEqual(result.score, 1)
	})

	it("returns not passed and picks best variant", () => {
		const result = evaluateBacktest(
			[
				{ variantId: "v1", annual_return_pct: 10, max_drawdown_pct: 25 },
				{ variantId: "v2", annual_return_pct: 18, max_drawdown_pct: 22 },
			],
			{
				annual_return_pct: 15,
				max_drawdown_pct: 20,
			},
		)
		assert.strictEqual(result.passed, false)
		assert.strictEqual(result.bestVariantId, "v2")
		assert.ok(result.score > 0 && result.score < 1)
	})

	it("returns failed on empty input", () => {
		const result = evaluateBacktest([], {})
		assert.strictEqual(result.passed, false)
		assert.strictEqual(result.bestVariantId, null)
	})

	it("parses CSV without a header row (no metric dropped)", () => {
		// 策略评价.csv 无表头，每行都是 "指标名,值"
		const csv = "累积净值,1.23\n年化收益,14.97%\n最大回撤,-25.78%"
		const raw = parsePerformanceCsv(csv)
		assert.strictEqual(raw.累积净值, "1.23")
		assert.strictEqual(raw.年化收益, "14.97%")
	})

	it("parses dual-value percent like 57.95% / 57.95% (first number wins)", () => {
		const csv =
			"年化收益,14.97%\n最大回撤,-25.78%\n年化收益/回撤比,0.58\n胜率（含0/去0）,57.95% / 57.95%\n盈亏收益比,1.35"
		const metrics = performanceCsvToMetrics("v1", csv)
		assert.strictEqual(metrics.win_rate_pct, 57.95)
		assert.strictEqual(metrics.annual_return_pct, 14.97)
		assert.strictEqual(metrics.max_drawdown_pct, -25.78)
		assert.strictEqual(metrics.sharpe_ratio, 0.58)
		assert.strictEqual(metrics.profit_loss_ratio, 1.35)
	})
})
