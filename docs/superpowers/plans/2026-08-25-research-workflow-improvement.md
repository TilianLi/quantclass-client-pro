# 研究工作流改进（知识积累 + 假设生成质量）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依据 `docs/superpowers/specs/2026-08-25-research-workflow-improvement-design.md`，为研究闭环补齐 trace 分叉/假设种子/lesson 校验、跨 run 知识库、run 生命周期与组件清单四类能力。

**Architecture:** 全部改动在 `src/mcp-server/`（纯函数 + tools.ts 注册）与 `tests/mcp-server/`（node --test）。知识库存储为 workspace 根目录的 `knowledge.jsonl`；run 状态写入各 run 的 `brief.json`（zod strip 不影响原文，读写分离）。lesson 占位校验只拦写入路径，不影响历史 trace 读取。

**Tech Stack:** TypeScript (ESM, `.ts` 后缀导入)、zod、node:test、`pnpm test:mcp` / `pnpm build:mcp` / `pnpm typecheck` / `pnpm verify:mcp-tools`。

**关键既有事实（实现前必读）：**
- `src/mcp-server/research-run.ts`：`experimentEntrySchema`（:121）被**读写共用**——新字段必须 optional，占位校验绝不能进 schema（历史 trace 含「待回填」，进 schema 会导致 `readTraceEntries` 全部解析失败）。
- `localTimestamp()`（research-run.ts:223）是私有函数，knowledge-base 需要复用 → 改为 export。
- real_trading 根目录解析惯例（strategy-validator.ts:307-309）：`join(process.env.ALL_DATA_PATH || "D:/QuantClassSpace/QuantData", "real_trading")`。
- tools.ts 注册样式：`server.tool(name, description, zodRawShape, async handler)`，handler 内 try/catch 返回 `{content:[{type:"text",text}], isError?}`。
- 集成测试 `tests/mcp-server/tools.test.ts` spawn `resources/mcp-server/index.js`（esbuild bundle）——**改 tools.ts 后必须先 `pnpm build:mcp` 再跑集成测试**。
- git commit 步骤：执行时不自动提交，全部验证通过后由用户确认统一提交。

---

### Task 1: trace schema 升级（basedOn/nextHypothesis/hypothesisSource + lesson 占位校验 + 假设查重警告）

**Files:**
- Modify: `src/mcp-server/research-run.ts`
- Test: `tests/mcp-server/research-run.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/mcp-server/research-run.test.ts` 末尾的 `describe("research-run", ...)` 块内追加：

```ts
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
		// 写入路径：占位 lesson 拒绝
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
		// 读取路径：手写一条含「待回填」的历史条目，必须能正常读回
		const { join } = require("node:path") // 文件顶部已有 join 则用顶部的
		const { appendFileSync } = require("node:fs")
		appendFileSync(
			join(TMP, "run-schema", "trace.jsonl"),
			`${JSON.stringify({ variantId: "v9", hypothesis: "legacy", lesson: "待回填" })}\n`,
		)
		const { entries } = getExperimentTrace("run-schema")
		assert.ok(entries.some((e) => e.variantId === "v9" && e.lesson === "待回填"))
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
		// 不相似的假设无警告
		const res2 = recordExperiment("run-dup", {
			variantId: "v3",
			hypothesis: "改用反转因子叠加小市值暴露",
			lesson: "观察",
		})
		assert.ok(!res2.warnings || res2.warnings.length === 0)
	})
```

注：测试文件顶部已 import 了 `join`（node:path）与 `readFileSync/writeFileSync`（node:fs），若 `appendFileSync` 未导入则补入顶部 import，不要用 require。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:mcp -- tests/mcp-server/research-run.test.ts`（若脚本不支持路径参数则 `node --test --experimental-strip-types tests/mcp-server/research-run.test.ts`）
Expected: FAIL（`basedOn` 等字段被 zod strip 掉 / warnings 不存在）

- [ ] **Step 3: 实现**

`src/mcp-server/research-run.ts`：

a) `experimentEntrySchema`（:121）的 `hypothesis` 字段后追加：

```ts
	/** 分叉父 variantId（缺省视为上一 variant，保持线性语义） */
	basedOn: z.string().optional(),
	/** 假设来源引用，推荐 knowledge:<id> / trace:<runId>/<variantId> / none */
	hypothesisSource: z.string().optional(),
	/** 预埋给下一轮的假设种子（对应 RD-Agent feedback 阶段的 new_hypothesis） */
	nextHypothesis: z.string().optional(),
