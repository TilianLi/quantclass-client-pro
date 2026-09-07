/*
 * Copyright (C) 2024 QuantClass Ltd.
 *
 * This file is part of the QuantClass client.
 *
 * Licensed under the Business Source License 1.1 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://mariadb.com/bsl11/
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
} from "./strategy-files.ts"

export interface CandidateReport {
	runId: string
	variantId: string
	evaluation: {
		passed: boolean
		score: number
		details: Record<
			string,
			{ value: number; threshold?: number | undefined; passed: boolean }
		>
	}
	strategyPath: string
	summary: string
	/** 样本外验证窗口（如 "2025-01-01 至今"），与 oosEvaluation 配套 */
	oosWindow?: string
	/** 样本外评估结果（与 evaluation 同构），缺省则不渲染样本外小节 */
	oosEvaluation?: {
		passed: boolean
		score: number
		details: Record<
			string,
			{ value: number; threshold?: number | undefined; passed: boolean }
		>
	}
	/** 样本外评估结论（AI 按余量规则给出的文字判断） */
	oosNote?: string
}

export function generateCandidateReport(params: CandidateReport): string {
	const lines: string[] = [
		"# 候选策略报告",
		"",
		`- **Run ID**: ${params.runId}`,
		`- **Variant ID**: ${params.variantId}`,
		`- **策略路径**: ${params.strategyPath}`,
		`- **综合达标**: ${params.evaluation.passed ? "✅ 通过" : "⚠️ 未完全达标（当前最优）"}`,
		`- **得分**: ${(params.evaluation.score * 100).toFixed(1)}%`,
	]

	if (params.oosEvaluation) {
		lines.push(
			`- **样本外（${params.oosWindow ?? "验证窗口"}）**: ${params.oosEvaluation.passed ? "✅ 通过" : "❌ 未通过"}`,
		)
	}

	lines.push(
		"",
		"## 绩效指标",
		"",
		"| 指标 | 实际值 | 阈值 | 是否达标 |",
		"|------|--------|------|----------|",
	)

	for (const [key, detail] of Object.entries(params.evaluation.details)) {
		lines.push(
			`| ${key} | ${detail.value.toFixed(2)} | ${detail.threshold ?? "-"} | ${detail.passed ? "✅" : "❌"} |`,
		)
	}

	if (params.oosEvaluation) {
		lines.push(
			"",
			`## 样本外验证（${params.oosWindow ?? "验证窗口"}）`,
			"",
			"| 指标 | 实际值 | 阈值 | 是否达标 |",
			"|------|--------|------|----------|",
		)
		for (const [key, detail] of Object.entries(params.oosEvaluation.details)) {
			lines.push(
				`| ${key} | ${detail.value.toFixed(2)} | ${detail.threshold ?? "-"} | ${detail.passed ? "✅" : "❌"} |`,
			)
		}
		if (params.oosNote) {
			lines.push("", `> ${params.oosNote}`)
		}
	}

	lines.push("", "## 策略说明", "", params.summary, "")
	lines.push(
		"---",
		"该策略已导入 QuantClass 策略库（回测验证环境）。请确认是否为其分配实盘资金占比（set_strategy_weight）并开启自动交易。",
	)

	return lines.join("\n")
}

export function submitForReview(
	workspaceRoot: string,
	params: CandidateReport,
): { reportPath: string; report: string } {
	assertSafePathComponent(params.runId, "runId")
	const report = generateCandidateReport(params)
	const runDir = assertInsideWorkspace(
		join(workspaceRoot, params.runId),
		workspaceRoot,
	)
	if (!existsSync(runDir)) {
		mkdirSync(runDir, { recursive: true })
	}
	const reportPath = join(runDir, "candidate-report.md")
	writeFileSync(reportPath, report, "utf-8")
	return { reportPath, report }
}
