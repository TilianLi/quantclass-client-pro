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
	readdirSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { type ZodType, z } from "zod"
import { isBetterVariant } from "./backtest-evaluator.ts"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
	getWorkspaceRoot,
} from "./strategy-files.ts"

// ============================================================
// Schema 与类型
// ============================================================

// 工作流标准指标键。calmar_ratio（年化收益/最大回撤）为规范名；
// sharpe_ratio 是历史误名（实为同一 Calmar 口径），仅作输入兼容保留。
const METRIC_KEYS = [
	"annual_return_pct",
	"max_drawdown_pct",
	"calmar_ratio",
	"win_rate_pct",
	"profit_loss_ratio",
] as const

export type MetricKey = (typeof METRIC_KEYS)[number]

const metricsSchema = z.object({
	annual_return_pct: z.number().optional(),
	max_drawdown_pct: z.number().optional(),
	calmar_ratio: z.number().optional(),
	/** @deprecated sharpe_ratio 实为「年化收益/回撤比」口径，请改用 calmar_ratio */
	sharpe_ratio: z.number().optional(),
	win_rate_pct: z.number().optional(),
	profit_loss_ratio: z.number().optional(),
})

const backtestWindowSchema = z.object({
	initial_cash: z.number().optional(),
	start_date: z.string().optional(),
	end_date: z.string().nullable().optional(),
	filter_kcb: z.string().optional(),
	filter_cyb: z.string().optional(),
	filter_bj: z.string().optional(),
})

/**
 * walkforward 窗口：backtestWindowSchema 的子集（板块过滤沿用当前回测配置）。
 * start_date 必填；end_date 可空（null=回测至今）。
 */
const walkforwardWindowSchema = z.object({
	start_date: z.string().min(1),
	end_date: z.string().nullable().optional(),
	initial_cash: z.number().optional(),
})

/**
 * dev 闭环的 walkforward 配置。至少 2 个窗口（1 个窗口等于没做）；
 * 日期必须可解析且 start_date < end_date（end 非空时）。
 */
const walkforwardSchema = z
	.object({
		windows: z.array(walkforwardWindowSchema).min(2),
	})
	.superRefine((val, ctx) => {
		val.windows.forEach((w, i) => {
			const start = Date.parse(w.start_date)
			if (Number.isNaN(start)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["windows", i, "start_date"],
					message: `无法解析的日期: ${w.start_date}`,
				})
				return
			}
			if (w.end_date == null) return
			const end = Date.parse(w.end_date)
			if (Number.isNaN(end)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["windows", i, "end_date"],
					message: `无法解析的日期: ${w.end_date}`,
				})
			} else if (start >= end) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["windows", i],
					message: "start_date 必须早于 end_date",
				})
			}
		})
	})

export const researchBriefSchema = z.object({
	goal: z.string().min(1),
	universe: z.string().optional(),
	thresholds: metricsSchema,
	backtest: backtestWindowSchema.optional(),
	validation: backtestWindowSchema.optional(),
	/** dev 迭代的 walkforward 多窗口检验；配置后带绩效的 dev 实验必须走 run_dev_walkforward */
	walkforward: walkforwardSchema.optional(),
	constraints: z.array(z.string()).optional(),
	evolving_n: z.number().int().positive().optional(),
})

