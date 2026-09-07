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
// compare_backtest_variants 的绩效解析
//
// 旧实现只读 回测结果/<backtest_name>/策略评价.csv——该目录被内核按名
// 覆盖写，walkforward 后只剩最后窗口残留，与 get_run_summary 的最劣窗口
// SOTA 口径分裂。现改为：variant 在 trace.jsonl 有带 metrics 的 dev 记录时，
// 优先取最近一次 dev 条目的 metrics（与 SOTA 同口径，source="trace"）；
// 无记录才回退读 CSV（source="csv"）。
// ============================================================

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	type BacktestPerformance,
	performanceCsvToMetrics,
} from "./backtest-evaluator.ts"
import { getExperimentTrace } from "./research-run.ts"
import { getWorkspaceRoot } from "./strategy-files.ts"
import { validateStrategy } from "./strategy-validator.ts"

export interface VariantPerformance extends BacktestPerformance {
	/** 指标来源：trace=最近一次 dev 实验（最劣窗口口径）；csv=策略评价.csv 残留 */
	source: "trace" | "csv"
}

export interface ResolveVariantPerformancesResult {
	performances: VariantPerformance[]
	errors: string[]
	validationWarnings: string[]
}

export function resolveVariantPerformances(
	runId: string,
	variantIds: string[],
	quantDataPath?: string,
): ResolveVariantPerformancesResult {
	const dataRoot =
		quantDataPath || process.env.ALL_DATA_PATH || "D:/QuantClassSpace/QuantData"
	const workspaceRoot = getWorkspaceRoot()
	const performances: VariantPerformance[] = []
	const errors: string[] = []
	const validationWarnings: string[] = []

	// trace 读取失败（如文件损坏）不阻断对比，按无 trace 记录回退 CSV
	let traceEntries: ReturnType<typeof getExperimentTrace>["entries"] = []
	try {
		traceEntries = getExperimentTrace(runId).entries
	} catch {
		// trace 不可读时全部回退 CSV 口径
	}

	for (const variantId of variantIds) {
		const traceHit = traceEntries.findLast(
			(e) => e.variantId === variantId && e.type === "dev" && e.metrics,
		)

		const configPath = join(workspaceRoot, runId, variantId, "config.py")
		const configExists = existsSync(configPath)
		let backtestName = `${runId}_${variantId}`
		if (configExists) {
			const validation = validateStrategy(configPath)
			backtestName =
				(validation.extracted?.backtest_name as string) || backtestName
			if (!validation.valid) {
				// 校验失败不阻断对比，但必须对外可见（此前静默吞掉，
				// 配置真出错时会产出错误的对比结论）
				validationWarnings.push(
					`${variantId}（backtest_name 取 ${backtestName}）: ${validation.errors.join("；")}`,
				)
			}
		}

		if (traceHit?.metrics) {
			performances.push({
				variantId,
				...traceHit.metrics,
				complexity: traceHit.complexity,
				source: "trace",
			})
			continue
		}

		if (!configExists) {
			errors.push(`config.py 不存在: ${variantId}`)
			continue
		}
		const csvPath = join(
			dataRoot,
			"real_trading",
			"data",
			"回测结果",
			backtestName,
			"策略评价.csv",
		)
		if (!existsSync(csvPath)) {
			errors.push(`策略评价.csv 不存在: ${variantId} (${backtestName})`)
			continue
		}
		const csvText = readFileSync(csvPath, "utf-8")
		performances.push({
			...performanceCsvToMetrics(variantId, csvText),
			source: "csv",
		})
	}

	return { performances, errors, validationWarnings }
}
