/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { type ZodType, z } from "zod"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
	getWorkspaceRoot,
} from "./strategy-files.ts"

// ============================================================
// Schema 与类型
// ============================================================

const METRIC_KEYS = [
	"annual_return_pct",
	"max_drawdown_pct",
	"sharpe_ratio",
	"win_rate_pct",
	"profit_loss_ratio",
] as const

export type MetricKey = (typeof METRIC_KEYS)[number]

const metricsSchema = z.object({
	annual_return_pct: z.number().optional(),
	max_drawdown_pct: z.number().optional(),
	sharpe_ratio: z.number().optional(),
	win_rate_pct: z.number().optional(),
	profit_loss_ratio: z.number().optional(),
})

export const researchBriefSchema = z.object({
	goal: z.string().min(1),
	universe: z.string().optional(),
	thresholds: metricsSchema,
	backtest: z
		.object({
			initial_cash: z.number().optional(),
			start_date: z.string().optional(),
			end_date: z.string().nullable().optional(),
			filter_kcb: z.string().optional(),
			filter_cyb: z.string().optional(),
			filter_bj: z.string().optional(),
		})
		.optional(),
	constraints: z.array(z.string()).optional(),
	evolving_n: z.number().int().positive().optional(),
})

export const experimentEntrySchema = z.object({
	ts: z.string().optional(),
	variantId: z.string().min(1),
	hypothesis: z.string().min(1),
	changes: z.string().optional(),
	files: z.array(z.string()).optional(),
	metrics: metricsSchema.optional(),
	evaluation: z
		.object({
			passed: z.boolean(),
			score: z.number().min(0).max(1),
		})
		.optional(),
	verdict: z.enum(["completed", "sota", "failed"]),
	lesson: z.string().optional(),
})

export type ResearchBrief = z.infer<typeof researchBriefSchema>
export type ExperimentEntry = z.infer<typeof experimentEntrySchema>

export type BriefFile = ResearchBrief & { runId: string; createdAt: string }

// ============================================================
// 内部工具
// ============================================================

function parseWith<T>(schema: ZodType<T>, data: unknown, label: string): T {
	const result = schema.safeParse(data)
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ")
		throw new Error(`${label} 校验失败: ${issues}`)
	}
	return result.data
}

function runDir(runId: string): string {
	assertSafePathComponent(runId, "runId")
	return assertInsideWorkspace(join(getWorkspaceRoot(), runId))
}

function briefPath(runId: string): string {
	return assertInsideWorkspace(join(runDir(runId), "brief.json"))
}

function tracePath(runId: string): string {
	return assertInsideWorkspace(join(runDir(runId), "trace.jsonl"))
}

function readTraceEntries(runId: string): ExperimentEntry[] {
	const path = tracePath(runId)
	if (!existsSync(path)) return []
	const lines = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim())
	return lines.map((line, index) => {
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			throw new Error(`trace.jsonl 第 ${index + 1} 行不是合法 JSON`)
		}
		return parseWith(
			experimentEntrySchema,
			parsed,
			`trace.jsonl 第 ${index + 1} 行`,
		)
	})
}

function readBriefFile(runId: string): BriefFile | null {
	const path = briefPath(runId)
	if (!existsSync(path)) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"))
	} catch {
		throw new Error(`brief.json 不是合法 JSON: ${path}`)
	}
	return parseWith(
		researchBriefSchema.extend({ runId: z.string(), createdAt: z.string() }),
		parsed,
		"brief.json",
	)
}

function metricPassed(
	key: MetricKey,
	value: number,
	threshold: number,
): boolean {
	return key === "max_drawdown_pct"
		? Math.abs(value) <= Math.abs(threshold)
		: value >= threshold
}

function metricGap(key: MetricKey, value: number, threshold: number): number {
	return key === "max_drawdown_pct"
		? Math.abs(threshold) - Math.abs(value)
		: value - threshold
}

// ============================================================
// 对外 API
// ============================================================

export function createResearchRun(
	runId: string,
	brief: unknown,
): { runId: string; briefPath: string; brief: BriefFile } {
	const dir = runDir(runId)
	if (existsSync(dir)) {
		throw new Error(`run 已存在，不会覆盖: ${runId}`)
	}
	const parsed = parseWith(researchBriefSchema, brief, "brief")
	const full: BriefFile = {
		...parsed,
		runId,
		createdAt: new Date().toISOString(),
	}
	mkdirSync(dir, { recursive: true })
	const path = briefPath(runId)
	writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, "utf-8")
	return { runId, briefPath: path, brief: full }
}

