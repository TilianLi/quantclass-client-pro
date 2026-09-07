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
// RD 循环编排状态机（get_loop_state）
//
// 把 runbook 的控制流显式化为可查询的状态机：phase 完全从可观察产物
// （brief.json / trace.jsonl / dev-walkforward-job.json / validation-state.json /
// variant 目录 / candidate-report.md）推导，不存任何额外状态——
// 会话中断后重调一次即可恢复现场。设计文档：
// docs/superpowers/plans/2026-08-26-hypothesis-direction-mechanism.md
//
// 多 Agent 用法：主 agent 每轮先调 get_loop_state(runId)，按 phase 分派
// 对应角色的子代理——dispatch 字段是注入运行时上下文后可直接转发的完整
// 子代理 prompt（含 expects 输出契约与 onReturn 后续动作），playbook 字段
// 是该角色的原始 prompt 资产。子代理执行后重调 get_loop_state 进入下一阶段。
// ============================================================

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tryReadDevWalkforwardJob } from "./dev-walkforward-job.ts"
import {
	DEVELOPER_PLAYBOOK,
	EVALUATOR_PLAYBOOK,
	PHASE_PLAYBOOKS,
	RESEARCHER_PLAYBOOK,
} from "./loop-playbook.ts"
import {
	type ExperimentEntry,
	getExperimentTrace,
	getResearchBrief,
	getRunSummary,
} from "./research-run.ts"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
	getWorkspaceRoot,
	listVariants,
} from "./strategy-files.ts"
import { readValidationState } from "./validation-gate.ts"

export type LoopPhase =
	/** run 已关闭（brief.status 为 achieved/abandoned/paused） */
	| "closed"
	/** validation 闸门进行中（validation-state.json 存在） */
	| "validation_running"
	/** dev walkforward job 进行中 */
	| "walkforward_running"
	/** walkforward 已写 trace，待 Summarizer 回填结构化结论（amend_experiment） */
	| "await_summary"
	/** 有 variant 目录但无 trace 记录，待实现/导入/回测 */
	| "await_backtest"
	/** 循环退出条件满足且有 SOTA，待样本外验证（brief 配了 validation） */
	| "await_validation"
	/** 样本外已完成，待提交人工评审 */
	| "await_review"
	/** 评审完成或循环退出且无 SOTA，待 close_run */
	| "await_close"
	/** 默认阶段：待 Researcher 提出下一轮假设 */
	| "await_hypothesis"

export interface LoopAction {
	tool: string
	note: string
	args?: Record<string, unknown>
}

/**
 * 可直接转发的子代理分派指令：prompt 是注入运行时上下文后的完整
 * 子代理 prompt（编排器只需补占位符部分，如 Researcher 输出的假设 JSON）。
 */
export interface LoopDispatch {
	role: "researcher" | "developer" | "evaluator" | "summarizer"
	/** 完整子代理 prompt（含本字段上方注入的任务上下文） */
	prompt: string
	/** 子代理应返回的 JSON 契约摘要 */
	expects: string
	/** 编排器拿到子代理返回后的动作 */
	onReturn: string
}

export interface LoopState {
	runId: string
	phase: LoopPhase
	/** 迭代预算（brief 含 evolving_n 时） */
	budget: { evolvingN: number; used: number; remaining: number } | null
	/** 连续 2 条 dev 条目非 sota（跳过 failed）——触发规则书转向条款 */
	plateau: boolean
	/** 下一个可用的 variantId（vN 数字递增，failed 占号） */
	nextVariantId: string
	sota: {
		variantId: string
		score: number
		metrics: ExperimentEntry["metrics"]
	} | null
	/** 进行中的 walkforward job（无则 null） */
	pendingJob: {
		jobId: string
		status: string
		currentWindowIndex: number
		totalWindows: number
	} | null
	validationDone: boolean
	reviewDone: boolean
	nextActions: LoopAction[]
	/** 当前阶段对应的角色 playbook（无 LLM 角色的阶段为 null） */
	playbook: string | null
	/** 可直接转发的子代理分派指令（无 LLM 角色的阶段为 null） */
	dispatch: LoopDispatch | null
}

/**
 * plateau 判定：从最新 dev 条目向前数，连续 completed（非 sota）≥ 2 即为平台期。
 * failed 条目跳过（执行失败不代表方向无改进）；遇到 sota 即清零终止。
 */