```

b) `RecordExperimentResult` 接口（:386）追加：

```ts
	/** 非阻断警告（如假设与历史条目近似重复） */
	warnings?: string[]
```

c) 在 `recordExperiment` 中，`const parsed = parseWith(...)` 之后追加占位校验与查重：

```ts
	assertLessonNotPlaceholder(parsed.lesson)

	const warnings: string[] = []
	const priorEntries = readTraceEntries(runId)
	for (const e of priorEntries) {
		if (hypothesisSimilarity(parsed.hypothesis, e.hypothesis) > 0.8) {
			warnings.push(
				`假设与 ${e.variantId} 高度相似（相似度>0.8）："${e.hypothesis.slice(0, 50)}..."——请确认不是重复实验`,
			)
		}
	}
```

d) 文件底部（或内部工具区）新增：

```ts
const LESSON_PLACEHOLDER =
	/^(待回填|待定|暂无|无|tbd|todo|n\/a|none)[。.\s]*$/i

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
```

e) `recordExperiment` 末尾 return 改为 `return { runId, tracePath: path, entry: full, budget, warnings }`；同时把 `autoVerdict(full, readTraceEntries(runId))` 那行的 `readTraceEntries(runId)` 换成复用上面的 `priorEntries`（避免二次读文件）。

f) `localTimestamp`（:223）改为 `export function localTimestamp`（Task 3 复用）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --experimental-strip-types tests/mcp-server/research-run.test.ts`
Expected: PASS（含既有全部用例）

---

### Task 2: run 生命周期（closeRun + 状态读取）

**Files:**
- Modify: `src/mcp-server/research-run.ts`
- Test: `tests/mcp-server/research-run.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
	it("close_run lifecycle: pause/achieve rules", () => {
		// run-lc 无任何实验：abandoned 允许，achieved 拒绝（无 SOTA）
		createResearchRun("run-lc", BRIEF)
		const closed = closeRun("run-lc", "abandoned", "基线差距过大，转向其他配方")
		assert.strictEqual(closed.status, "abandoned")
		assert.throws(
			() => closeRun("run-lc", "achieved", "达标"),
			/SOTA/,
		)
		// 有 completed 但无 sota 也不允许 achieved
		recordExperiment("run-lc", {
			variantId: "v1",
			hypothesis: "h",
			metrics: { annual_return_pct: 5 },
			evaluation: { passed: false, score: 0 },
			verdict: "completed",
			lesson: "差距大",
		})
		assert.throws(() => closeRun("run-lc", "achieved", "达标"), /SOTA/)
		// 写入 sota 后可以 achieved
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
		// 状态可读；重复 close 允许更新
		assert.strictEqual(getRunStatuses()["run-lc"].status, "achieved")
		closeRun("run-lc", "paused", "阶段性暂停")
		assert.strictEqual(getRunStatuses()["run-lc"].status, "paused")
		assert.strictEqual(getRunStatuses()["run-lc"].closeReason, "阶段性暂停")
		// 不存在的 run 报错
		assert.throws(() => closeRun("run-nope", "paused", "x"), /不存在/)
	})
```

