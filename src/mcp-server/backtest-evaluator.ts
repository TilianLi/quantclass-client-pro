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
	/** 收益回撤比（年化收益/最大回撤，Calmar 口径）阈值 */
	calmar_ratio?: number
	/** @deprecated sharpe_ratio 实为「年化收益/回撤比」口径，请改用 calmar_ratio */
	sharpe_ratio?: number
	win_rate_pct?: number
	profit_loss_ratio?: number
}

export interface BacktestPerformance {
	variantId: string
	annual_return_pct?: number
	max_drawdown_pct?: number
	/** 收益回撤比（年化收益/最大回撤，Calmar 口径） */
	calmar_ratio?: number
	/** @deprecated sharpe_ratio 实为「年化收益/回撤比」口径，仅作兼容镜像保留 */
	sharpe_ratio?: number
	win_rate_pct?: number
	profit_loss_ratio?: number
	/** 旋钮计数（factor_list+filter_list 等条目数），用于同分时防过拟合 */
	complexity?: number
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

/**
 * 解析策略评价 CSV，返回 key-value 映射。
 * CSV 格式：无表头，每行 "指标名,值"（值可能带 %、千分位或 "a / b" 双值）。
 */
export function parsePerformanceCsv(csvText: string): Record<string, string> {
	const lines = csvText.split(/\r?\n/).filter((line) => line.trim())
	const result: Record<string, string> = {}
	for (const line of lines) {
		const parts = line.split(",")
		if (parts.length >= 2) {
			const key = parts[0].trim()
			const value = parts[1].trim()
			if (key) result[key] = value
		}
	}
	return result
}

/**
 * 从绩效字符串中提取首个数值。
 * 兼容 "14.97%"、"57.95% / 57.95%"（双值取首个）、"1,234.5"（千分位）形态。
 */
function parsePercentOrNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)
	return match ? Number.parseFloat(match[0]) : undefined
}

export function performanceCsvToMetrics(
	variantId: string,
	csvText: string,
): BacktestPerformance {
	const raw = parsePerformanceCsv(csvText)
	const calmar = parsePercentOrNumber(raw["年化收益/回撤比"])
	return {
		variantId,
		annual_return_pct: parsePercentOrNumber(raw.年化收益),
		max_drawdown_pct: parsePercentOrNumber(raw.最大回撤),
		calmar_ratio: calmar,
		// 兼容镜像：历史调用方（含旧 trace/brief）仍读取 sharpe_ratio 键
		sharpe_ratio: calmar,
		win_rate_pct: parsePercentOrNumber(raw["胜率（含0/去0）"]),
		profit_loss_ratio: parsePercentOrNumber(raw.盈亏收益比),
	}
}

/**
 * 归一化阈值：sharpe_ratio（旧名）并入 calmar_ratio（新名），新名优先。
 */
function normalizeThresholds(thresholds: Thresholds): Thresholds {
	const { sharpe_ratio, ...rest } = thresholds
	return {
		...rest,
		calmar_ratio: thresholds.calmar_ratio ?? sharpe_ratio,
	}
}

/**
 * 归一化绩效：calmar_ratio 缺省时用 sharpe_ratio（旧名）回填。
 */
function normalizePerformance(p: BacktestPerformance): BacktestPerformance {
	if (p.calmar_ratio !== undefined || p.sharpe_ratio === undefined) return p
	return { ...p, calmar_ratio: p.sharpe_ratio }
}

/**
 * SOTA 比较器（evaluate_backtest 与 get_run_summary 共用同一语义）：
 * 1. evaluation.score 高者优先
 * 2. 同分比 annual_return_pct（缺省视为 -Infinity）
 * 3. 年化也相同且双方都有 complexity 时，低复杂度优先（防过拟合）
 * 4. 以上全部相同：现任者保持不变（先到先得）
 *
 * 返回 true 表示 challenger 应取代 incumbent。
 */
export function isBetterVariant(
	challenger: {
		score: number
		annual_return_pct?: number
		complexity?: number
	},
	incumbent: {
		score: number
		annual_return_pct?: number
		complexity?: number
	},
): boolean {
	if (challenger.score !== incumbent.score) {
		return challenger.score > incumbent.score
	}
	const cAnnual = challenger.annual_return_pct ?? Number.NEGATIVE_INFINITY
	const iAnnual = incumbent.annual_return_pct ?? Number.NEGATIVE_INFINITY
	if (cAnnual !== iAnnual) return cAnnual > iAnnual
	if (
		challenger.complexity !== undefined &&
		incumbent.complexity !== undefined &&
		challenger.complexity !== incumbent.complexity
	) {
		return challenger.complexity < incumbent.complexity
	}
	return false
}

export function evaluateBacktest(
	performances: BacktestPerformance[],
	thresholds: Thresholds,
): EvaluationResult {
	if (performances.length === 0) {
		return { passed: false, bestVariantId: null, score: 0, details: {} }
	}

	const normalizedThresholds = normalizeThresholds(thresholds)

	const scored = performances.map((raw) => {
		const p = normalizePerformance(raw)
		const details: EvaluationResult["details"] = {}
		let passCount = 0
		let totalCount = 0

		for (const [key, threshold] of Object.entries(normalizedThresholds)) {
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

	// 最优选择：score → annual_return_pct → complexity（低优先），
	// 与 get_run_summary 的 SOTA 语义对齐；全部相同则保留先出现者
	const best = scored.reduce((prev, curr) =>
		isBetterVariant(curr, prev) ? curr : prev,
	)

	return {
		passed: best.allPassed,
		bestVariantId: best.variantId,
		score: best.score,
		details: best.details,
	}
}