export const experimentEntrySchema = z.object({
	ts: z.string().optional(),
	variantId: z.string().min(1),
	hypothesis: z.string().min(1),
	/** 分叉父 variantId（缺省视为上一 variant，保持线性语义） */
	basedOn: z.string().optional(),
	/** 假设来源引用，推荐 knowledge:<id> / trace:<runId>/<variantId> / none */
	hypothesisSource: z.string().optional(),
	/** 预埋给下一轮的假设种子（对应 RD-Agent feedback 阶段的 new_hypothesis） */
	nextHypothesis: z.string().optional(),
	changes: z.string().optional(),
	files: z.array(z.string()).optional(),
	/** 实验类型：dev=迭代实验（缺省按 dev 处理），validation=终局样本外验证（不进 SOTA/趋势） */
	type: z.enum(["dev", "validation"]).optional(),
	/**
	 * walkforward 分窗口明细（run_dev_walkforward 写入）。
	 * brief 配置 walkforward 后，带绩效的 dev 条目必须携带本字段。
	 */
	windows: z
		.array(
			z.object({
				window: walkforwardWindowSchema,
				ok: z.boolean(),
				error: z.string().optional(),
				metrics: metricsSchema.optional(),
				evaluation: z
					.object({
						passed: z.boolean(),
						score: z.number().min(0).max(1),
					})
					.optional(),
			}),
		)
		.optional(),
	/** 驱动汇总结论的最劣窗口（score 升序 → 年化升序选出） */
	worstWindow: z
		.object({
			start_date: z.string(),
			end_date: z.string().nullable().optional(),
		})
		.optional(),
	metrics: metricsSchema.optional(),
	evaluation: z
		.object({
			passed: z.boolean(),
			score: z.number().min(0).max(1),
		})
		.optional(),
	/**
	 * 结论。缺省时自动判定：
	 * - validation 条目 → completed
	 * - 无 metrics 且无 evaluation → failed
	 * - 有 evaluation 且成为当前最优（score→年化→复杂度） → sota，否则 completed
	 */
	verdict: z.enum(["completed", "sota", "failed"]).optional(),
	lesson: z.string().optional(),
	kernelVersion: z.string().optional(),
	complexity: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			"旋钮计数（factor_list+filter_list+filter_list_post+cross_sections 条目数）。缺省时自动从 variant 的 config.py 统计",
		),
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

type Metrics = z.infer<typeof metricsSchema>

/**
 * 指标别名归一化：calmar_ratio 缺省时用 sharpe_ratio（历史误名）回填。
 * 两个键都保留在对象里，旧读取方（含历史 trace）不受影响。
 */
function normalizeMetrics<T extends Metrics | undefined>(metrics: T): T {
	if (!metrics) return metrics
	if (
		metrics.calmar_ratio === undefined &&
		typeof metrics.sharpe_ratio === "number"
	) {
		return { ...metrics, calmar_ratio: metrics.sharpe_ratio }
	}
	return metrics
}

/**
 * 本地时间 ISO 格式（带时区偏移），如 2026-07-23T02:36:24+08:00。
 * trace/brief 需要人工阅读，避免 UTC Zulu 时间造成的时区换算负担。
 */
export function localTimestamp(d = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0")
	const offsetMin = -d.getTimezoneOffset()
	const sign = offsetMin >= 0 ? "+" : "-"
	const abs = Math.abs(offsetMin)
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	)
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
		const entry = parseWith(
			experimentEntrySchema,
			parsed,
			`trace.jsonl 第 ${index + 1} 行`,
		)
		// 历史 trace 缺 type（按 dev 处理）、只有 sharpe_ratio 键（归一化出 calmar_ratio）
		return {
			...entry,
			type: entry.type ?? "dev",
			metrics: normalizeMetrics(entry.metrics),
		}
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
	const brief = parseWith(
		researchBriefSchema.extend({ runId: z.string(), createdAt: z.string() }),
		parsed,
		"brief.json",
	)
	// 历史 brief 的 thresholds 可能只有 sharpe_ratio，读取时归一化
	return { ...brief, thresholds: normalizeMetrics(brief.thresholds) }
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

const LESSON_PLACEHOLDER = /^(待回填|待定|暂无|无|tbd|todo|n\/a|none)[。.\s]*$/i

/** lesson 是进化循环的核心载体，占位文本拒绝写入（只拦写入，不影响历史条目读取） */
function assertLessonNotPlaceholder(lesson: string | undefined): void {
	if (lesson !== undefined && LESSON_PLACEHOLDER.test(lesson.trim())) {
		throw new Error(
			`lesson 为占位文本（"${lesson}"）：请写具体结论——哪个指标未达、差距多少、下一步假设方向`,
		)
	}
}

/** 字符 bigram Jaccard 相似度（归一化后），用于假设查重警告 */
export function hypothesisSimilarity(a: string, b: string): number {
	const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")
	const grams = (s: string) => {
		const g = new Set<string>()
		for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2))
		return g
	}
	const sa = grams(norm(a))
	const sb = grams(norm(b))
	if (sa.size === 0 || sb.size === 0) return 0
	let inter = 0
	for (const g of sa) if (sb.has(g)) inter++
	return inter / (sa.size + sb.size - inter)
}

