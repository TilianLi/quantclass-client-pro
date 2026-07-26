import assert from "node:assert"
import { describe, it } from "node:test"
import {
	type WalkforwardWindowResult,
	summarizeWalkforward,
} from "../../src/mcp-server/walkforward-eval.ts"

function okWindow(
	start: string,
	score: number,
	annual: number,
): WalkforwardWindowResult {
	return {
		window: { start_date: start, end_date: null },
		ok: true,
		metrics: { annual_return_pct: annual, max_drawdown_pct: -20 },
		evaluation: { passed: score === 1, score },
	}
}

function failedWindow(start: string): WalkforwardWindowResult {
	return {
		window: { start_date: start, end_date: null },
		ok: false,
		error: "回测内核退出码非零",
	}
}

describe("walkforward-eval", () => {
	it("empty results → score 0, not passed, no worst window", () => {
		const s = summarizeWalkforward([])
		assert.strictEqual(s.score, 0)
		assert.strictEqual(s.passed, false)
		assert.strictEqual(s.worstWindow, null)
		assert.strictEqual(s.metrics, undefined)
	})

	it("single successful window → its own score and metrics", () => {
		const s = summarizeWalkforward([okWindow("2020-01-01", 0.5, 12)])
		assert.strictEqual(s.score, 0.5)
		assert.strictEqual(s.passed, false)
		assert.deepStrictEqual(s.worstWindow, {
			start_date: "2020-01-01",
			end_date: null,
		})
		assert.strictEqual(s.metrics?.annual_return_pct, 12)
	})

	it("all windows full score → passed", () => {
		const s = summarizeWalkforward([
			okWindow("2018-01-01", 1, 20),
			okWindow("2021-01-01", 1, 15),
		])
		assert.strictEqual(s.score, 1)
		assert.strictEqual(s.passed, true)
	})

	it("worst window = min score; metrics come from that window", () => {
		const s = summarizeWalkforward([
			okWindow("2018-01-01", 1, 20),
			okWindow("2021-01-01", 0.5, 8),
			okWindow("2023-01-01", 1, 30),
		])
		assert.strictEqual(s.score, 0.5)
		assert.strictEqual(s.passed, false)
		assert.strictEqual(s.worstWindow?.start_date, "2021-01-01")
		assert.strictEqual(s.metrics?.annual_return_pct, 8)
	})

	it("score tie → lower annual return is the worst window", () => {
		const s = summarizeWalkforward([
			okWindow("2018-01-01", 0.5, 12),
			okWindow("2021-01-01", 0.5, 6),
		])
		assert.strictEqual(s.worstWindow?.start_date, "2021-01-01")
		assert.strictEqual(s.metrics?.annual_return_pct, 6)
	})

	it("failed window counts as score 0 and becomes worst; metrics absent", () => {
		const s = summarizeWalkforward([
			okWindow("2018-01-01", 1, 20),
			failedWindow("2021-01-01"),
		])
		assert.strictEqual(s.score, 0)
		assert.strictEqual(s.passed, false)
		assert.strictEqual(s.worstWindow?.start_date, "2021-01-01")
		assert.strictEqual(s.metrics, undefined)
	})

	it("all windows failed → score 0, not passed, worst = first failed", () => {
		const s = summarizeWalkforward([
			failedWindow("2018-01-01"),
			failedWindow("2021-01-01"),
		])
		assert.strictEqual(s.score, 0)
		assert.strictEqual(s.passed, false)
		assert.strictEqual(s.worstWindow?.start_date, "2018-01-01")
		assert.strictEqual(s.metrics, undefined)
	})
})
