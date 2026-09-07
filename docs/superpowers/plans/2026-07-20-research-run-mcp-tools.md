# Research-Run MCP 工具（M1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **提交约定：** 按项目安全规则，执行者**不运行任何 git 提交命令**。所有改动保持未提交状态，完成后汇报 diff 摘要，由用户确认后再统一提交。

**Goal:** 在 quantclass MCP Server 中新增 4 个工作流级工具（`create_research_run` / `record_experiment` / `get_experiment_trace` / `get_run_summary`），把 RDAgent 风格的研究任务书（brief.json）与实验 trace（trace.jsonl）固化到策略工作区，支撑「假设 → 实现 → 回测 → 评估 → 进化」循环。

**Architecture:** 新增纯函数模块 `src/mcp-server/research-run.ts`（zod 校验 + 文件 I/O，复用 `strategy-files.ts` 的路径安全原语），在 `tools.ts` 末尾注册 4 个 tool（tools 总数 28 → 32）。测试分两层：`tests/mcp-server/research-run.test.ts` 纯函数单测（node:test，env + 动态 import 模式），`tests/mcp-server/tools.test.ts` 集成测试（stdio MCP client，需先 `pnpm build:mcp`）。

**Tech Stack:** TypeScript（ESM，Node16 模块解析，src 内 import 带 `.js` 扩展名）、zod、node:test（`--experimental-strip-types`）、Biome（tab 缩进、行宽 80、分号 asNeeded、双引号）。

**关键背景（执行者必读）：**

- 工作区根目录：`getWorkspaceRoot()`（`src/mcp-server/strategy-files.ts`），env `QUANTCLASS_AGENT_WORKSPACE` 可覆盖，默认 `<appRoot>/workspace/agent-strategies`。该常量在模块加载时求值，所以测试必须在 import 被测模块**之前**设置 env（参考 `tests/mcp-server/strategy-files.test.ts` 的写法）。
- 路径安全：`assertSafePathComponent(name, label)` 拒绝空值与含 `..` `/` `\` 的名字；`assertInsideWorkspace(path)` 拒绝工作区外路径。两者直接从 `./strategy-files.js` 导入复用。
- 新文件必须带项目 BUSL-1.1 版权头（见下方代码）。
- `tools.ts` 中 tool 注册模式：`server.tool(name, description, zodRawShape, async handler)`，handler 内 try/catch，成功返回 `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`，失败返回 `{ content: [...], isError: true }`。
- 集成测试（`tools.test.ts`）与校验脚本（`scripts/verify-mcp-tool-registration.mjs`）都通过 stdio 连接 `resources/mcp-server/index.js`——改动 `tools.ts` 后必须重新 `pnpm build:mcp` 才会生效。
- spec：`docs/superpowers/specs/2026-07-20-quantclass-rdagent-workflow-design.md`。

---

### Task 1: research-run.ts — schema + create/record/trace

**Files:**
- Create: `src/mcp-server/research-run.ts`
- Test: `tests/mcp-server/research-run.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/mcp-server/research-run.test.ts`，完整内容：

```ts
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
})
```

（`getRunSummary` 的测试在 Task 2 追加；本任务 import 它是为了让 Task 2 只需加测试、不用动 import。Task 1 的实现代码需要先把 `getRunSummary` 的签名留出——见 Step 3。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:mcp`
Expected: FAIL，`Cannot find module '../../src/mcp-server/research-run.ts'`（模块尚不存在）。

- [ ] **Step 3: 实现 research-run.ts**

创建 `src/mcp-server/research-run.ts`，完整内容（注意：tab 缩进、无分号、双引号）：

```ts
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
} from "./strategy-files.js"

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
	const sliced =
		tail !== undefined && tail > 0 ? entries.slice(-tail) : entries
	return { runId, total: entries.length, entries: sliced }
}

// getRunSummary 在 Task 2 中实现并补全，此处先给出类型与占位实现，
// 保证 Task 1 的测试文件可以 import。
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
	throw new Error(`getRunSummary 尚未实现: ${runId}`)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:mcp`
