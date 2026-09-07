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

	it("maps 年化收益/回撤比 to calmar_ratio (canonical) with sharpe_ratio mirror", () => {
		// 「年化收益/回撤比」是 Calmar 口径而非真正夏普比率，
		// 规范字段名应为 calmar_ratio，sharpe_ratio 仅作兼容镜像保留
		const csv = "年化收益,14.97%\n年化收益/回撤比,0.58"
		const metrics = performanceCsvToMetrics("v1", csv)
		assert.strictEqual(metrics.calmar_ratio, 0.58)
		assert.strictEqual(metrics.sharpe_ratio, 0.58)
	})

	it("accepts sharpe_ratio as deprecated alias in performances and thresholds", () => {
		const result = evaluateBacktest(
			[{ variantId: "v1", sharpe_ratio: 0.4, annual_return_pct: 12 }],
			{ calmar_ratio: 0.5 },
		)
		assert.strictEqual(result.passed, false)
		assert.strictEqual(result.details.calmar_ratio?.value, 0.4)
		assert.strictEqual(result.details.calmar_ratio?.passed, false)
		// 反向：performance 给 calmar_ratio、threshold 给旧名 sharpe_ratio
		const result2 = evaluateBacktest([{ variantId: "v1", calmar_ratio: 0.6 }], {
			sharpe_ratio: 0.5,
		})
		assert.strictEqual(result2.passed, true)
		assert.strictEqual(result2.details.calmar_ratio?.value, 0.6)
	})

	it("breaks score ties by higher annual return, not first-seen", () => {
		// 线上实测 bug：v1/v3 同分（都达标），旧实现取先出现的 v1，
		// 尽管 v3 年化/回撤/收益回撤比全面占优
		const result = evaluateBacktest(
			[
				{
					variantId: "v1",
					annual_return_pct: 13.25,
					max_drawdown_pct: -26.65,
					calmar_ratio: 0.5,
				},
				{
					variantId: "v3",
					annual_return_pct: 17.25,
					max_drawdown_pct: -25.41,
					calmar_ratio: 0.68,
				},
			],
			{ annual_return_pct: 10, max_drawdown_pct: 30, calmar_ratio: 0.5 },
		)
		assert.strictEqual(result.passed, true)
		assert.strictEqual(result.bestVariantId, "v3")
	})

	it("breaks annual ties by lower complexity when both present", () => {
		const result = evaluateBacktest(
			[
				{
					variantId: "v1",
					annual_return_pct: 15,
					calmar_ratio: 0.6,
					complexity: 8,
				},
				{
					variantId: "v2",
					annual_return_pct: 15,
					calmar_ratio: 0.6,
					complexity: 3,
				},
			],
			{ annual_return_pct: 10 },
		)
		assert.strictEqual(result.bestVariantId, "v2")
	})

	it("keeps incumbent on full tie when complexity missing on one side", () => {
		const result = evaluateBacktest(
			[
				{ variantId: "v1", annual_return_pct: 15, calmar_ratio: 0.6 },
				{
					variantId: "v2",
					annual_return_pct: 15,
					calmar_ratio: 0.6,
					complexity: 3,
				},
			],
			{ annual_return_pct: 10 },
		)
		assert.strictEqual(result.bestVariantId, "v1")
	})
})