export function recordExperiment(
	runId: string,
	entry: unknown,
): { runId: string; tracePath: string; entry: ExperimentEntry } {
	const dir = runDir(runId)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	const parsed = parseWith(experimentEntrySchema, entry, "entry")
	const full: ExperimentEntry = {
		...parsed,
		ts: parsed.ts ?? new Date().toISOString(),
	}
	const path = tracePath(runId)
	appendFileSync(path, `${JSON.stringify(full)}\n`, "utf-8")
	return { runId, tracePath: path, entry: full }
}

export function getExperimentTrace(
	runId: string,
	tail?: number,
): { runId: string; total: number; entries: ExperimentEntry[] } {
	const entries = readTraceEntries(runId)
	const sliced = tail !== undefined && tail > 0 ? entries.slice(-tail) : entries
	return { runId, total: entries.length, entries: sliced }
}

// getRunSummary 汇总一个 run 的 brief、trace、SOTA 与阈值差距。
export interface ThresholdGap {
	value: number | null
	threshold: number
	passed: boolean
	gap: number | null
}

export interface RunSummary {
	runId: string
	hasBrief: boolean
	totalExperiments: number
	verdictCounts: Record<"completed" | "sota" | "failed", number>
	sota: {
		variantId: string
		hypothesis: string
		score: number
		metrics: ExperimentEntry["metrics"]
	} | null
	thresholdGaps: Partial<Record<MetricKey, ThresholdGap>> | null
	trends: Record<MetricKey, Array<{ variantId: string; value: number }>>
}

export function getRunSummary(runId: string): RunSummary {
	const brief = readBriefFile(runId)
	const entries = readTraceEntries(runId)

	const verdictCounts = { completed: 0, sota: 0, failed: 0 }
	for (const e of entries) {
		verdictCounts[e.verdict]++
	}

	// SOTA：只在有 evaluation 的实验中比较，
	// 先比 evaluation.score，再比 annual_return_pct
	let sotaEntry: ExperimentEntry | null = null
	for (const e of entries) {
		if (!e.evaluation) continue
		if (!sotaEntry) {
			sotaEntry = e
			continue
		}
		const scoreDiff =
			(e.evaluation?.score ?? 0) - (sotaEntry.evaluation?.score ?? 0)
		if (scoreDiff > 0) {
			sotaEntry = e
			continue
		}
		if (scoreDiff === 0) {
			const challenger =
				e.metrics?.annual_return_pct ?? Number.NEGATIVE_INFINITY
			const current =
				sotaEntry.metrics?.annual_return_pct ?? Number.NEGATIVE_INFINITY
			if (challenger > current) {
				sotaEntry = e
			}
		}
	}

	const trends = Object.fromEntries(
		METRIC_KEYS.map((key) => [
			key,
			entries.flatMap((e) => {
				const value = e.metrics?.[key]
				return typeof value === "number"
					? [{ variantId: e.variantId, value }]
					: []
			}),
		]),
	) as RunSummary["trends"]

	let thresholdGaps: RunSummary["thresholdGaps"] = null
	if (brief && sotaEntry) {
		thresholdGaps = {}
		for (const key of METRIC_KEYS) {
			const threshold = brief.thresholds[key]
			if (threshold === undefined) continue
			const value = sotaEntry.metrics?.[key]
			thresholdGaps[key] = {
				value: value ?? null,
				threshold,
				passed:
					value === undefined ? false : metricPassed(key, value, threshold),
				gap: value === undefined ? null : metricGap(key, value, threshold),
			}
		}
	}

	return {
		runId,
		hasBrief: brief !== null,
		totalExperiments: entries.length,
		verdictCounts,
		sota: sotaEntry
			? {
					variantId: sotaEntry.variantId,
					hypothesis: sotaEntry.hypothesis,
					score: sotaEntry.evaluation?.score ?? 0,
					metrics: sotaEntry.metrics,
				}
			: null,
		thresholdGaps,
		trends,
	}
}
