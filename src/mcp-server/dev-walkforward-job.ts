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
// dev walkforward 异步 job
//
// run_dev_walkforward 的窗口循环总时长超过 MCP 客户端超时（实测 ~5 分钟），
// 同步实现超时后变"幽灵任务"：服务端继续跑但调用方无结果、无进度。
// 因此改为 job 模式：工具入口只做前置校验 + 快照配置 + 落盘 job 文件
//（<workspace>/<runId>/dev-walkforward-job.json，仿 validation-state.json 先例），
// 立即返回 jobId；窗口循环后台执行，进度实时写回 job 文件，
// 调用方用 get_dev_walkforward_job 轮询。
// ============================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { evaluateBacktest } from "./backtest-evaluator.ts"
import { get, post, put } from "./client.ts"
import {
	type BriefFile,
	getExperimentTrace,
	getResearchBrief,
	recordExperiment,
} from "./research-run.ts"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
	getWorkspaceRoot,
} from "./strategy-files.ts"
import {
	type BacktestConfigSnapshot,
	priorConfigToRestoreBody,
} from "./validation-gate.ts"
import {
	type WalkforwardWindowResult,
	type WalkforwardWindowSpec,
	summarizeWalkforward,
} from "./walkforward-eval.ts"

/** 单窗口回测轮询间隔 */
const TASK_POLL_INTERVAL_MS = 5_000
/** 单窗口回测超时上限（与同步回测的 30 分钟一致） */
const WINDOW_TIMEOUT_MS = 30 * 60_000

export interface DevWalkforwardJobWindow {
	window: WalkforwardWindowSpec
	status: "pending" | "running" | "success" | "error"
	metrics?: Record<string, number | undefined>
	evaluation?: { passed: boolean; score: number }
	error?: string
}

export interface DevWalkforwardJob {
	jobId: string
	runId: string
	variantId: string
	status: "running" | "success" | "error"
	currentWindowIndex: number
	totalWindows: number
	windows: DevWalkforwardJobWindow[]
	startedAt: string
	updatedAt: string
	finishedAt?: string
	error?: string
	/** 完成后写入的 type=dev trace 条目（recordExperiment 返回） */
	traceEntry?: unknown
	/** 完成后的迭代预算（brief 含 evolving_n 时） */
	budget?: { evolvingN: number; used: number; remaining: number } | null
}

export interface DevWalkforwardJobParams {
	runId: string
	variantId: string
	hypothesis: string
	changes?: string
	lesson?: string
}

function jobPath(runId: string): string {
	assertSafePathComponent(runId, "runId")
	return assertInsideWorkspace(
		join(getWorkspaceRoot(), runId, "dev-walkforward-job.json"),
	)
}

