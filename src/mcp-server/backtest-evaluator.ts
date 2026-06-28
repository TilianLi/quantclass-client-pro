/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

export interface Thresholds {
	annual_return_pct?: number
	max_drawdown_pct?: number
	sharpe_ratio?: number
	win_rate_pct?: number
	profit_loss_ratio?: number
}

export interface BacktestPerformance {
	variantId: string
	annual_return_pct?: number
	max_drawdown_pct?: number
	sharpe_ratio?: number
	win_rate_pct?: number
	profit_loss_ratio?: number
}

export interface EvaluationResult {
	passed: boolean
	bestVariantId: string | null
	score: number
	details: Record<
		string,
		{ value: number; threshold: number | undefined; passed: boolean }
	>
}

export function evaluateBacktest(
	performances: BacktestPerformance[],
	thresholds: Thresholds,
): EvaluationResult {
	if (performances.length === 0) {
		return { passed: false, bestVariantId: null, score: 0, details: {} }
	}

	const scored = performances.map((p) => {
		const details: EvaluationResult["details"] = {}
		let passCount = 0
		let totalCount = 0

		for (const [key, threshold] of Object.entries(thresholds)) {
			const value = p[key as keyof BacktestPerformance] as number | undefined
			const numericValue =
				typeof value === "number" ? value : Number.NEGATIVE_INFINITY
			const passed =
				key === "max_drawdown_pct"
					? threshold === undefined ||
						Math.abs(numericValue) <= Math.abs(threshold)
					: threshold === undefined || numericValue >= threshold

			details[key] = { value: numericValue, threshold, passed }
			if (threshold !== undefined) {
				totalCount++
				if (passed) passCount++
			}
		}

		const score = totalCount === 0 ? 0 : passCount / totalCount
		return { ...p, details, score, allPassed: score === 1 }
	})

	const best = scored.reduce((prev, curr) =>
		curr.score > prev.score ? curr : prev,
	)

	return {
		passed: best.allPassed,
		bestVariantId: best.variantId,
		score: best.score,
		details: best.details,
	}
}
