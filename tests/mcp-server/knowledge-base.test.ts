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
		assert.throws(() =>
			recordKnowledge({
				knob: "",
				change: "x",
				effect: "y",
				evidence: [{ runId: "r" }],
			}),
		)
		assert.throws(() =>
			recordKnowledge({ knob: "k", change: "x", effect: "y", evidence: [] }),
		)
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
		const a = recordKnowledge({
			knob: "a",
			change: "c",
			effect: "e",
			evidence: [{ runId: "r" }],
		})
		const b = recordKnowledge({
			knob: "b",
			change: "c",
			effect: "e",
			evidence: [{ runId: "r" }],
		})
		assert.notStrictEqual(a.id, b.id)
		assert.ok(a.id.slice(0, 9) === b.id.slice(0, 9))
	})
})