Expected: PASS。注意 `research-run.test.ts` 中除最后一个用例（malformed trace）外都应通过；malformed 用例之后没有依赖 trace 的用例（summary 用例在 Task 2 才追加），所以本任务结束时整个文件应全绿。若 `tools.test.ts` 集成测试因 bundle 未更新而失败，先跑一次 `pnpm build:mcp` 再重跑（本任务未改 tools.ts，bundle 应与现状一致，正常应通过）。

- [ ] **Step 5: 格式化**

Run: `npx biome check --write src/mcp-server/research-run.ts tests/mcp-server/research-run.test.ts`
Expected: 无错误（可能有少量重排/换行修正）。格式化后重跑 `pnpm test:mcp` 确认仍全绿。

---

### Task 2: research-run.ts — getRunSummary

**Files:**
- Modify: `src/mcp-server/research-run.ts`（替换 Task 1 的占位 `getRunSummary`，并在内部工具区新增 `readBriefFile`、`metricPassed`、`metricGap`）
- Test: `tests/mcp-server/research-run.test.ts`（describe 内追加用例）

- [ ] **Step 1: 追加失败测试**

在 `tests/mcp-server/research-run.test.ts` 的 `throws on malformed trace line` 用例**之后**、`describe` 结束前追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:mcp`
Expected: FAIL，`getRunSummary 尚未实现`。

- [ ] **Step 3: 实现 getRunSummary**

在 `src/mcp-server/research-run.ts` 的「内部工具」区（`readTraceEntries` 之后）追加：

```ts
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
```

然后把占位的 `getRunSummary` 函数整体替换为（保留 Task 1 已定义的 `ThresholdGap` / `RunSummary` 接口不动）：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:mcp`
Expected: PASS，`research-run.test.ts` 全部用例绿。

- [ ] **Step 5: 格式化**

Run: `npx biome check --write src/mcp-server/research-run.ts tests/mcp-server/research-run.test.ts`
Expected: 无错误；重跑 `pnpm test:mcp` 仍全绿。

---

### Task 3: tools.test.ts 集成测试（先失败）

**Files:**
- Modify: `tests/mcp-server/tools.test.ts`

- [ ] **Step 1: 追加集成测试**

在 `tests/mcp-server/tools.test.ts` 的 `submits strategy for review via MCP` 用例**之后**、`describe` 结束前追加：

```ts
	it("exposes research workflow tools", async () => {
		const tools = await client.listTools()
		const names = tools.tools.map((t) => t.name)
		assert.ok(names.includes("create_research_run"))
		assert.ok(names.includes("record_experiment"))
		assert.ok(names.includes("get_experiment_trace"))
		assert.ok(names.includes("get_run_summary"))
	})

	it("runs research workflow via MCP", async () => {
		const createRes = await client.callTool({
			name: "create_research_run",
			arguments: {
				runId: "run-rd",
				brief: {
					goal: "测试研究目标",
					thresholds: { annual_return_pct: 15, max_drawdown_pct: 25 },
					evolving_n: 3,
				},
			},
		})
		const createText =
			createRes.content.find((c) => c.type === "text")?.text ?? ""
		assert.ok(JSON.parse(createText).briefPath.endsWith("brief.json"))

		await client.callTool({
			name: "record_experiment",
			arguments: {
				runId: "run-rd",
				entry: {
					variantId: "v1",
					hypothesis: "动量+低换手提升年化",
					metrics: { annual_return_pct: 12, max_drawdown_pct: -28 },
					evaluation: { passed: false, score: 0 },
					verdict: "completed",
					lesson: "拉长动量窗口",
				},
			},
		})

		const traceRes = await client.callTool({
			name: "get_experiment_trace",
			arguments: { runId: "run-rd" },
		})
		const trace = JSON.parse(
			traceRes.content.find((c) => c.type === "text")?.text ?? "{}",
		)
		assert.strictEqual(trace.total, 1)
		assert.strictEqual(trace.entries[0].variantId, "v1")
		assert.ok(trace.entries[0].ts)

		const summaryRes = await client.callTool({
			name: "get_run_summary",
			arguments: { runId: "run-rd" },
		})
		const summary = JSON.parse(
			summaryRes.content.find((c) => c.type === "text")?.text ?? "{}",
		)
		assert.strictEqual(summary.totalExperiments, 1)
		assert.strictEqual(summary.sota.variantId, "v1")
		assert.strictEqual(summary.thresholdGaps.annual_return_pct.passed, false)
	})
```

