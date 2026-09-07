import assert from "node:assert"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { submitForReview } from "../../src/mcp-server/review-submitter.ts"

const TMP = mkdtempSync(join(tmpdir(), "qc-review-"))

describe("review-submitter", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("generates and writes candidate report", () => {
		const { reportPath, report } = submitForReview(TMP, {
			runId: "run-001",
			variantId: "v3",
			evaluation: {
				passed: true,
				score: 1,
				details: {
					annual_return_pct: { value: 20, threshold: 15, passed: true },
				},
			},
			strategyPath: "workspace/agent-strategies/run-001/v3/config.py",
			summary: "动量+ROE 过滤策略，第三版达标。",
		})

		assert.ok(report.includes("候选策略报告"))
		assert.ok(report.includes("动量+ROE"))
		assert.ok(existsSync(reportPath))
		assert.ok(readFileSync(reportPath, "utf-8").includes("run-001"))
	})

	it("rejects path traversal in runId", () => {
		assert.throws(
			() =>
				submitForReview(TMP, {
					runId: "../../../tmp/evil",
					variantId: "v3",
					evaluation: {
						passed: true,
						score: 1,
						details: {
							annual_return_pct: {
								value: 20,
								threshold: 15,
								passed: true,
							},
						},
					},
					strategyPath: "workspace/agent-strategies/run-001/v3/config.py",
					summary: "should not be written",
				}),
			/runId 包含非法字符/,
		)
	})

	it("renders OOS section when oosEvaluation provided", () => {
		const { report } = submitForReview(TMP, {
			runId: "run-oos",
			variantId: "v1",
			evaluation: {
				passed: true,
				score: 1,
				details: {
					annual_return_pct: { value: 20, threshold: 15, passed: true },
				},
			},
			strategyPath: "run-oos/v1/config.py",
			summary: "test",
			oosWindow: "2025-01-01 至今",
			oosEvaluation: {
				passed: false,
				score: 0.5,
				details: {
					annual_return_pct: { value: 12, threshold: 15, passed: false },
				},
			},
			oosNote: "样本外年化保留 60%，回撤恶化 1.2 倍，判定可接受",
		})

		assert.ok(report.includes("样本外验证（2025-01-01 至今）"))
		assert.ok(report.includes("❌ 未通过"))
		assert.ok(report.includes("回撤恶化 1.2 倍"))
	})

	it("omits OOS section when oosEvaluation absent", () => {
		const { report } = submitForReview(TMP, {
			runId: "run-noos",
			variantId: "v1",
			evaluation: {
				passed: true,
				score: 1,
				details: {
					annual_return_pct: { value: 20, threshold: 15, passed: true },
				},
			},
			strategyPath: "run-noos/v1/config.py",
			summary: "test",
		})

		assert.ok(!report.includes("样本外验证"))
	})
})