export function computePlateau(entries: ExperimentEntry[]): boolean {
	let streak = 0
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]
		if (e.type !== "dev") continue
		if (e.verdict === "failed") continue
		if (e.verdict === "sota") break
		streak++
		if (streak >= 2) return true
	}
	return false
}

/** 下一个 variantId：扫描 variant 目录与 trace 条目里的 vN，取最大序号 +1 */
export function nextVariantId(
	existing: Iterable<string>,
	entries: ExperimentEntry[],
): string {
	let max = 0
	const scan = (name: string) => {
		const m = /^v(\d+)$/.exec(name)
		if (m) max = Math.max(max, Number.parseInt(m[1], 10))
	}
	for (const v of existing) scan(v)
	for (const e of entries) scan(e.variantId)
	return `v${max + 1}`
}

function candidateReportExists(runId: string): boolean {
	return existsSync(
		assertInsideWorkspace(
			join(getWorkspaceRoot(), runId, "candidate-report.md"),
		),
	)
}

/**
 * 读 brief.json 原始 JSON 的 status 字段（readBriefFile 经 schema 解析会剥离
 * status/closedAt/closeReason，closeRun 是 raw 合并写入的，这里对应 raw 读回）。
 */
function readBriefStatusRaw(runId: string): string | null {
	assertSafePathComponent(runId, "runId")
	const path = assertInsideWorkspace(
		join(getWorkspaceRoot(), runId, "brief.json"),
	)
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
			string,
			unknown
		>
		return typeof raw.status === "string" ? raw.status : null
	} catch {
		return null
	}
}

// ============================================================
// dispatch 构造：把运行时上下文注入角色 playbook，产出可直接转发的子代理 prompt
// ============================================================

function injectContext(playbook: string, ctx: Record<string, string>): string {
	const lines = Object.entries(ctx).map(([k, v]) => `- ${k}: ${v}`)
	return `# 任务上下文（get_loop_state 注入，以下事实无需再查）\n\n${lines.join("\n")}\n\n${playbook}`
}

type SotaDigest = LoopState["sota"]

function fmtSota(sota: SotaDigest): string {
	if (!sota) return "无"
	const m = sota.metrics
	return `${sota.variantId}（score ${sota.score}，年化 ${m?.annual_return_pct ?? "?"}%，回撤 ${m?.max_drawdown_pct ?? "?"}%，Calmar ${m?.calmar_ratio ?? "?"}）`
}

function researcherDispatch(
	runId: string,
	nextVariantId: string,
	plateau: boolean,
	sota: SotaDigest,
	budget: LoopState["budget"],
): LoopDispatch {
	return {
		role: "researcher",
		prompt: injectContext(RESEARCHER_PLAYBOOK, {
			runId,
			"本轮 variantId": nextVariantId,
			plateau: plateau ? "true（本轮 action 不得为 tune_param）" : "false",
			"当前 SOTA": fmtSota(sota),
			迭代预算: budget
				? `剩 ${budget.remaining}/${budget.evolvingN} 轮`
				: "不限",
		}),
		expects:
			"假设 JSON：{ variantId, action, hypothesis, factorSpec?, hypothesisSource, changes, nextHypothesis? }",
		onReturn:
			"校验假设 JSON 后写入 variant 目录（或转 Developer 子代理），然后重调 get_loop_state",
	}
}

function developerDispatch(runId: string, variantId: string): LoopDispatch {
	return {
		role: "developer",
		prompt: injectContext(DEVELOPER_PLAYBOOK, {
			runId,
			variantId,
			"backtest_name / 策略 name": `${runId}_${variantId}`,
			假设JSON: "<编排器在此粘贴 Researcher 输出的假设 JSON>",
		}),
		expects: '{ filesWritten, validation: "passed|failed", notes }',
		onReturn:
			"validation=passed 后由编排器按 nextActions 执行 Runner 步骤（import_strategy → set_strategy_weight 隔离 → 触发回测）；failed 超 3 次修正则记 failed 进下一轮",
	}
}