function writeJob(job: DevWalkforwardJob): void {
	job.updatedAt = new Date().toISOString()
	const path = jobPath(job.runId)
	writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`, "utf-8")
}

/** 读取 job 文件；不存在返回 null（readDevWalkforwardJob 的工具语义是报错） */
function tryReadJob(runId: string): DevWalkforwardJob | null {
	const path = jobPath(runId)
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as DevWalkforwardJob
	} catch {
		throw new Error(`dev-walkforward-job.json 不是合法 JSON: ${path}`)
	}
}

/** get_dev_walkforward_job 工具语义：无 job 文件时报错提示 */
export function readDevWalkforwardJob(runId: string): DevWalkforwardJob {
	const job = tryReadJob(runId)
	if (!job) {
		throw new Error(
			`无此 run 的 dev walkforward job（runId=${runId}）：请先调用 run_dev_walkforward`,
		)
	}
	return job
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询异步回测任务直到 success/error/超时；success 返回 task data */
async function pollBacktestTask(
	taskId: string,
	pollIntervalMs: number,
	windowTimeoutMs: number,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + windowTimeoutMs
	while (true) {
		const resp = (await get(
			`/mcp/backtest/task?taskId=${encodeURIComponent(taskId)}`,
		)) as Record<string, unknown>
		const data = resp?.data as Record<string, unknown> | undefined
		if (data?.status === "success") return data
		if (data?.status === "error") {
			throw new Error(
				`窗口回测失败: ${(data.artifactError as string) ?? (data.stderrTail as string) ?? "内核执行失败"}`,
			)
		}
		if (Date.now() > deadline) {
			throw new Error(
				`窗口回测超时（>${Math.round(windowTimeoutMs / 60_000)} 分钟），taskId=${taskId}`,
			)
		}
		await sleep(pollIntervalMs)
	}
}

/**
 * 后台执行窗口循环：逐窗口切配置 → 异步回测 → 取绩效 → 评估，
 * 每推进一个窗口更新 job 文件；全部完成后恢复配置并写 type=dev trace。
 * 整体 try/catch/finally：异常时 job 落 error，配置恢复一定执行。
 */
export async function executeDevWalkforwardJob(
	job: DevWalkforwardJob,
	brief: BriefFile,
	prior: BacktestConfigSnapshot,
	params: DevWalkforwardJobParams,
	opts: { pollIntervalMs?: number; windowTimeoutMs?: number } = {},
): Promise<void> {
	const pollIntervalMs = opts.pollIntervalMs ?? TASK_POLL_INTERVAL_MS
	const windowTimeoutMs = opts.windowTimeoutMs ?? WINDOW_TIMEOUT_MS
	const results: WalkforwardWindowResult[] = []
	let lastKernelVersion: string | undefined
	try {
		for (let i = 0; i < job.windows.length; i++) {
			const jw = job.windows[i]
			job.currentWindowIndex = i
			jw.status = "running"
			writeJob(job)
			try {
				// 窗口只有 start_date/end_date/initial_cash 三字段，其余（过滤等）不动
				await put("/mcp/backtest/config", { ...jw.window })
				const runResp = (await post(
					"/mcp/backtest/run-async",
					undefined,
					60_000,
				)) as Record<string, unknown>
				const taskId = (runResp?.data as Record<string, unknown> | undefined)
					?.taskId as string | undefined
				if (!taskId) throw new Error("run-async 未返回 taskId")
				const taskData = await pollBacktestTask(
					taskId,
					pollIntervalMs,
					windowTimeoutMs,
				)
				if (typeof taskData.kernelVersion === "string") {
					lastKernelVersion = taskData.kernelVersion
				}
				const perf = (await get("/mcp/backtest/performance")) as Record<
					string,
					unknown
				>
				const parsed = (perf?.data as Record<string, unknown>)?.parsed as
					| Record<string, number>
					| undefined
				if (!parsed) {
					throw new Error("回测成功但未产出绩效数据")
				}
				const r = evaluateBacktest(
					[{ variantId: job.variantId, ...parsed }],
					brief.thresholds,
				)
				jw.status = "success"
				jw.metrics = parsed
				jw.evaluation = { passed: r.passed, score: r.score }
				results.push({
					window: jw.window,
					ok: true,
					metrics: parsed,
					evaluation: jw.evaluation,
				})
			} catch (error) {
				// 失败窗口计 0，继续下一窗口
				const message = error instanceof Error ? error.message : String(error)
				jw.status = "error"
				jw.error = message
				results.push({ window: jw.window, ok: false, error: message })
			}
			writeJob(job)
		}

		// 全部窗口失败不写 trace
		if (results.every((r) => !r.ok)) {
			job.status = "error"
			job.error = "所有窗口回测均失败，未写 trace（回测配置已恢复）"
			return
		}

		const summary = summarizeWalkforward(results)
		const recorded = recordExperiment(job.runId, {
			variantId: job.variantId,
			hypothesis: params.hypothesis,
			changes: params.changes,
			lesson: params.lesson,
			metrics: summary.metrics,
			evaluation: { passed: summary.passed, score: summary.score },
			windows: results,
			worstWindow: summary.worstWindow ?? undefined,
			kernelVersion: lastKernelVersion,
		})
		job.status = "success"
		job.traceEntry = recorded.entry
		job.budget = recorded.budget
	} catch (error) {
		job.status = "error"
		job.error = error instanceof Error ? error.message : String(error)
	} finally {
		// 恢复原回测配置：恢复失败静默，不掩盖主流程结果
		await put("/mcp/backtest/config", priorConfigToRestoreBody(prior)).catch(
			() => {},
		)
		job.finishedAt = new Date().toISOString()
		writeJob(job)
	}
}

/**
 * run_dev_walkforward 入口：前置校验（brief/walkforward/预算/并发）→
 * 快照当前回测配置 → 落盘 job 文件 → 后台执行，立即返回 jobId。
 */
export async function startDevWalkforwardJob(
	params: DevWalkforwardJobParams,
): Promise<{
	jobId: string
	runId: string
	variantId: string
	status: "running"
	totalWindows: number
	hint: string
}> {
	const { runId, variantId } = params
	const brief = getResearchBrief(runId)
	if (!brief) {
		throw new Error(`run 不存在或无 brief.json: ${runId}`)
	}
	if (!brief.walkforward) {
		throw new Error(
			`brief.json 未配置 walkforward（runId=${runId}），请使用 record_experiment 记录单窗口实验`,
		)
	}

	// 迭代预算预检：预算尽时不起任何回测（硬闸门口径与 record_experiment 一致）
	if (brief.evolving_n !== undefined) {
		const devCount = getExperimentTrace(runId).entries.filter(
			(e) => e.type === "dev",
		).length
		if (devCount >= brief.evolving_n) {
			throw new Error(
				`迭代预算已用完（evolving_n=${brief.evolving_n}），请先 close_run 或提高预算`,
			)
		}
	}

	// 防并发重入：同 runId 已有 running job 时报错
	const existing = tryReadJob(runId)
	if (existing?.status === "running") {
		throw new Error(
			`已有进行中的 dev walkforward job（runId=${runId}, jobId=${existing.jobId}），请用 get_dev_walkforward_job 查看进度`,
		)
	}

	// 快照当前回测配置；后台循环结束后恢复（finally）
	const configResp = (await get("/mcp/backtest/config")) as Record<
		string,
		unknown
	>
	const prior = (configResp?.data ?? {}) as BacktestConfigSnapshot

	const now = new Date().toISOString()
	const job: DevWalkforwardJob = {
		jobId: `dwf-${Date.now().toString(36)}`,
		runId,
		variantId,
		status: "running",
		currentWindowIndex: 0,
		totalWindows: brief.walkforward.windows.length,
		windows: brief.walkforward.windows.map((w) => ({
			window: {
				start_date: w.start_date,
				end_date: w.end_date ?? null,
				...(w.initial_cash !== undefined
					? { initial_cash: w.initial_cash }
					: {}),
			},
			status: "pending",
		})),
		startedAt: now,
		updatedAt: now,
	}
	writeJob(job)
	void executeDevWalkforwardJob(job, brief, prior, params).catch(() => {})

	return {
		jobId: job.jobId,
		runId,
		variantId,
		status: "running",
		totalWindows: job.totalWindows,
		hint: "用 get_dev_walkforward_job 轮询",
	}
}