import 处补 `closeRun, getRunStatuses`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types tests/mcp-server/research-run.test.ts`
Expected: FAIL（closeRun/getRunStatuses 未定义）

- [ ] **Step 3: 实现**

`src/mcp-server/research-run.ts` 追加：

```ts
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
	if (status === "achieved" && !getRunSummary(runId).sota) {
		throw new Error(`run ${runId} 无 SOTA 记录，不能以 achieved 关闭`)
	}
	const path = briefPath(runId)
	const raw = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>)
		: { runId, createdAt: new Date().toISOString() }
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
			if (typeof raw.status === "string" && raw.status !== "active") {
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
```

import 处补 `readdirSync`（node:fs 现有 import 行追加）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --experimental-strip-types tests/mcp-server/research-run.test.ts`
Expected: PASS

---

### Task 3: 跨 run 知识库（knowledge-base.ts）

**Files:**
- Create: `src/mcp-server/knowledge-base.ts`
- Test: `tests/mcp-server/knowledge-base.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/mcp-server/knowledge-base.test.ts`：

```ts
import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-knowledge-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const { recordKnowledge, getKnowledge } = await import(
	"../../src/mcp-server/knowledge-base.ts"
)

describe("knowledge-base", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("records knowledge with auto id and ts", () => {
		const r = recordKnowledge({
			knob: "波动.波动率20 过滤阈值",
			change: "pct:<=0.25 → 0.20",
			effect: "最劣窗口回撤 -0.1pp，年化 +0.19pp",
			evidence: [{ runId: "run-calmar-001", from: "v3", to: "v5" }],
			regime: "2024-01 流动性危机段",
			tags: ["波动率", "回撤控制"],
		})
		assert.match(r.id, /^k-\d{8}-\d{3}$/)
		assert.ok(r.entry.ts)
		assert.strictEqual(r.entry.knob, "波动.波动率20 过滤阈值")
	})

	it("rejects invalid entries", () => {
		assert.throws(() => recordKnowledge({ knob: "", change: "x", effect: "y", evidence: [{ runId: "r" }] }))
		assert.throws(() => recordKnowledge({ knob: "k", change: "x", effect: "y", evidence: [] }))
	})

	it("lists all and filters by knob substring", () => {
		recordKnowledge({
			knob: "select_num 持股数",
			change: "20 → 30",
			effect: "年化 -0.9pp，回撤 +0.8pp（恶化）",
			evidence: [{ runId: "run-calmar-001", from: "v3", to: "v4" }],
		})
		const all = getKnowledge()
		assert.strictEqual(all.total, 2)
		const filtered = getKnowledge("波动率20")
		assert.strictEqual(filtered.total, 1)
		assert.strictEqual(filtered.entries[0].knob, "波动.波动率20 过滤阈值")
		const none = getKnowledge("不存在的旋钮")
		assert.strictEqual(none.total, 0)
	})

	it("generates sequential ids for the same day", () => {
		const a = recordKnowledge({ knob: "a", change: "c", effect: "e", evidence: [{ runId: "r" }] })
		const b = recordKnowledge({ knob: "b", change: "c", effect: "e", evidence: [{ runId: "r" }] })
		assert.notStrictEqual(a.id, b.id)
		assert.ok(a.id.slice(0, 9) === b.id.slice(0, 9))
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types tests/mcp-server/knowledge-base.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `src/mcp-server/knowledge-base.ts`（版权头复制 research-run.ts 头部）：

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

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { localTimestamp } from "./research-run.ts"
import { assertInsideWorkspace, getWorkspaceRoot } from "./strategy-files.ts"

/**
 * 跨 run 知识库（workspace 根目录 knowledge.jsonl）。
 * 旋钮级实验发现的结构化沉淀：条目只增不改，修正通过新条目表达。
 * 对应 RD-Agent CoSTEER 知识图谱的简化形态（量级几十条，不做向量检索）。
 */
const knowledgeEntrySchema = z.object({
	id: z.string().optional(),
	ts: z.string().optional(),
	/** 旋钮/组件标识（如 "波动.波动率20 过滤阈值"） */
	knob: z.string().min(1),
	/** 做了什么变更（如 "pct:<=0.25 → 0.20"） */
	change: z.string().min(1),
	/** 效果（含方向与幅度，负面效果同样记录） */
	effect: z.string().min(1),
	/** 证据链 */
	evidence: z
		.array(
			z.object({
				runId: z.string().min(1),
				from: z.string().optional(),
				to: z.string().optional(),
			}),
		)
		.min(1),
	/** 生效/失效的市场环境（可选） */
	regime: z.string().optional(),
	tags: z.array(z.string()).optional(),
})

export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema> & {
	id: string
	ts: string
}

function knowledgePath(): string {
	return assertInsideWorkspace(join(getWorkspaceRoot(), "knowledge.jsonl"))
}

function readKnowledgeEntries(): KnowledgeEntry[] {
	const path = knowledgePath()
	if (!existsSync(path)) return []
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line, index) => {
			let parsed: unknown
			try {
				parsed = JSON.parse(line)
			} catch {
				throw new Error(`knowledge.jsonl 第 ${index + 1} 行不是合法 JSON`)
			}
			return parsed as KnowledgeEntry
		})
}

/** 生成当日顺序 id：k-YYYYMMDD-NNN */
function nextKnowledgeId(existing: KnowledgeEntry[], now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0")
	const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
	const prefix = `k-${datePart}-`
	const seq =
		existing.filter((e) => e.id.startsWith(prefix)).length + 1
	return `${prefix}${String(seq).padStart(3, "0")}`
}

export function recordKnowledge(entry: unknown): {
	id: string
	path: string
	entry: KnowledgeEntry
} {
	const result = knowledgeEntrySchema.safeParse(entry)
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ")
		throw new Error(`knowledge 条目校验失败: ${issues}`)
	}
	const existing = readKnowledgeEntries()
	const full: KnowledgeEntry = {
		...result.data,
		id: nextKnowledgeId(existing),
		ts: localTimestamp(),
	}
	const path = knowledgePath()
	appendFileSync(path, `${JSON.stringify(full)}\n`, "utf-8")
	return { id: full.id, path, entry: full }
}

export function getKnowledge(knobFilter?: string): {
	total: number
	entries: KnowledgeEntry[]
} {
	const all = readKnowledgeEntries()
	const entries = knobFilter
		? all.filter((e) => e.knob.includes(knobFilter))
		: all
	return { total: entries.length, entries }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --experimental-strip-types tests/mcp-server/knowledge-base.test.ts`
Expected: PASS

---

### Task 4: 组件清单（component-catalog.ts / list_factor_components）

**Files:**
- Create: `src/mcp-server/component-catalog.ts`
- Test: `tests/mcp-server/component-catalog.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/mcp-server/component-catalog.test.ts`：

```ts
import assert from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-catalog-"))
process.env.ALL_DATA_PATH = TMP

const { listFactorComponents } = await import(
	"../../src/mcp-server/component-catalog.ts"
)

describe("component-catalog", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("returns empty catalogs when real_trading does not exist", () => {
		const r = listFactorComponents()
		assert.deepStrictEqual(r.factor, {})
		assert.deepStrictEqual(r.crossFactor, {})
	})

	it("enumerates factor libraries by category, skipping __init__ and pycache", () => {
		const rt = join(TMP, "real_trading")
		mkdirSync(join(rt, "因子库", "动量"), { recursive: true })
		mkdirSync(join(rt, "因子库", "波动"), { recursive: true })
		mkdirSync(join(rt, "因子库", "__pycache__"), { recursive: true })
		writeFileSync(join(rt, "因子库", "动量", "动量20.py"), "x")
		writeFileSync(join(rt, "因子库", "动量", "__init__.py"), "")
		writeFileSync(join(rt, "因子库", "波动", "波动率20.py"), "x")
		mkdirSync(join(rt, "截面因子库"), { recursive: true })
		writeFileSync(join(rt, "截面因子库", "行业中性化.py"), "x")

		const r = listFactorComponents()
		assert.deepStrictEqual(r.factor, {
			动量: ["动量20"],
			波动: ["波动率20"],
		})
		assert.deepStrictEqual(r.crossFactor, { "(根目录)": ["行业中性化"] })
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types tests/mcp-server/component-catalog.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `src/mcp-server/component-catalog.ts`（版权头同上）：

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

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * 枚举 real_trading 下的因子库组件（类目 → 因子名列表）。
 * 供 Researcher 提假设前确认可用组件，避免假设落到不存在的因子上。
 * 只读操作；路径解析惯例与 strategy-validator.ts 一致。
 */
export function listFactorComponents(): {
	factor: Record<string, string[]>
	crossFactor: Record<string, string[]>
} {
	const realTrading = join(
		process.env.ALL_DATA_PATH || "D:/QuantClassSpace/QuantData",
		"real_trading",
	)
	return {
		factor: enumerateLibrary(join(realTrading, "因子库")),
		crossFactor: enumerateLibrary(join(realTrading, "截面因子库")),
	}
}

/** 遍历 <libDir>/<category>/*.py；libDir 直属的 .py 归入 "(根目录)"；跳过 __init__.py 与 __pycache__ */
function enumerateLibrary(libDir: string): Record<string, string[]> {
	const result: Record<string, string[]> = {}
	if (!existsSync(libDir)) return result
	for (const dirent of readdirSync(libDir, { withFileTypes: true })) {
		if (dirent.name === "__pycache__") continue
		if (dirent.isDirectory()) {
			const names = readdirSync(join(libDir, dirent.name))
				.filter((f) => f.endsWith(".py") && f !== "__init__.py")
				.map((f) => f.replace(/\.py$/, ""))
				.sort()
			if (names.length > 0) result[dirent.name] = names
		} else if (dirent.name.endsWith(".py") && dirent.name !== "__init__.py") {
			const root = result["(根目录)"] ?? []
			root.push(dirent.name.replace(/\.py$/, ""))
			result["(根目录)"] = root.sort()
		}
	}
	return result
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --experimental-strip-types tests/mcp-server/component-catalog.test.ts`
Expected: PASS

---

### Task 5: tools.ts 注册（4 个新工具 + list_strategies 状态 + record_experiment 描述更新）

**Files:**
- Modify: `src/mcp-server/tools.ts`
- Modify: `tests/mcp-server/tools.test.ts`

- [ ] **Step 1: 先在 tools.test.ts 补失败断言**

`tests/mcp-server/tools.test.ts` 的 `it("exposes research workflow tools", ...)`（:124）内追加：

```ts
		assert.ok(names.includes("record_knowledge"))
		assert.ok(names.includes("get_knowledge"))
		assert.ok(names.includes("close_run"))
		assert.ok(names.includes("list_factor_components"))
```

- [ ] **Step 2: 跑集成测试确认失败**

Run: `pnpm build:mcp && node --test --experimental-strip-types tests/mcp-server/tools.test.ts`
Expected: FAIL（4 个新工具未注册）

- [ ] **Step 3: 实现注册**

a) `src/mcp-server/tools.ts` 顶部 import 区追加：

