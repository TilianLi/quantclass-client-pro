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
	const seq = existing.filter((e) => e.id.startsWith(prefix)).length + 1
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
