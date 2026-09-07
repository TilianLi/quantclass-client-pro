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
// 回测诊断：从资金曲线计算分年度收益与回撤区间
// 纯函数模块，不依赖 Hono/MCP，便于单测
// ============================================================

export interface EquityPoint {
	/** YYYY-MM-DD */
	date: string
	nav: number
}

/**
 * 把资金曲线 CSV 的记录行（{交易日期, 净值, ...}）映射为净值序列。
 * 缺日期或净值非法的行直接跳过。
 */
export function parseEquityRows(
	rows: Array<Record<string, unknown>>,
): EquityPoint[] {
	const points: EquityPoint[] = []
	for (const row of rows) {
		const date = String(row.交易日期 ?? "").trim()
		const nav = Number(row.净值)
		if (!date || Number.isNaN(nav)) continue
		points.push({ date, nav })
	}
	return points
}

export interface YearlyReturn {
	year: string
	returnPct: number
}

/**
 * 分年度收益：首年从首个净值算起，之后每年从上一年末净值算起（链式）。
 */
export function computeYearlyReturns(points: EquityPoint[]): YearlyReturn[] {
	if (points.length === 0) return []
	const lastNavByYear = new Map<string, number>()
	for (const p of points) {
		lastNavByYear.set(p.date.slice(0, 4), p.nav)
	}
	const result: YearlyReturn[] = []
	let prevYearEndNav: number | null = null
	for (const [year, lastNav] of lastNavByYear) {
		const base = prevYearEndNav ?? points[0].nav
		prevYearEndNav = lastNav
		if (base === 0) continue
		result.push({
			year,
			returnPct: round2((lastNav / base - 1) * 100),
		})
	}
	return result
}

export interface DrawdownEpisode {
	peakDate: string
	troughDate: string
	/** 回撤深度（负数百分比，如 -25.41） */
	depthPct: number
	/** 净值回到前高之上的首个日期；未修复为 null */
	recoveryDate: string | null
	/** 峰值→谷底自然日数 */
	peakToTroughDays: number
	/** 谷底→修复自然日数；未修复为 null */
	recoveryDays: number | null
}

/**
 * 提取回撤区间：峰值 → 谷底 → 修复（或至今未修复）。
 * 按深度从深到浅排序，返回前 topN 段。
 */
export function computeDrawdownEpisodes(
	points: EquityPoint[],
	topN = 3,
): DrawdownEpisode[] {
	if (points.length === 0) return []

	const episodes: DrawdownEpisode[] = []
	let peakNav = points[0].nav
	let peakDate = points[0].date
	let open: {
		peakDate: string
		peakNav: number
		troughDate: string
		troughNav: number
	} | null = null

	const close = (recoveryDate: string | null) => {
		if (!open) return
		episodes.push({
			peakDate: open.peakDate,
			troughDate: open.troughDate,
			depthPct: round2((open.troughNav / open.peakNav - 1) * 100),
			recoveryDate,
			peakToTroughDays: daysBetween(open.peakDate, open.troughDate),
			recoveryDays: recoveryDate
				? daysBetween(open.troughDate, recoveryDate)
				: null,
		})
		open = null
	}

	for (const p of points.slice(1)) {
		if (open === null) {
			if (p.nav >= peakNav) {
				peakNav = p.nav
				peakDate = p.date
			} else {
				open = {
					peakDate,
					peakNav,
					troughDate: p.date,
					troughNav: p.nav,
				}
			}
		} else {
			if (p.nav < open.troughNav) {
				open.troughNav = p.nav
				open.troughDate = p.date
			}
			if (p.nav >= open.peakNav) {
				close(p.date)
				peakNav = p.nav
				peakDate = p.date
			}
		}
	}
	close(null)

	episodes.sort((a, b) => a.depthPct - b.depthPct)
	return episodes.slice(0, Math.max(1, topN))
}

function round2(x: number): number {
	return Math.round(x * 100) / 100
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
}