// ============================================================
// 复杂度自动统计
// ============================================================

const KNOB_LIST_KEYS = [
	"factor_list",
	"filter_list",
	"filter_list_post",
	"cross_sections",
]

/**
 * 统计 config.py 文本中的"旋钮数"：
 * factor_list / filter_list / filter_list_post / cross_sections
 * 四个列表的顶层条目数之和（每个嵌套列表计 1）。
 *
 * 这是启发式计数（按方括号深度扫描，不解析 Python AST），
 * 只用于同分时的防过拟合 tie-break，不要求精确。
 */
export function countConfigKnobs(configText: string): number {
	let total = 0
	for (const key of KNOB_LIST_KEYS) {
		// 兼容 `"factor_list": [`（dict 形式）与 `factor_list = [`（赋值形式）。
		// key 后紧跟的字符必须是引号/冒号/等号之一，避免 filter_list 命中 filter_list_post
		const re = new RegExp(`${key}["']?\\s*[:=]\\s*\\[`, "g")
		while (true) {
			const m = re.exec(configText)
			if (m === null) break
			total += countDepthOneItems(configText, m.index + m[0].length - 1)
		}
	}
	return total
}

/** openIdx 指向列表的 "["；返回该列表深度 1 处嵌套 "[" 的数量 */
function countDepthOneItems(text: string, openIdx: number): number {
	let depth = 0
	let count = 0
	for (let i = openIdx; i < text.length; i++) {
		const ch = text[i]
		if (ch === "[") {
			depth++
			if (depth === 2) count++
		} else if (ch === "]") {
			depth--
			if (depth === 0) break
		}
	}
	return count
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
		// 落盘即归一化：sharpe_ratio（旧名）并入 calmar_ratio（新名）
		thresholds: normalizeMetrics(parsed.thresholds),
		runId,
		createdAt: new Date().toISOString(),
	}
	mkdirSync(dir, { recursive: true })
	const path = briefPath(runId)
	writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, "utf-8")
	return { runId, briefPath: path, brief: full }
}

export interface RecordExperimentResult {
	runId: string
	tracePath: string
	entry: ExperimentEntry
	/** 迭代预算（brief 含 evolving_n 时返回）：dev 条目计数与剩余轮次 */
	budget: { evolvingN: number; used: number; remaining: number } | null
	/** 非阻断警告（如假设与历史条目近似重复） */
	warnings?: string[]
}