- [ ] **Step 2: 重建 bundle 并运行，确认新测试失败**

Run: `pnpm build:mcp && pnpm test:mcp`
Expected: 两个新用例 FAIL（tool 尚未注册，`create_research_run` 找不到）；其余用例 PASS。

---

### Task 4: tools.ts 注册 4 个工具

**Files:**
- Modify: `src/mcp-server/tools.ts`

- [ ] **Step 1: 添加 import**

在 `src/mcp-server/tools.ts` 顶部 import 区（`import { submitForReview } from "./review-submitter.js"` 之后）追加：

```ts
import {
	createResearchRun,
	experimentEntrySchema,
	getExperimentTrace,
	getRunSummary,
	recordExperiment,
	researchBriefSchema,
} from "./research-run.js"
```

- [ ] **Step 2: 注册 4 个 tool**

在 `src/mcp-server/tools.ts` 末尾的 `console.log("[mcp-server] MCP tools registered successfully")` **之前**追加：

```ts
	// ============================================================
	// 研究工作流：run / trace / 总结（RDAgent 风格进化循环）
	// ============================================================

	server.tool(
		"create_research_run",
		"创建研究 run：在工作区写入 brief.json（研究目标、达标阈值、回测区间、进化轮数）。runId 已存在则报错，不会覆盖。",
		{
			runId: z.string().describe("Run ID，例如 run-momentum-001"),
			brief: researchBriefSchema.describe("研究任务书"),
		},
		async ({ runId, brief }) => {
			try {
				const result = createResearchRun(runId, brief)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `创建研究 run 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"record_experiment",
		"记录一次实验到 run 的 trace.jsonl（假设、变更、绩效、评估、结论、教训）。ts 缺省时自动填当前时间。",
		{
			runId: z.string().describe("Run ID"),
			entry: experimentEntrySchema.describe("实验记录"),
		},
		async ({ runId, entry }) => {
			try {
				const result = recordExperiment(runId, entry)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `记录实验失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_experiment_trace",
		"读取 run 的实验 trace（trace.jsonl）。tail=N 时只返回最近 N 条以控制上下文体积。",
		{
			runId: z.string().describe("Run ID"),
			tail: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("只返回最近 N 条记录"),
		},
		async ({ runId, tail }) => {
			try {
				const result = getExperimentTrace(runId, tail)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `读取实验 trace 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_run_summary",
		"汇总 run 的实验情况：实验总数、各 verdict 计数、当前 SOTA、距阈值差距、各指标趋势。",
		{
			runId: z.string().describe("Run ID"),
		},
		async ({ runId }) => {
			try {
				const result = getRunSummary(runId)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `汇总 run 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)
```

- [ ] **Step 3: 重建并运行集成测试**

Run: `pnpm build:mcp && pnpm test:mcp`
Expected: PASS，全部用例绿（含 Task 3 新增的两个）。

- [ ] **Step 4: 格式化**

Run: `npx biome check --write src/mcp-server/tools.ts tests/mcp-server/tools.test.ts`
Expected: 无错误；重跑 `pnpm test:mcp` 仍全绿。

---

### Task 5: 校验脚本、AGENTS.md、全量验证

**Files:**
- Modify: `scripts/verify-mcp-tool-registration.mjs`
- Modify: `AGENTS.md`（第 5.2 节 tools 清单、第 7 节测试清单）

- [ ] **Step 1: 更新校验脚本**

在 `scripts/verify-mcp-tool-registration.mjs` 的 `REQUIRED_TOOLS` 数组末尾追加 4 个名字：

```js
const REQUIRED_TOOLS = [
	"list_strategies",
	"read_strategy_file",
	"write_strategy_file",
	"validate_strategy",
	"evaluate_backtest",
	"submit_strategy_for_review",
	"create_research_run",
	"record_experiment",
	"get_experiment_trace",
	"get_run_summary",
]
```

并在 `submit_strategy_for_review` 的 `callTool` 之后、`console.log("All required tools callable.")` 之前追加：

```js
	await client.callTool({
		name: "create_research_run",
		arguments: {
			runId: "run-verify",
			brief: { goal: "verify", thresholds: { annual_return_pct: 10 } },
		},
	})
	await client.callTool({
		name: "record_experiment",
		arguments: {
			runId: "run-verify",
			entry: { variantId: "v1", hypothesis: "h", verdict: "completed" },
		},
	})
	await client.callTool({
		name: "get_experiment_trace",
		arguments: { runId: "run-verify" },
	})
	await client.callTool({
		name: "get_run_summary",
		arguments: { runId: "run-verify" },
	})
```

- [ ] **Step 2: 更新 AGENTS.md**

`AGENTS.md` 两处修改：

1. 第 5.2 节标题行「当前 MCP Server 共注册 **28 个 tools**」改为「**32 个 tools**」，并在「策略开发闭环（10 个）」分组的列表之后追加新分组：

```markdown
- **研究工作流（4 个）**：
  - `create_research_run`：创建研究 run（brief.json：目标、阈值、回测区间、进化轮数）
  - `record_experiment`：追加实验记录到 trace.jsonl
  - `get_experiment_trace`：读取实验 trace（支持 tail 截断）
  - `get_run_summary`：汇总实验数、SOTA、阈值差距与指标趋势
```

2. 第 7 节「当前测试覆盖（`tests/mcp-server/`）」列表中追加：

```markdown
- `research-run.test.ts`
```

- [ ] **Step 3: 全量验证**

依次运行：

```bash
pnpm test:mcp
pnpm typecheck
npx tsc -p tsconfig.mcp.json
pnpm verify:mcp-tools
npx biome check src/mcp-server tests/mcp-server scripts/verify-mcp-tool-registration.mjs
```

Expected:
- `pnpm test:mcp`：全部 PASS（研究 run 用例 + 原有用例）。
- `pnpm typecheck`：无错误（mcp-server 不在 node/web tsconfig 内，但必须不破坏现有检查）。
- `npx tsc -p tsconfig.mcp.json`：无错误（mcp-server 专属 typecheck，`noEmit` 已在配置中）。
- `pnpm verify:mcp-tools`：输出 `Registered tools count: 32`，`Required tools present: true`，`All required tools callable.`，退出码 0。
- `npx biome check ...`：无错误（注意此命令不带 `--write`，只验证）。

- [ ] **Step 4: 汇报 diff 摘要（不提交）**

Run: `git status --short && git diff --stat`
Expected: 列出本次新增/修改的文件：
- 新增 `src/mcp-server/research-run.ts`
- 新增 `tests/mcp-server/research-run.test.ts`
- 修改 `src/mcp-server/tools.ts`、`tests/mcp-server/tools.test.ts`、`scripts/verify-mcp-tool-registration.mjs`、`AGENTS.md`
- `resources/mcp-server/index.js`（build 产物，是否入库遵循仓库现状）

**不要运行 `git add` / `git commit`**。把 diff 摘要汇报给用户，等确认后再提交。