```ts
import { listFactorComponents } from "./component-catalog.ts"
import { getKnowledge, recordKnowledge } from "./knowledge-base.ts"
```

并把 research-run.ts 的既有 import 行补充 `closeRun, getRunStatuses`。

b) 在 `get_run_summary` 注册块（:1682-1706）之后追加四个工具：

```ts
	server.tool(
		"record_knowledge",
		"记录一条跨 run 知识到 workspace 级 knowledge.jsonl（旋钮级实验发现的结构化沉淀，只增不改）。证据链 evidence 必填。负面发现（旋钮恶化）同样值得记录。",
		{
			knob: z.string().describe("旋钮/组件标识，如 波动.波动率20 过滤阈值"),
			change: z.string().describe("做了什么变更，如 pct:<=0.25 → 0.20"),
			effect: z.string().describe("效果（含方向与幅度），如 最劣窗口回撤 -0.1pp，年化 +0.19pp"),
			evidence: z
				.array(
					z.object({
						runId: z.string(),
						from: z.string().optional(),
						to: z.string().optional(),
					}),
				)
				.describe("证据链，如 [{runId:'run-calmar-001',from:'v3',to:'v5'}]"),
			regime: z.string().optional().describe("生效/失效的市场环境"),
			tags: z.array(z.string()).optional(),
		},
		async (args) => {
			try {
				const result = recordKnowledge(args)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `记录知识失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_knowledge",
		"读取跨 run 知识库（knowledge.jsonl）。knobFilter 按旋钮名子串过滤。Researcher 提假设前必须先调用本工具。",
		{
			knobFilter: z.string().optional().describe("按旋钮名子串过滤"),
		},
		async ({ knobFilter }) => {
			try {
				const result = getKnowledge(knobFilter)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `读取知识库失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"close_run",
		"关闭研究 run 并记录关闭决策（写入 brief.json 的 status/closedAt/closeReason）。status: achieved（要求存在 SOTA）/ abandoned / paused。循环退出后必须调用本工具，杜绝烂尾 run。",
		{
			runId: z.string().describe("Run ID"),
			status: z
				.enum(["achieved", "abandoned", "paused"])
				.describe("关闭状态"),
			reason: z.string().describe("关闭原因（必填，一句话）"),
		},
		async ({ runId, status, reason }) => {
			try {
				const result = closeRun(runId, status, reason)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `关闭 run 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"list_factor_components",
		"枚举 real_trading 因子库/截面因子库的可用组件（类目 → 因子名列表）。提假设前用于确认因子真实存在，避免假设落到不存在的组件上。",
		{},
		async () => {
			try {
				const result = listFactorComponents()
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `枚举因子组件失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)
```

c) `list_strategies`（:1104-1139）无参分支的返回从 `{ runs }` 改为 `{ runs, runStatus: getRunStatuses() }`（保持 `runs: string[]` 不变，新增字段向后兼容）。

d) `record_experiment` 的 description（:1594）在末尾追加：「entry 新增可选字段：basedOn（分叉父 variantId）、hypothesisSource（假设来源引用，推荐 knowledge:<id>/trace:<runId>/<variantId>）、nextHypothesis（预埋下一轮假设种子）。lesson 传占位文本（待回填/TBD 等）会被拒绝；假设与历史高度相似时返回 warnings（不阻断）。」

- [ ] **Step 4: 重建 bundle 并跑集成测试**

Run: `pnpm build:mcp && node --test --experimental-strip-types tests/mcp-server/tools.test.ts`
Expected: PASS

---

### Task 6: runbook 修订

**Files:**
- Modify: `docs/superpowers/runbook/research-agent-runbook.md`

- [ ] **Step 1: 修订 §4.1（Researcher 固定输入序列 + 自批判）**

把 §4.1 第 1 条替换为：

```markdown
1. 按固定顺序收集上下文（不得跳步）：
   a) `get_knowledge()`——跨 run 知识库全量（有可疑旋钮时追加 `get_knowledge(knobFilter)` 精查）
   b) `get_run_summary(runId)`——当前 SOTA 与阈值差距
   c) `get_experiment_trace(runId, tail=5)`——近期假设与 lesson；重点看上一轮的 `nextHypothesis`（可采纳、拒绝或改造）
   d) `get_strategy_template`（首次或需要格式细节时）+ `list_factor_components`（假设涉及新因子/过滤组件时必查，确认组件真实存在）
2. 假设自批判三问（critic 步骤，内部完成不另外调工具）：
   - 与 trace 历史假设是否语义重复？（重复则放弃或改造）
   - 是否有知识条目或历史实验证据支撑？（把引用写进 `hypothesisSource`）
   - 是否可证伪？（必须指明预期改善的指标与方向）
```

原 §4.1 的 2/3 条顺次后移为 3/4。

- [ ] **Step 2: 修订 §4.5（record_experiment 新字段）**

在 §4.5 的 JSON 示例后追加：

```markdown
- `basedOn`：本轮 config 不是从上一 variant 演进、而是分叉自更早 variant 时必填（如 v5 基于 v3 而非 v4），保持 trace 可归因。
- `hypothesisSource`：假设来源引用——`knowledge:<id>`（来自知识库）/ `trace:<runId>/<variantId>`（来自历史实验）/ `none`（全新探索，需更强理由）。
- `nextHypothesis`：预埋给下一轮的假设种子（对应 RD-Agent 反馈阶段的 new_hypothesis），写清建议验证什么、为什么。
- lesson 占位文本（「待回填」「TBD」等）会被工具拒绝；假设与历史高度相似时工具返回 warnings，需在 lesson 中说明与相似实验的差异。
```

- [ ] **Step 3: 新增收尾纪律**

在 §4.6（循环退出）后追加一条：

```markdown
7. **循环退出后必须 `close_run`**：达标→`achieved`（要求存在 SOTA）；放弃→`abandoned`；暂停→`paused`，均附一句话原因。放弃或暂停时，把本轮最重要的负面发现（哪个旋钮无效/恶化）写入 `record_knowledge`——负面知识与正面知识同等宝贵，防止后续 run 重复踩坑。
```

- [ ] **Step 4: 工具计数与清单更新**

实测当前工具数：`grep -c "server\.tool(" src/mcp-server/tools.ts`，把 runbook §0 的工具数更新为实测值（含本次新增 4 个）；§2 角色分工表的 Researcher 行补 `get_knowledge`、`list_factor_components`，Summarizer 行补 `record_knowledge`、`close_run`。

---

### Task 7: 全量验证

**Files:** 无（纯验证）

- [ ] **Step 1: 单元测试全绿**

Run: `pnpm test:mcp`
Expected: 全部 PASS（含既有用例——特别注意 Task 1 的校验不能破坏历史 trace 读取相关用例）

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 3: 工具注册验证**

Run: `pnpm verify:mcp-tools`
Expected: `Required tools present: true`；可选：把 4 个新工具加入 `scripts/verify-mcp-tool-registration.mjs` 的 required 列表后再跑一次

- [ ] **Step 4: 汇总改动并请用户确认提交**

`git status` + `git diff --stat` 汇总；向用户报告改动清单，**等用户确认后**再 commit（commit message 遵循 Conventional Commits，如 `feat(mcp): 研究闭环知识库与 run 生命周期工具`）。

---

## Self-Review 记录

- Spec 覆盖：§3.1 trace 扩展→Task 1；§3.2 knowledge→Task 3；§3.3 run 状态→Task 2；§4.2 新工具→Task 3/4/5；§4.1 工具修改→Task 1/5；§5 runbook→Task 6；§6 测试→各 Task + Task 7。✅
- 关键陷阱已规避：占位校验不进 zod schema（历史 trace 兼容）；list_strategies 输出向后兼容（新增字段不改 `runs`）；brief.json 写回走原文合并（不被 zod strip）。
- 类型一致性：`warnings` 在 RecordExperimentResult 与测试断言一致；`getRunStatuses` 返回结构与 closeRun 写入字段一致（status/closeReason）；`KnowledgeEntry` id/ts 在 record 后必填。