export function recordExperiment(
	runId: string,
	entry: unknown,
): RecordExperimentResult {
	const dir = runDir(runId)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	const parsed = parseWith(experimentEntrySchema, entry, "entry")

	assertLessonNotPlaceholder(parsed.lesson)

	const warnings: string[] = []
	const priorEntries = readTraceEntries(runId)
	for (const e of priorEntries) {
		if (hypothesisSimilarity(parsed.hypothesis, e.hypothesis) > 0.7) {
			warnings.push(
				`假设与 ${e.variantId} 高度相似（相似度>0.7）："${e.hypothesis.slice(0, 50)}..."——请确认不是重复实验`,
			)
		}
	}

	// brief 读取一次，供 walkforward 强制拦截与迭代预算共用
	const brief = readBriefFile(runId)

	// metrics 别名归一化（sharpe_ratio → calmar_ratio）
	const metrics = normalizeMetrics(parsed.metrics)

	// complexity 缺省时从 variant 的 config.py 自动统计
	let complexity = parsed.complexity
	if (complexity === undefined) {
		try {
			const configPath = assertInsideWorkspace(
				join(dir, parsed.variantId, "config.py"),
			)
			if (existsSync(configPath)) {
				complexity = countConfigKnobs(readFileSync(configPath, "utf-8"))
			}
		} catch {
			// variantId 非法或文件不可读 —— complexity 保持缺省，不阻断记录
		}
	}

	const full: ExperimentEntry = {
		...parsed,
		type: parsed.type ?? "dev",
		metrics,
		complexity,
		ts: parsed.ts ?? localTimestamp(),
	}

	// walkforward 强制拦截：brief 配置 walkforward 后，带绩效的 dev 条目必须
	// 经 run_dev_walkforward 写入（含分窗口明细），防止绕过最劣窗口口径。
	// 例外：无 metrics 且无 evaluation 的失败记录（回测未跑起来）可直接写入。
	if (
		brief?.walkforward &&
		full.type === "dev" &&
		(full.metrics !== undefined || full.evaluation !== undefined) &&
		full.windows === undefined
	) {
		throw new Error(
			`brief 已配置 walkforward（runId=${runId}）：带绩效的 dev 实验必须通过 run_dev_walkforward 记录（含分窗口明细）；仅记录失败实验（无 metrics/evaluation）可直接使用 record_experiment`,
		)
	}

	// verdict 缺省时自动判定（显式传入永远优先）
	if (full.verdict === undefined) {
		full.verdict = autoVerdict(full, priorEntries)
	}

	const path = tracePath(runId)
	appendFileSync(path, `${JSON.stringify(full)}\n`, "utf-8")

	// 迭代预算：只计 dev 条目；validation 不消耗轮次
	let budget: RecordExperimentResult["budget"] = null
	if (brief?.evolving_n !== undefined) {
		const devCount = readTraceEntries(runId).filter(
			(e) => e.type === "dev",
		).length
		budget = {
			evolvingN: brief.evolving_n,
			used: devCount,
			remaining: brief.evolving_n - devCount,
		}
	}

	return { runId, tracePath: path, entry: full, budget, warnings }
}

/**
 * 自动判定 verdict：
 * - validation 条目固定 completed（不参与 SOTA 竞争）
 * - 无 metrics 且无 evaluation → failed
 * - 有 evaluation：成为当前最优（与历史 dev 条目比 score→年化→复杂度）→ sota，否则 completed
 * - 仅有 metrics → completed
 */
function autoVerdict(
	candidate: ExperimentEntry,
	existing: ExperimentEntry[],
): "completed" | "sota" | "failed" {
	if (candidate.type === "validation") return "completed"
	if (!candidate.metrics && !candidate.evaluation) return "failed"
	if (!candidate.evaluation) return "completed"

	const cand = {
		score: candidate.evaluation.score,
		annual_return_pct: candidate.metrics?.annual_return_pct,
		complexity: candidate.complexity,
	}
	let best: typeof cand | null = null
	for (const e of existing) {
		if (e.type === "validation" || !e.evaluation) continue
		const cur = {
			score: e.evaluation.score,
			annual_return_pct: e.metrics?.annual_return_pct,
			complexity: e.complexity,
		}
		if (!best || isBetterVariant(cur, best)) best = cur
	}
	return !best || isBetterVariant(cand, best) ? "sota" : "completed"
}

export function getExperimentTrace(
	runId: string,
	tail?: number,
): { runId: string; total: number; entries: ExperimentEntry[] } {
	const entries = readTraceEntries(runId)
	const sliced = tail !== undefined && tail > 0 ? entries.slice(-tail) : entries
	return { runId, total: entries.length, entries: sliced }
}

/** 读取 run 的 brief（含 calmar 归一化），不存在返回 null。供 validation 闸门等外部模块使用。 */
export function getResearchBrief(runId: string): BriefFile | null {
	return readBriefFile(runId)
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
	/** 最近一次 type=validation 的样本外验证记录（不参与 SOTA/趋势） */
	validation: {
		variantId: string
		ts?: string
		metrics: ExperimentEntry["metrics"]
		evaluation: ExperimentEntry["evaluation"]
	} | null
	thresholdGaps: Partial<Record<MetricKey, ThresholdGap>> | null
	trends: Record<MetricKey, Array<{ variantId: string; value: number }>>
}