function evaluatorDispatch(
	runId: string,
	job: NonNullable<ReturnType<typeof tryReadDevWalkforwardJob>>,
	sota: SotaDigest,
): LoopDispatch {
	const windowLines = job.windows
		.map((w) => {
			const m = w.metrics
			const span = `${w.window.start_date}~${w.window.end_date ?? "今"}`
			return m
				? `  ${span}：年化 ${m.annual_return_pct ?? "?"}%，回撤 ${m.max_drawdown_pct ?? "?"}%，Calmar ${m.calmar_ratio ?? "?"}%，score ${w.evaluation?.score ?? "?"}`
				: `  ${span}：${w.status}${w.error ? `（${w.error}）` : ""}`
		})
		.join("\n")
	return {
		role: "evaluator",
		prompt: injectContext(EVALUATOR_PLAYBOOK, {
			runId,
			variantId: job.variantId,
			窗口指标摘要: `\n${windowLines}`,
			"当前 SOTA": fmtSota(sota),
		}),
		expects:
			"{ verdictMeaning, observations, hypothesisEvaluation, lessonRewrite?, nextHypothesis?, knowledgeCandidate }",
		onReturn:
			"把输出转交 Summarizer 子代理（SUMMARIZER playbook）或编排器直接落盘：amend_experiment 回填字段，knowledgeCandidate 非 null 时 record_knowledge",
	}
}

