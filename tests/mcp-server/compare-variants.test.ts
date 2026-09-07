import assert from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-cmp-"))
const DATA = mkdtempSync(join(tmpdir(), "qc-cmp-data-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const { createResearchRun, recordExperiment } = await import(
	"../../src/mcp-server/research-run.ts"
)
const { resolveVariantPerformances } = await import(
	"../../src/mcp-server/compare-variants.ts"
)

describe("compare-variants", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
		rmSync(DATA, { recursive: true, force: true })
	})

	it("trace 有 dev 记录时取最近一次 dev metrics（source=trace）", () => {
		createResearchRun("run-cmp", { goal: "口径对齐", thresholds: {} })
		mkdirSync(join(TMP, "run-cmp", "v1"), { recursive: true })
		writeFileSync(
			join(TMP, "run-cmp", "v1", "config.py"),
			'backtest_name = "run-cmp_v1"\nstrategy_list = []\n',
		)
		// 旧的 dev 记录
		recordExperiment("run-cmp", {
			variantId: "v1",
			hypothesis: "旧假设",
			metrics: { annual_return_pct: 10, max_drawdown_pct: -20 },
			evaluation: { passed: false, score: 0 },
		})
		// 最近一次 dev 记录（walkforward 最劣窗口口径）应被采用
		recordExperiment("run-cmp", {
			variantId: "v1",
			hypothesis: "新假设",
			metrics: { annual_return_pct: 22.23, max_drawdown_pct: -11.52 },
			evaluation: { passed: true, score: 1 },
		})

		const { performances, errors } = resolveVariantPerformances(
			"run-cmp",
			["v1"],
			DATA,
		)
		assert.deepStrictEqual(errors, [])
		assert.strictEqual(performances.length, 1)
		assert.strictEqual(performances[0].source, "trace")
		assert.strictEqual(performances[0].annual_return_pct, 22.23)
		assert.strictEqual(performances[0].max_drawdown_pct, -11.52)
	})

	it("无 trace 记录时回退读策略评价.csv（source=csv）", () => {
		mkdirSync(join(TMP, "run-cmp", "v2"), { recursive: true })
		writeFileSync(
			join(TMP, "run-cmp", "v2", "config.py"),
			'backtest_name = "run-cmp_v2"\nstrategy_list = []\n',
		)
		mkdirSync(join(DATA, "real_trading", "data", "回测结果", "run-cmp_v2"), {
			recursive: true,
		})
		writeFileSync(
			join(
				DATA,
				"real_trading",
				"data",
				"回测结果",
				"run-cmp_v2",
				"策略评价.csv",
			),
			"年化收益,24.0%\n最大回撤,-21.79%\n年化收益/回撤比,1.10\n胜率（含0/去0）,55.0%\n盈亏收益比,1.50\n",
		)

		const { performances, errors } = resolveVariantPerformances(
			"run-cmp",
			["v2"],
			DATA,
		)
		assert.deepStrictEqual(errors, [])
		assert.strictEqual(performances.length, 1)
		assert.strictEqual(performances[0].source, "csv")
		assert.strictEqual(performances[0].annual_return_pct, 24)
		assert.strictEqual(performances[0].max_drawdown_pct, -21.79)
	})

	it("无 trace 且无 CSV 时报错列入 errors", () => {
		mkdirSync(join(TMP, "run-cmp", "v3"), { recursive: true })
		writeFileSync(
			join(TMP, "run-cmp", "v3", "config.py"),
			'backtest_name = "run-cmp_v3"\nstrategy_list = []\n',
		)
		const { performances, errors } = resolveVariantPerformances(
			"run-cmp",
			["v3"],
			DATA,
		)
		assert.strictEqual(performances.length, 0)
		assert.ok(errors.some((e) => e.includes("策略评价.csv 不存在")))
	})
})
