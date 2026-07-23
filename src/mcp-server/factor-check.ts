/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pythonErrorHint, resolvePythonCmd, resourceScript } from "./paths.ts"

export interface FactorCheckResult {
	ok: boolean
	errors: string[]
	warnings: string[]
	interface: {
		kind?: string
		add_factor?: boolean
		fin_cols?: string[] | null
		ov_cols?: string[] | null
		referenced_columns?: string[]
	}
}

export type FactorKind = "factor" | "cross_factor"

/**
 * 对因子源码做静态检查（语法 + AST 白名单 + 接口提取）。
 * 通过 resources/check_factor.py（stdlib）在内嵌或系统 Python 上执行。
 * kind=factor 为时序因子（因子库），kind=cross_factor 为截面因子
 * （截面因子库；额外要求 ov_cols，并放宽 core/scipy 导入）。
 */
export function checkFactorSource(
	source: string,
	kind: FactorKind = "factor",
): FactorCheckResult {
	const tmpDir = mkdtempSync(join(tmpdir(), "qc-factor-"))
	const tmpFile = join(tmpDir, "factor.py")
	try {
		writeFileSync(tmpFile, source, "utf-8")
		const python = resolvePythonCmd()
		const script = resourceScript("check_factor.py")
		const output = execFileSync(python.cmd, [script, tmpFile, kind], {
			encoding: "utf-8",
			timeout: 10000,
		})
		return JSON.parse(output) as FactorCheckResult
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		return {
			ok: false,
			errors: [
				`因子检查执行失败: ${msg}${pythonErrorHint(resolvePythonCmd(), msg)}`,
			],
			warnings: [],
			interface: {},
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
}