export function getLoopState(runId: string): LoopState {
	const brief = getResearchBrief(runId)
	if (!brief) {
		throw new Error(
			`run 不存在或无 brief.json: ${runId}（请先 create_research_run）`,
		)
	}
	const { entries } = getExperimentTrace(runId)
	const summary = getRunSummary(runId)
	const devEntries = entries.filter((e) => e.type === "dev")
	const budget =
		brief.evolving_n !== undefined
			? {
					evolvingN: brief.evolving_n,
					used: devEntries.length,
					remaining: brief.evolving_n - devEntries.length,
				}
			: null
	const plateau = computePlateau(entries)
	const sota = summary.sota
		? {
				variantId: summary.sota.variantId,
				score: summary.sota.score,
				metrics: summary.sota.metrics,
			}
		: null
	const validationDone = summary.validation !== null
	const reviewDone = candidateReportExists(runId)

	const base: Omit<
		LoopState,
		"phase" | "nextActions" | "playbook" | "dispatch"
	> = {
		runId,
		budget,
		plateau,
		nextVariantId: nextVariantId(listVariants(runId), entries),
		sota,
		pendingJob: null,
		validationDone,
		reviewDone,
	}

	// 1. 已关闭
	const closedStatus = readBriefStatusRaw(runId)
	if (
		closedStatus !== null &&
		["achieved", "abandoned", "paused"].includes(closedStatus)
	) {
		return {
			...base,
			phase: "closed",
			nextActions: [
				{
					tool: "close_run",
					note: `run 已关闭（${closedStatus}）；改判用 close_run force=true，继续研究请新开 run`,
				},
			],
			playbook: null,
			dispatch: null,
		}
	}

	// 2. validation 闸门进行中
	const validationState = readValidationState(runId)
	if (validationState) {
		return {
			...base,
			phase: "validation_running",
			nextActions: [
				{
					tool: "get_backtest_task",
					args: { taskId: validationState.taskId },
					note: "轮询 validation 回测任务",
				},
				{
					tool: "complete_validation",
					args: { runId, variantId: sota?.variantId },
					note: "回测成功后调用：恢复原配置并记录 type=validation 条目",
				},
			],
			playbook: null,
			dispatch: null,
		}
	}

	// 3. walkforward job 进行中 / 完成待回填结论
	const job = tryReadDevWalkforwardJob(runId)
	if (job?.status === "running") {
		return {
			...base,
			pendingJob: {
				jobId: job.jobId,
				status: job.status,
				currentWindowIndex: job.currentWindowIndex,
				totalWindows: job.totalWindows,
			},
			phase: "walkforward_running",
			nextActions: [
				{
					tool: "get_dev_walkforward_job",
					args: { runId },
					note: "轮询窗口进度；status=success 后进入 await_summary",
				},
			],
			playbook: null,
			dispatch: null,
		}
	}
	if (job?.status === "success") {
		const last = entries[entries.length - 1]
		const pendingSummary =
			last?.variantId === job.variantId &&
			(last.observations === undefined ||
				last.hypothesisEvaluation === undefined)
		if (pendingSummary) {
			return {
				...base,
				phase: "await_summary",
				nextActions: [
					{
						tool: "amend_experiment",
						args: { runId, variantId: job.variantId },
						note: "Evaluator 子代理产出结论 → Summarizer 用 amend_experiment 落盘（链见 dispatch.onReturn）",
					},
				],
				playbook: PHASE_PLAYBOOKS.await_summary,
				dispatch: evaluatorDispatch(runId, job, sota),
			}
		}
	}

	// 4. 循环退出条件：预算耗尽 或 最近一条带评估的 dev 条目已达标
	const budgetExhausted =
		brief.evolving_n !== undefined && devEntries.length >= brief.evolving_n
	const goalReached =
		devEntries.findLast((e) => e.evaluation)?.evaluation?.passed === true
	if (budgetExhausted || goalReached) {
		if (!sota) {
			return {
				...base,
				phase: "await_close",
				nextActions: [
					{
						tool: "close_run",
						args: { runId, status: "abandoned" },
						note: "无 SOTA 记录：以 abandoned 关闭并把负面发现写入 record_knowledge",
					},
				],
				playbook: null,
				dispatch: null,
			}
		}
		if (brief.validation && !validationDone) {
			return {
				...base,
				phase: "await_validation",
				nextActions: [
					{
						tool: "import_strategy",
						note: `恢复 SOTA（${sota.variantId}）的 config.py 并用 set_strategy_weight 设权重，再调 run_validation`,
					},
					{
						tool: "run_validation",
						args: { runId, variantId: sota.variantId },
						note: "启动样本外闸门（当前回测策略与 variant 不一致会报错，先完成上一步）",
					},
				],
				playbook: null,
				dispatch: null,
			}
		}
		if (!reviewDone) {
			return {
				...base,
				phase: "await_review",
				nextActions: [
					{
						tool: "submit_strategy_for_review",
						args: { runId, variantId: sota.variantId },
						note: "生成候选报告（有 validation 结果时附 oosEvaluation/oosWindow/oosNote）",
					},
				],
				playbook: null,
				dispatch: null,
			}
		}
		return {
			...base,
			phase: "await_close",
			nextActions: [
				{
					tool: "close_run",
					args: { runId, status: "achieved" },
					note: "评审完成，以 achieved 关闭并附一句话原因",
				},
			],
			playbook: null,
			dispatch: null,
		}
	}

	// 5. 有 variant 目录但无 trace 记录（实现未完成或回测未触发）
	const tracedIds = new Set(entries.map((e) => e.variantId))
	const untraced = listVariants(runId)
		.filter((v) => /^v\d+$/.test(v) && !tracedIds.has(v))
		.sort(
			(a, b) =>
				Number.parseInt(a.slice(1), 10) - Number.parseInt(b.slice(1), 10),
		)
	const pendingVariant = untraced[untraced.length - 1]
	if (pendingVariant) {
		return {
			...base,
			phase: "await_backtest",
			nextActions: [
				{
					tool: "validate_strategy",
					note: `校验 ${pendingVariant}/config.py（Developer 子代理职责）`,
				},
				{
					tool: "import_strategy",
					note: `导入 ${pendingVariant}（不传 capWeight）——Runner 步骤，编排器执行`,
				},
				{
					tool: "set_strategy_weight",
					note: `启用 ${runId}_${pendingVariant} 并 others_except 一键隔离其余组（Runner 步骤）`,
				},
				{
					tool: brief.walkforward ? "run_dev_walkforward" : "run_backtest",
					args: { runId, variantId: pendingVariant },
					note:
						job?.status === "error"
							? `上次 job 失败：${job.error}`
							: "触发回测（Runner 步骤）",
				},
			],
			playbook: PHASE_PLAYBOOKS.await_backtest,
			dispatch: developerDispatch(runId, pendingVariant),
		}
	}

	// 6. 默认：提出下一轮假设
	return {
		...base,
		phase: "await_hypothesis",
		nextActions: [
			{
				tool: "record_experiment",
				note: plateau
					? "plateau=true：按假设规则书，下一轮 action 不得为 tune_param"
					: "按 dispatch 分派 Researcher 子代理产出假设 JSON，然后进入实现阶段",
			},
		],
		playbook: PHASE_PLAYBOOKS.await_hypothesis,
		dispatch: researcherDispatch(
			runId,
			base.nextVariantId,
			plateau,
			sota,
			budget,
		),
	}
}
