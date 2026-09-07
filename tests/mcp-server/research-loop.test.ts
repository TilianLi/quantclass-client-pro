import assert from "node:assert"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-loop-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const { createResearchRun, recordExperiment, amendExperiment } = await import(
	"../../src/mcp-server/research-run.ts"
)
const { getLoopState } = await import("../../src/mcp-server/research-loop.ts")

const BRIEF = {
	goal: "测试循环状态机",
	thresholds: { annual_return_pct: 10, calmar_ratio: 0.5 },
	evolving_n: 2,
}

function writeJob(runId: string, job: Record<string, unknown>) {
	writeFileSync(
		join(TMP, runId, "dev-walkforward-job.json"),
		`${JSON.stringify(job)}\n`,
	)
}

describe("research-loop", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("throws when run missing", () => {
		assert.throws(() => getLoopState("run-nope"), /不存在/)
	})

	it("fresh run → await_hypothesis with researcher playbook and dispatch", () => {
		createResearchRun("run-loop-a", BRIEF)
		const s = getLoopState("run-loop-a")
		assert.strictEqual(s.phase, "await_hypothesis")
		assert.strictEqual(s.nextVariantId, "v1")
		assert.deepStrictEqual(s.budget, { evolvingN: 2, used: 0, remaining: 2 })
		assert.strictEqual(s.plateau, false)
		assert.ok(s.playbook?.includes("Researcher"))
		// dispatch：可直接转发的子代理 prompt，已注入运行时上下文
		assert.strictEqual(s.dispatch?.role, "researcher")
		assert.ok(s.dispatch?.prompt.includes("run-loop-a"))
		assert.ok(s.dispatch?.prompt.includes("本轮 variantId: v1"))
		assert.ok(s.dispatch?.prompt.includes("plateau: false"))
		assert.ok(s.dispatch?.expects.includes("假设 JSON"))
		assert.ok(s.dispatch?.onReturn)
	})

	it("variant dir without trace entry → await_backtest", () => {
		mkdirSync(join(TMP, "run-loop-a", "v1"), { recursive: true })
		writeFileSync(
			join(TMP, "run-loop-a", "v1", "config.py"),
			'backtest_name = "run-loop-a_v1"\n',
		)
		const s = getLoopState("run-loop-a")
		assert.strictEqual(s.phase, "await_backtest")
		assert.ok(s.playbook?.includes("Developer"))
		assert.ok(s.nextActions.some((a) => a.tool === "validate_strategy"))
		// dispatch 为 developer，prompt 注入 runId/variantId/隔离命名
		assert.strictEqual(s.dispatch?.role, "developer")
		assert.ok(s.dispatch?.prompt.includes("run-loop-a_v1"))
		assert.ok(s.dispatch?.prompt.includes("假设 JSON"))
	})

	it("closed run → closed phase", () => {
		createResearchRun("run-loop-closed", BRIEF)
		// 直接 raw 写入 status（closeRun 的 achieved 需要 SOTA，这里只测状态机推导）
		const briefPath = join(TMP, "run-loop-closed", "brief.json")
		const raw = JSON.parse(readFileSync(briefPath, "utf-8")) as Record<
			string,
			unknown
		>
		writeFileSync(briefPath, JSON.stringify({ ...raw, status: "achieved" }))
		const s = getLoopState("run-loop-closed")
		assert.strictEqual(s.phase, "closed")
	})

	it("plateau: 连续2条非sota dev 条目触发，sota 或 failed 重置", () => {
		createResearchRun("run-loop-b", { ...BRIEF, evolving_n: 5 })
		recordExperiment("run-loop-b", {
			variantId: "v1",
			hypothesis: "基线动量策略",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: false, score: 0.5 },
		}) // 首条带评估 → sota
		recordExperiment("run-loop-b", {
			variantId: "v2",
			hypothesis: "收紧过滤阈值",
			metrics: { annual_return_pct: 10 },
			evaluation: { passed: false, score: 0.5 },
		}) // completed（score 同、年化更低）
		assert.strictEqual(getLoopState("run-loop-b").plateau, false)
		recordExperiment("run-loop-b", {
			variantId: "v3",
			hypothesis: "再收紧过滤阈值",
			metrics: { annual_return_pct: 10 },
			evaluation: { passed: false, score: 0.5 },
		}) // completed
		assert.strictEqual(getLoopState("run-loop-b").plateau, true)
		// failed 条目不重置 plateau
		recordExperiment("run-loop-b", {
			variantId: "v4",
			hypothesis: "回测失败的尝试",
		})
		assert.strictEqual(getLoopState("run-loop-b").plateau, true)
	})

	it("running walkforward job → walkforward_running with pendingJob", () => {
		createResearchRun("run-loop-c", BRIEF)
		writeJob("run-loop-c", {
			jobId: "dwf-test",
			runId: "run-loop-c",
			variantId: "v1",
			status: "running",
			currentWindowIndex: 0,
			totalWindows: 2,
			windows: [],
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		const s = getLoopState("run-loop-c")
		assert.strictEqual(s.phase, "walkforward_running")
		assert.strictEqual(s.pendingJob?.jobId, "dwf-test")
	})

	it("job success + 条目缺结构化结论 → await_summary，amend 后进入下一阶段", () => {
		recordExperiment("run-loop-c", {
			variantId: "v1",
			hypothesis: "双窗口检验",
			metrics: { annual_return_pct: 12 },
			evaluation: { passed: false, score: 0.5 },
			lesson: "预测性 lesson",
			windows: [
				{
					window: { start_date: "2023-01-01", end_date: "2023-12-31" },
					ok: true,
					metrics: { annual_return_pct: 12 },
					evaluation: { passed: false, score: 0.5 },
				},
				{
					window: { start_date: "2024-01-01", end_date: "2024-12-31" },
					ok: true,
					metrics: { annual_return_pct: 13 },
					evaluation: { passed: false, score: 0.5 },
				},
			],
		})
		writeJob("run-loop-c", {
			jobId: "dwf-test",
			runId: "run-loop-c",
			variantId: "v1",
			status: "success",
			currentWindowIndex: 1,
			totalWindows: 2,
			windows: [
				{
					window: { start_date: "2023-01-01", end_date: "2023-12-31" },
					status: "success",
					metrics: { annual_return_pct: 12, calmar_ratio: 0.8 },
					evaluation: { passed: false, score: 0.5 },
				},
			],
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		const s = getLoopState("run-loop-c")
		assert.strictEqual(s.phase, "await_summary")
		// 五角色拆分后，await_summary 的主角色是 Evaluator（Summarizer 负责落盘）
		assert.ok(s.playbook?.includes("Evaluator"))
		assert.strictEqual(s.dispatch?.role, "evaluator")
		// dispatch prompt 注入了窗口指标摘要，Evaluator 无需重跑回测即可判读
		assert.ok(s.dispatch?.prompt.includes("2023-01-01~2023-12-31"))
		assert.ok(s.dispatch?.prompt.includes("年化 12%"))
		assert.ok(s.dispatch?.expects.includes("observations"))
		// Summarizer 回填后推进到下一阶段（预算未尽、未达标 → await_hypothesis）
		amendExperiment("run-loop-c", "v1", {
			observations: "窗口1 年化 12%",
			hypothesisEvaluation: "假设部分支持",
		})
		assert.strictEqual(getLoopState("run-loop-c").phase, "await_hypothesis")
	})

	it("budget exhausted without sota → await_close (abandoned)", () => {
		createResearchRun("run-loop-d", { ...BRIEF, evolving_n: 1 })
		recordExperiment("run-loop-d", {
			variantId: "v1",
			hypothesis: "回测失败",
		})
		const s = getLoopState("run-loop-d")
		assert.strictEqual(s.phase, "await_close")
		assert.strictEqual(s.nextActions[0].args?.status, "abandoned")
	})

	it("goal reached + sota + validation 窗口 → await_validation → await_review → await_close", () => {
		createResearchRun("run-loop-e", {
			...BRIEF,
			evolving_n: 5,
			validation: { start_date: "2025-01-01", end_date: null },
		})
		recordExperiment("run-loop-e", {
			variantId: "v1",
			hypothesis: "达标假设",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: true, score: 1 },
		})
		assert.strictEqual(getLoopState("run-loop-e").phase, "await_validation")
		// validation 完成（写 type=validation 条目）
		recordExperiment("run-loop-e", {
			variantId: "v1",
			hypothesis: "validation 窗口样本外验证",
			type: "validation",
			metrics: { annual_return_pct: 18 },
			evaluation: { passed: true, score: 1 },
			observations: "样本外达标",
			hypothesisEvaluation: "假设样本外仍成立",
		})
		assert.strictEqual(getLoopState("run-loop-e").phase, "await_review")
		// 评审报告已生成
		writeFileSync(
			join(TMP, "run-loop-e", "candidate-report.md"),
			"# 候选策略报告\n",
		)
		const s = getLoopState("run-loop-e")
		assert.strictEqual(s.phase, "await_close")
		assert.strictEqual(s.nextActions[0].args?.status, "achieved")
	})
})