export function getRunSummary(runId: string): RunSummary {
	const brief = readBriefFile(runId)
	const entries = readTraceEntries(runId)
	// SOTA/趋势只看 dev 迭代；validation 是终局确认，单独汇报
	const devEntries = entries.filter((e) => e.type === "dev")

	const verdictCounts = { completed: 0, sota: 0, failed: 0 }
	for (const e of entries) {
		verdictCounts[e.verdict ?? "completed"]++
	}

	// SOTA：只在有 evaluation 的 dev 实验中比较，
	// 语义与 evaluate_backtest 一致（score → 年化 → 低复杂度）
	let sotaEntry: ExperimentEntry | null = null
	for (const e of devEntries) {
		if (!e.evaluation) continue
		if (!sotaEntry) {
			sotaEntry = e
			continue
		}
		if (
			isBetterVariant(
				{
					score: e.evaluation.score,
					annual_return_pct: e.metrics?.annual_return_pct,
					complexity: e.complexity,
				},
				{
					score: sotaEntry.evaluation?.score ?? 0,
					annual_return_pct: sotaEntry.metrics?.annual_return_pct,
					complexity: sotaEntry.complexity,
				},
			)
		) {
			sotaEntry = e
		}
	}

	const trends = Object.fromEntries(
		METRIC_KEYS.map((key) => [
			key,
			devEntries.flatMap((e) => {
				const value = e.metrics?.[key]
				return typeof value === "number"
					? [{ variantId: e.variantId, value }]
					: []
			}),
		]),
	) as RunSummary["trends"]

	const lastValidation = entries.findLast((e) => e.type === "validation")

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
		validation: lastValidation
			? {
					variantId: lastValidation.variantId,
					ts: lastValidation.ts,
					metrics: lastValidation.metrics,
					evaluation: lastValidation.evaluation,
				}
			: null,
		thresholdGaps,
		trends,
	}
}

// ============================================================
// run 生命周期
// ============================================================

export type RunStatus = "active" | "achieved" | "abandoned" | "paused"

/**
 * 关闭 run：把 status/closedAt/closeReason 写入 brief.json。
 * 读 brief 原文 JSON 合并写回（不经 schema strip，保留全部既有字段）。
 * achieved 要求存在 SOTA 记录；重复 close 允许（更新状态与原因）。
 */
export function closeRun(
	runId: string,
	status: Exclude<RunStatus, "active">,
	reason: string,
): { runId: string; status: RunStatus; closedAt: string } {
	const dir = runDir(runId)
	if (!existsSync(dir)) throw new Error(`run 不存在: ${runId}`)
	if (!reason || !reason.trim()) throw new Error("closeReason 必填")
	const path = briefPath(runId)
	if (!existsSync(path)) {
		throw new Error(`run ${runId} 缺少 brief.json，请先 create_research_run`)
	}
	// achieved 要求 trace 中存在 verdict=sota 的记录
	// （getRunSummary().sota 会回退到任意有 evaluation 的条目，口径太宽）
	if (status === "achieved" && getRunSummary(runId).verdictCounts.sota === 0) {
		throw new Error(`run ${runId} 无 SOTA 记录，不能以 achieved 关闭`)
	}
	let raw: Record<string, unknown>
	try {
		raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	} catch {
		throw new Error(`brief.json 不是合法 JSON: ${path}`)
	}
	const closedAt = localTimestamp()
	writeFileSync(
		path,
		`${JSON.stringify({ ...raw, status, closedAt, closeReason: reason.trim() }, null, 2)}\n`,
		"utf-8",
	)
	return { runId, status, closedAt }
}

/** 各 run 的状态映射（无 brief 或无 status 字段的 run 不出现）。供 list_strategies 组装。 */
export function getRunStatuses(): Record<
	string,
	{ status: RunStatus; closeReason?: string }
> {
	const result: Record<string, { status: RunStatus; closeReason?: string }> = {}
	for (const name of readdirSync(getWorkspaceRoot(), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)) {
		const path = join(getWorkspaceRoot(), name, "brief.json")
		if (!existsSync(path)) continue
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
				string,
				unknown
			>
			if (
				typeof raw.status === "string" &&
				["achieved", "abandoned", "paused"].includes(raw.status)
			) {
				result[name] = {
					status: raw.status as RunStatus,
					closeReason:
						typeof raw.closeReason === "string" ? raw.closeReason : undefined,
				}
			}
		} catch {
			// 单个 run 的 brief 损坏不影响整体列表
		}
	}
	return result
}
