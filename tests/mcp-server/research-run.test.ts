import assert from "node:assert"
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-research-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const {
	closeRun,
	createResearchRun,
	recordExperiment,
	getExperimentTrace,
	getRunStatuses,
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

	it("fills ts in local time with timezone offset (not UTC Zulu)", () => {
		const { entry } = recordExperiment("run-tz", {
			variantId: "v1",
			hypothesis: "本地时区标注",
			verdict: "completed",
		})
		// 形如 2026-07-23T02:36:24+08:00：本地时间 + 时区偏移，便于人工阅读 trace
		assert.match(
			entry.ts ?? "",
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
			`unexpected ts format: ${entry.ts}`,
		)
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

	it("prefers higher annual return over lower complexity on score tie", () => {
		// SOTA 语义与 evaluate_backtest 对齐：score → 年化 → 复杂度
		// （旧实现复杂度优先于年化，与 evaluate_backtest 相反，已统一）
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
		assert.strictEqual(getRunSummary("run-cx").sota?.variantId, "v1")
	})

	it("prefers lower complexity when score and annual both tie", () => {
		recordExperiment("run-ct", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 15 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
			complexity: 8,
		})
		recordExperiment("run-ct", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 15 },
			evaluation: { passed: false, score: 0.5 },
			verdict: "completed",
			complexity: 3,
		})
		assert.strictEqual(getRunSummary("run-ct").sota?.variantId, "v2")
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

	it("auto-fills verdict when omitted (sota / completed / failed)", () => {
		const r1 = recordExperiment("run-auto", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 12 },
			evaluation: { passed: false, score: 0.3 },
		})
		// 首个有 evaluation 的实验即为当前最优
		assert.strictEqual(r1.entry.verdict, "sota")
		const r2 = recordExperiment("run-auto", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 9 },
			evaluation: { passed: false, score: 0.2 },
		})
		assert.strictEqual(r2.entry.verdict, "completed")
		const r3 = recordExperiment("run-auto", {
			variantId: "v3",
			hypothesis: "h3 配置错误未产出",
		})
		assert.strictEqual(r3.entry.verdict, "failed")
	})

	it("auto-fills type=dev and excludes validation entries from sota/trends", () => {
		recordExperiment("run-val2", {
			variantId: "v1",
			hypothesis: "dev 实验",
			metrics: { annual_return_pct: 12 },
			evaluation: { passed: false, score: 0.5 },
		})
		recordExperiment("run-val2", {
			variantId: "v1-validation",
			hypothesis: "样本外验证",
			type: "validation",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: true, score: 1 },
		})
		const summary = getRunSummary("run-val2")
		// validation 不参与 SOTA 与趋势，只单独汇报
		assert.strictEqual(summary.sota?.variantId, "v1")
		assert.deepStrictEqual(
			summary.trends.annual_return_pct.map((t) => t.value),
			[12],
		)
		assert.strictEqual(summary.validation?.variantId, "v1-validation")
		assert.strictEqual(summary.totalExperiments, 2)
		const trace = getExperimentTrace("run-val2")
		assert.strictEqual(trace.entries[0].type, "dev")
		assert.strictEqual(trace.entries[1].type, "validation")
		// validation 条目自动 verdict 为 completed（不进入 sota 竞争）
		assert.strictEqual(trace.entries[1].verdict, "completed")
	})

	it("returns budget (used/remaining) from brief.evolving_n", () => {
		createResearchRun("run-budget", BRIEF)
		recordExperiment("run-budget", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 5 },
			evaluation: { passed: false, score: 0 },
		})
		const r2 = recordExperiment("run-budget", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 6 },
			evaluation: { passed: false, score: 0 },
		})
		assert.deepStrictEqual(r2.budget, { evolvingN: 3, used: 2, remaining: 1 })
		// validation 条目不消耗迭代预算
		const r3 = recordExperiment("run-budget", {
			variantId: "v2-validation",
			hypothesis: "样本外",
			type: "validation",
			metrics: { annual_return_pct: 6 },
			evaluation: { passed: false, score: 0 },
		})
		assert.deepStrictEqual(r3.budget, { evolvingN: 3, used: 2, remaining: 1 })
	})

	it("auto-computes complexity from variant config.py when omitted", () => {
		mkdirSync(join(TMP, "run-acx", "v1"), { recursive: true })
		writeFileSync(
			join(TMP, "run-acx", "v1", "config.py"),
			`backtest_name = "run-acx_v1"
strategy_list = [
    {
        "name": "run-acx_v1",
        "factor_list": [
            ["市值", True, None, 1.0],
        ],
        "filter_list": [
            ["波动.波动率20", 20, "pct:<=0.5", True],
        ],
        "filter_list_post": [],
        "cross_sections": [
            ["高斯秩回归", "动量.动量20", 1.0],
        ],
    }
]
`,
		)
		const { entry } = recordExperiment("run-acx", {
			variantId: "v1",
			hypothesis: "h",
			metrics: { annual_return_pct: 5 },
			evaluation: { passed: false, score: 0 },
		})
		assert.strictEqual(entry.complexity, 3)
		// 显式 complexity 优先，不覆盖
		const r2 = recordExperiment("run-acx", {
			variantId: "v1",
			hypothesis: "h2",
			complexity: 99,
			metrics: { annual_return_pct: 6 },
			evaluation: { passed: false, score: 0 },
		})
		assert.strictEqual(r2.entry.complexity, 99)
	})

	it("normalizes legacy sharpe_ratio to calmar_ratio in brief and metrics", () => {
		createResearchRun("run-cal", {
			goal: "calmar 归一化",
			thresholds: { annual_return_pct: 10, sharpe_ratio: 0.5 },
		})
		recordExperiment("run-cal", {
			variantId: "v1",
			hypothesis: "h",
			metrics: { annual_return_pct: 12, sharpe_ratio: 0.6 },
			evaluation: { passed: true, score: 1 },
		})
		const summary = getRunSummary("run-cal")
		const gap = summary.thresholdGaps?.calmar_ratio
		assert.strictEqual(gap?.threshold, 0.5)
		assert.strictEqual(gap?.value, 0.6)
		assert.strictEqual(gap?.passed, true)
		// 旧 sharpe_ratio 键不再出现在趋势键中
		assert.ok(!("sharpe_ratio" in summary.trends))
		assert.deepStrictEqual(
			summary.trends.calmar_ratio.map((t) => t.value),
			[0.6],
		)
	})

	it("accepts basedOn/nextHypothesis/hypothesisSource and echoes them back", () => {
		const { entry } = recordExperiment("run-schema", {
			variantId: "v2",
			basedOn: "v1",
			hypothesis: "收紧波动率过滤压回撤",
			hypothesisSource: "knowledge:k-2026-07-31-001",
			lesson: "W3 回撤 -22.4→-21.88，方向成立但幅度有限",
			nextHypothesis: "扩大持股数 20→30 分散特质风险",
			verdict: "completed",
		})
		assert.strictEqual(entry.basedOn, "v1")
		assert.strictEqual(entry.nextHypothesis, "扩大持股数 20→30 分散特质风险")
		assert.strictEqual(entry.hypothesisSource, "knowledge:k-2026-07-31-001")
	})

	it("rejects placeholder lesson on write but still reads legacy placeholder entries", () => {
		assert.throws(
			() =>
				recordExperiment("run-schema", {
					variantId: "v3",
					hypothesis: "x",
					lesson: "待回填",
				}),
			/占位/,
		)
		assert.throws(
			() =>
				recordExperiment("run-schema", {
					variantId: "v3",
					hypothesis: "x",
					lesson: "TBD",
				}),
			/占位/,
		)
		appendFileSync(
			join(TMP, "run-schema", "trace.jsonl"),
			`${JSON.stringify({ variantId: "v9", hypothesis: "legacy", lesson: "待回填" })}\n`,
		)
		const { entries } = getExperimentTrace("run-schema")
		assert.ok(
			entries.some((e) => e.variantId === "v9" && e.lesson === "待回填"),
		)
	})

	it("warns on near-duplicate hypothesis without blocking", () => {
		recordExperiment("run-dup", {
			variantId: "v1",
			hypothesis: "收紧低波动过滤至0.25可压降回撤",
			lesson: "无效",
		})
		const res = recordExperiment("run-dup", {
			variantId: "v2",
			hypothesis: "收紧低波动过滤至0.25以压降回撤",
			lesson: "仍无效",
		})
		assert.ok(res.warnings?.some((w) => w.includes("相似")))
		const res2 = recordExperiment("run-dup", {
			variantId: "v3",
			hypothesis: "改用反转因子叠加小市值暴露",
			lesson: "观察",
		})
		assert.ok(!res2.warnings || res2.warnings.length === 0)
	})

	it("close_run lifecycle: pause/achieve rules", () => {
		createResearchRun("run-lc", BRIEF)
		const closed = closeRun("run-lc", "abandoned", "基线差距过大，转向其他配方")
		assert.strictEqual(closed.status, "abandoned")
		assert.throws(() => closeRun("run-lc", "achieved", "达标"), /SOTA/)
		recordExperiment("run-lc", {
			variantId: "v1",
			hypothesis: "h",
			metrics: { annual_return_pct: 5 },
			evaluation: { passed: false, score: 0 },
			verdict: "completed",
			lesson: "差距大",
		})
		assert.throws(() => closeRun("run-lc", "achieved", "达标"), /SOTA/)
		recordExperiment("run-lc", {
			variantId: "v2",
			hypothesis: "h2",
			metrics: { annual_return_pct: 20 },
			evaluation: { passed: true, score: 1 },
			verdict: "sota",
			lesson: "达标",
		})
		const ok = closeRun("run-lc", "achieved", "全部阈值达标")
		assert.strictEqual(ok.status, "achieved")
		assert.ok(ok.closedAt)
		assert.strictEqual(getRunStatuses()["run-lc"].status, "achieved")
		closeRun("run-lc", "paused", "阶段性暂停")
		assert.strictEqual(getRunStatuses()["run-lc"].status, "paused")
		assert.strictEqual(getRunStatuses()["run-lc"].closeReason, "阶段性暂停")
		assert.throws(() => closeRun("run-nope", "paused", "x"), /不存在/)
	})

	it("close_run rejects runs without brief.json and does not poison the run", () => {
		recordExperiment("run-nobrief", {
			variantId: "v1",
			hypothesis: "无 brief 的 run",
			lesson: "仅 recordExperiment 创建的目录",
		})
		assert.throws(() => closeRun("run-nobrief", "paused", "x"), /brief\.json/)
		// closeRun 不得兜底写残缺 brief（会锁死 readBriefFile），run 仍可正常记录
		recordExperiment("run-nobrief", {
			variantId: "v2",
			hypothesis: "closeRun 失败后继续记录",
			lesson: "未被锁死",
		})
		assert.strictEqual(getExperimentTrace("run-nobrief").total, 2)
	})
})

