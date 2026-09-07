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
// walkforward 汇总评估（纯函数模块，不依赖 Hono/MCP，便于单测）
//
// dev 闭环的 walkforward 口径（详见
// docs/superpowers/specs/2026-07-25-walkforward-dev-loop-design.md）：
// - 每个窗口单独按 brief.thresholds 评估出 {passed, score}
// - 实验 score = min(各窗口 score)，失败窗口按 score=0 参与取 min
// - 顶层 metrics 取最劣窗口（score 升序 → 年化升序）的完整指标
// - passed = (min score === 1)，与 evaluateBacktest 的 allPassed 语义一致
// ============================================================

export interface WalkforwardWindowSpec {
	start_date: string
	end_date?: string | null
	initial_cash?: number
}

export interface WalkforwardWindowResult {
	window: WalkforwardWindowSpec
	ok: boolean
	error?: string
	metrics?: Record<string, number | undefined>
	evaluation?: { passed: boolean; score: number }
}

export interface WalkforwardSummary {
	/** min(各窗口 score)，失败窗口计 0 */
	score: number
	/** score === 1（全部窗口全阈值达标） */
	passed: boolean
	/** 驱动汇总结论的最劣窗口；results 为空时为 null */
	worstWindow: { start_date: string; end_date: string | null } | null
	/** 最劣窗口的完整指标；最劣窗口为失败窗口时缺省 */
	metrics?: Record<string, number | undefined>
}

/** 单个窗口的比较键：失败窗口 score=0、年化视为 -Infinity（必成最劣） */
function windowKey(r: WalkforwardWindowResult): {
	score: number
	annual: number
} {
	if (r.ok && r.evaluation) {
		return {
			score: r.evaluation.score,
			annual: r.metrics?.annual_return_pct ?? Number.NEGATIVE_INFINITY,
		}
	}
	return { score: 0, annual: Number.NEGATIVE_INFINITY }
}

/**
 * 汇总分窗口结果为最劣窗口口径。
 * 调用方需保证「全部窗口失败」已在更上层拦截（不写 trace）；
 * 本函数对该情况返回 score=0 / passed=false / worstWindow=首个失败窗口。
 */
export function summarizeWalkforward(
	results: WalkforwardWindowResult[],
): WalkforwardSummary {
	let worstIdx = -1
	let worstKey = {
		score: Number.POSITIVE_INFINITY,
		annual: Number.POSITIVE_INFINITY,
	}

	for (let i = 0; i < results.length; i++) {
		const key = windowKey(results[i])
		if (
			key.score < worstKey.score ||
			(key.score === worstKey.score && key.annual < worstKey.annual)
		) {
			worstKey = key
			worstIdx = i
		}
	}

	if (worstIdx < 0) {
		return { score: 0, passed: false, worstWindow: null }
	}

	const worst = results[worstIdx]
	const score = worstKey.score
	return {
		score,
		passed: score === 1,
		worstWindow: {
			start_date: worst.window.start_date,
			end_date: worst.window.end_date ?? null,
		},
		metrics: worst.ok ? worst.metrics : undefined,
	}
}
