import assert from "node:assert"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-research-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const {
	createResearchRun,
	recordExperiment,
	getExperimentTrace,
	getRunSummary,
} = await import("../../src/mcp-server/research-run.ts")

const BRIEF = {
	goal: "改进中证1000动量选股",
	universe: "中证1000",
	thresholds: { annual_return_pct: 15, max_drawdown_pct: 25 },
	backtest: { start_date: "2020-01-01", initial_cash: 1000000 },
	evolving_n: 3,
}

describe("research-run", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("creates a research run with brief.json", () => {
		const { briefPath, brief } = createResearchRun("run-a", BRIEF)
		assert.ok(briefPath.endsWith("brief.json"))
		assert.strictEqual(brief.runId, "run-a")
		assert.ok(brief.createdAt)
		const onDisk = JSON.parse(readFileSync(briefPath, "utf-8"))
		assert.strictEqual(onDisk.goal, BRIEF.goal)
		assert.strictEqual(onDisk.evolving_n, 3)
	})

	it("rejects duplicate run creation", () => {
		assert.throws(() => createResearchRun("run-a", BRIEF), /已存在/)
	})

	it("rejects invalid runId and invalid brief", () => {
		assert.throws(() => createResearchRun("..", BRIEF))
		assert.throws(() => createResearchRun("run-b", { thresholds: {} }), /goal/)
	})

	it("records experiments and fills ts", () => {
		const { entry } = recordExperiment("run-a", {
			variantId: "v1",
			hypothesis: "20日动量+低换手",
			metrics: { annual_return_pct: 12, max_drawdown_pct: -28 },
			evaluation: { passed: false, score: 0 },
			verdict: "completed",
			lesson: "拉长动量窗口",
		})
		assert.ok(entry.ts)
		recordExperiment("run-a", {
			variantId: "v2",
			hypothesis: "60日动量+波动率过滤",
			metrics: { annual_return_pct: 17, max_drawdown_pct: -22 },
			evaluation: { passed: true, score: 1 },
			verdict: "sota",
		})
	})

	it("rejects invalid entry", () => {
		assert.throws(
			() =>
				recordExperiment("run-a", {
					variantId: "v3",
					hypothesis: "x",
					verdict: "unknown",
				}),
			/entry/,
		)
	})

	it("reads trace with tail", () => {
		const full = getExperimentTrace("run-a")
		assert.strictEqual(full.total, 2)
		const last = getExperimentTrace("run-a", 1)
		assert.strictEqual(last.entries.length, 1)
		assert.strictEqual(last.entries[0].variantId, "v2")
	})

	it("returns empty trace for missing run", () => {
		const trace = getExperimentTrace("run-missing")
		assert.deepStrictEqual(trace, {
			runId: "run-missing",
			total: 0,
			entries: [],
		})
	})

	it("throws on malformed trace line", () => {
		writeFileSync(
			join(TMP, "run-a", "trace.jsonl"),
			'{"variantId":"v1","hypothesis":"x","verdict":"failed"}\nnot-json\n',
		)
		assert.throws(() => getExperimentTrace("run-a"), /第 2 行/)
	})

	it("summarizes run with sota, gaps and trends", () => {
		// 先恢复 Task 1 中被破坏的 trace.jsonl
		writeFileSync(
			join(TMP, "run-a", "trace.jsonl"),
			'{"ts":"2026-07-20T00:00:00.000Z","variantId":"v1","hypothesis":"20日动量+低换手","metrics":{"annual_return_pct":12,"max_drawdown_pct":-28},"evaluation":{"passed":false,"score":0},"verdict":"completed"}\n{"ts":"2026-07-20T01:00:00.000Z","variantId":"v2","hypothesis":"60日动量+波动率过滤","metrics":{"annual_return_pct":17,"max_drawdown_pct":-22},"evaluation":{"passed":true,"score":1},"verdict":"sota"}\n',
		)
		const summary = getRunSummary("run-a")
		assert.strictEqual(summary.hasBrief, true)
		assert.strictEqual(summary.totalExperiments, 2)
		assert.deepStrictEqual(summary.verdictCounts, {
			completed: 1,
			sota: 1,
			failed: 0,
		})
		assert.strictEqual(summary.sota?.variantId, "v2")
		const annualGap = summary.thresholdGaps?.annual_return_pct
		assert.strictEqual(annualGap?.passed, true)
		assert.strictEqual(annualGap?.gap, 2)
		const ddGap = summary.thresholdGaps?.max_drawdown_pct
		assert.strictEqual(ddGap?.passed, true) // |-22| <= 25
		assert.strictEqual(ddGap?.gap, 3)
		assert.deepStrictEqual(
			summary.trends.annual_return_pct.map((t) => t.value),
			[12, 17],
		)
	})

	it("summarizes run without brief", () => {
		recordExperiment("run-c", {
			variantId: "v1",
			hypothesis: "无 brief 的 run",
			verdict: "failed",
		})
		const summary = getRunSummary("run-c")
		assert.strictEqual(summary.hasBrief, false)
		assert.strictEqual(summary.thresholdGaps, null)
		assert.strictEqual(summary.sota, null)
		assert.deepStrictEqual(summary.verdictCounts, {
			completed: 0,
			sota: 0,
			failed: 1,
		})
	})

	it("prefers higher score then higher annual return as sota", () => {
		recordExperiment("run-d", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
		})
		recordExperiment("run-d", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 10 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
		})
		assert.strictEqual(getRunSummary("run-d").sota?.variantId, "v1")
	})

	it("accepts optional kernelVersion in entry", () => {
		const { entry } = recordExperiment("run-kv", {
			variantId: "v1",
			hypothesis: "h",
			verdict: "completed",
			kernelVersion: "zeus_bin_2.2.0",
		})
		assert.strictEqual(entry.kernelVersion, "zeus_bin_2.2.0")
	})

	it("creates a research run with validation window", () => {
		const { brief } = createResearchRun("run-val", {
			...BRIEF,
			validation: { start_date: "2025-01-01", end_date: null },
		})
		assert.strictEqual(brief.validation?.start_date, "2025-01-01")
		assert.strictEqual(brief.validation?.end_date, null)
	})

	it("prefers lower complexity over annual return on score tie", () => {
		recordExperiment("run-cx", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
			complexity: 8,
		})
		recordExperiment("run-cx", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 10 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
			complexity: 3,
		})
		assert.strictEqual(getRunSummary("run-cx").sota?.variantId, "v2")
	})

	it("falls back to annual return when complexity absent", () => {
		recordExperiment("run-cy", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
		})
		recordExperiment("run-cy", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 10 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
			complexity: 3,
		})
		assert.strictEqual(getRunSummary("run-cy").sota?.variantId, "v1")
	})
})