describe("research-run walkforward", () => {
	const WF_BRIEF = {
		goal: "walkforward dev 闭环",
		thresholds: { annual_return_pct: 15, max_drawdown_pct: 25 },
		walkforward: {
			windows: [
				{ start_date: "2018-01-01", end_date: "2020-12-31" },
				{ start_date: "2021-01-01", end_date: "2022-12-31" },
				{ start_date: "2023-01-01", end_date: null },
			],
		},
		evolving_n: 5,
	}

	it("creates a run with walkforward brief", () => {
		const { brief } = createResearchRun("run-wf", WF_BRIEF)
		assert.strictEqual(brief.walkforward?.windows.length, 3)
	})

	it("rejects walkforward with fewer than 2 windows", () => {
		assert.throws(() =>
			createResearchRun("run-wf-1win", {
				goal: "g",
				thresholds: {},
				walkforward: {
					windows: [{ start_date: "2020-01-01", end_date: "2021-01-01" }],
				},
			}),
		)
	})

	it("rejects windows with start >= end or unparseable dates", () => {
		assert.throws(() =>
			createResearchRun("run-wf-bad-order", {
				goal: "g",
				thresholds: {},
				walkforward: {
					windows: [
						{ start_date: "2021-01-01", end_date: "2020-01-01" },
						{ start_date: "2022-01-01", end_date: null },
					],
				},
			}),
		)
		assert.throws(() =>
			createResearchRun("run-wf-bad-date", {
				goal: "g",
				thresholds: {},
				walkforward: {
					windows: [
						{ start_date: "not-a-date", end_date: "2020-01-01" },
						{ start_date: "2022-01-01", end_date: null },
					],
				},
			}),
		)
	})

	it("rejects dev entry with metrics but no windows when walkforward configured", () => {
		assert.throws(
			() =>
				recordExperiment("run-wf", {
					variantId: "v1",
					hypothesis: "绕过 walkforward 的单窗口记录",
					metrics: { annual_return_pct: 20 },
					evaluation: { passed: true, score: 1 },
				}),
			/run_dev_walkforward/,
		)
		// 拦截发生在写入之前，trace 仍为空
		assert.strictEqual(getExperimentTrace("run-wf").total, 0)
	})

	it("allows failure entry without metrics/evaluation (failed verdict)", () => {
		const { entry } = recordExperiment("run-wf", {
			variantId: "v1",
			hypothesis: "回测内核直接崩溃",
		})
		assert.strictEqual(entry.verdict, "failed")
	})

	it("records dev entry with windows detail from run_dev_walkforward", () => {
		const { entry, budget } = recordExperiment("run-wf", {
			variantId: "v1",
			hypothesis: "三窗口稳健性检验",
			metrics: { annual_return_pct: 10, max_drawdown_pct: -30 },
			evaluation: { passed: false, score: 0 },
			windows: [
				{
					window: { start_date: "2018-01-01", end_date: "2020-12-31" },
					ok: true,
					metrics: { annual_return_pct: 20, max_drawdown_pct: -15 },
					evaluation: { passed: true, score: 1 },
				},
				{
					window: { start_date: "2021-01-01", end_date: "2022-12-31" },
					ok: true,
					metrics: { annual_return_pct: 10, max_drawdown_pct: -30 },
					evaluation: { passed: false, score: 0 },
				},
				{
					window: { start_date: "2023-01-01", end_date: null },
					ok: false,
					error: "数据缺失",
				},
			],
			worstWindow: { start_date: "2023-01-01", end_date: null },
		})
		assert.strictEqual(entry.windows?.length, 3)
		assert.strictEqual(entry.worstWindow?.start_date, "2023-01-01")
		// walkforward 实验消耗 1 轮预算（含前面的 failed 条目，共 2 条 dev）
		assert.strictEqual(budget?.used, 2)
		assert.strictEqual(budget?.remaining, 3)
	})

	it("validation entry is not subject to walkforward interception", () => {
		const { entry } = recordExperiment("run-wf", {
			variantId: "v1",
			hypothesis: "validation 窗口样本外验证",
			type: "validation",
			metrics: { annual_return_pct: 12 },
			evaluation: { passed: false, score: 0.5 },
		})
		assert.strictEqual(entry.type, "validation")
		assert.strictEqual(entry.windows, undefined)
	})
})
