import assert from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it, mock } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-dwfjob-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

// mock client 层：绝不触达真实客户端（127.0.0.1:8787）
const calls = {
	get: [] as string[],
	post: [] as string[],
	put: [] as unknown[],
}
const PRIOR_CONFIG = {
	initialCash: 1000000,
	startDate: "2019-01-01",
	endDate: null,
	backtestName: "run-dwf-ok_v1",
	filterKcb: false,
	filterCyb: "0",
	filterBj: true,
}
mock.module("../../src/mcp-server/client.ts", {
	namedExports: {
		get: async (path: string) => {
			calls.get.push(path)
			if (path === "/mcp/backtest/config") {
				return { code: 0, data: { ...PRIOR_CONFIG } }
			}
			if (path.startsWith("/mcp/backtest/task")) {
				return {
					code: 0,
					data: { status: "success", kernelVersion: "zeus_test_1.0" },
				}
			}
			if (path === "/mcp/backtest/performance") {
				return {
					code: 0,
					data: {
						parsed: {
							annual_return_pct: 12,
							max_drawdown_pct: -10,
							calmar_ratio: 1.2,
						},
					},
				}
			}
			throw new Error(`unexpected GET ${path}`)
		},
		post: async (path: string) => {
			calls.post.push(path)
			if (path === "/mcp/backtest/run-async") {
				return { code: 0, data: { taskId: "zeus_t1", kernel: "zeus" } }
			}
			throw new Error(`unexpected POST ${path}`)
		},
		put: async (path: string, body: unknown) => {
			calls.put.push(body)
			return { code: 0, data: { updated: body } }
		},
	},
})

const { createResearchRun, recordExperiment, getExperimentTrace } =
	await import("../../src/mcp-server/research-run.ts")
const { startDevWalkforwardJob, readDevWalkforwardJob } = await import(
	"../../src/mcp-server/dev-walkforward-job.ts"
)

const WF_WINDOWS = [
	{ start_date: "2021-01-01", end_date: "2022-12-31" },
	{ start_date: "2023-01-01", end_date: null },
]

function resetCalls() {
	calls.get.length = 0
	calls.post.length = 0
	calls.put.length = 0
}

async function waitJobFinished(runId: string, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const job = readDevWalkforwardJob(runId)
		if (job.status !== "running") return job
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error(`job 未在限时内完成: ${runId}`)
}

describe("dev-walkforward-job", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("预算预检：evolving_n 用尽时立即报错且不起 job、不发任何 HTTP", async () => {
		resetCalls()
		createResearchRun("run-dwf-cap", {
			goal: "预算预检",
			thresholds: {},
			walkforward: { windows: WF_WINDOWS },
			evolving_n: 1,
		})
		recordExperiment("run-dwf-cap", { variantId: "v1", hypothesis: "h1" })
		await assert.rejects(
			startDevWalkforwardJob({
				runId: "run-dwf-cap",
				variantId: "v2",
				hypothesis: "h2",
			}),
			/迭代预算已用完（evolving_n=1）/,
		)
		assert.deepStrictEqual(calls.get, [])
		assert.deepStrictEqual(calls.post, [])
		assert.deepStrictEqual(calls.put, [])
		assert.throws(() => readDevWalkforwardJob("run-dwf-cap"), /无此 run/)
	})

	it("并发重入：已有 running job 时报错且不发 HTTP", async () => {
		resetCalls()
		createResearchRun("run-dwf-lock", {
			goal: "并发保护",
			thresholds: {},
			walkforward: { windows: WF_WINDOWS },
		})
		writeFileSync(
			join(TMP, "run-dwf-lock", "dev-walkforward-job.json"),
			JSON.stringify({
				jobId: "dwf-stale",
				runId: "run-dwf-lock",
				variantId: "v1",
				status: "running",
				currentWindowIndex: 0,
				totalWindows: 2,
				windows: [],
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		)
		await assert.rejects(
			startDevWalkforwardJob({
				runId: "run-dwf-lock",
				variantId: "v2",
				hypothesis: "h2",
			}),
			/进行中/,
		)
		assert.deepStrictEqual(calls.get, [])
		assert.deepStrictEqual(calls.put, [])
	})

	it("happy path：立即返回 jobId，后台逐窗口执行、写 trace、恢复配置", async () => {
		resetCalls()
		createResearchRun("run-dwf-ok", {
			goal: "happy path",
			thresholds: { annual_return_pct: 10 },
			walkforward: { windows: WF_WINDOWS },
		})
		const res = await startDevWalkforwardJob({
			runId: "run-dwf-ok",
			variantId: "v1",
			hypothesis: "两窗口稳健",
			lesson: "最劣窗口年化 12 达标",
		})
		assert.strictEqual(res.status, "running")
		assert.strictEqual(res.totalWindows, 2)
		assert.ok(res.jobId)
		assert.match(res.hint, /get_dev_walkforward_job/)
		// 启动时已快照配置（一次 GET），随后立即返回
		assert.deepStrictEqual(calls.get, ["/mcp/backtest/config"])

		const job = await waitJobFinished("run-dwf-ok")
		assert.strictEqual(job.status, "success")
		assert.ok(job.finishedAt)
		assert.strictEqual(job.windows.length, 2)
		assert.ok(job.windows.every((w) => w.status === "success"))
		assert.ok(job.traceEntry)
		assert.strictEqual(job.budget, null)

		// trace 落盘口径与旧同步实现一致：type=dev + 分窗口明细 + 最劣窗口
		const trace = getExperimentTrace("run-dwf-ok")
		assert.strictEqual(trace.total, 1)
		const entry = trace.entries[0]
		assert.strictEqual(entry.type, "dev")
		assert.strictEqual(entry.windows?.length, 2)
		assert.ok(entry.worstWindow)
		assert.strictEqual(entry.metrics?.annual_return_pct, 12)
		assert.strictEqual(entry.kernelVersion, "zeus_test_1.0")

		// PUT 序列：窗口1 切窗 → 窗口2 切窗 → 恢复原配置（filter 归一为 boolean）
		assert.strictEqual(calls.put.length, 3)
		assert.deepStrictEqual(calls.put[0], WF_WINDOWS[0])
		assert.deepStrictEqual(calls.put[1], WF_WINDOWS[1])
		assert.deepStrictEqual(calls.put[2], {
			initial_cash: 1000000,
			start_date: "2019-01-01",
			end_date: null,
			filter_kcb: false,
			filter_cyb: false,
			filter_bj: true,
		})
	})

	it("get_dev_walkforward_job：无 job 文件报错，有文件返回内容", async () => {
		assert.throws(() => readDevWalkforwardJob("run-dwf-none"), /无此 run/)
		const job = readDevWalkforwardJob("run-dwf-ok")
		assert.strictEqual(job.runId, "run-dwf-ok")
		assert.strictEqual(job.status, "success")
	})
})
