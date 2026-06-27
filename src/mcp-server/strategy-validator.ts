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
import { existsSync } from "node:fs"
import { join } from "node:path"

const REQUIRED_VARS = ["start_date", "end_date", "period", "strategy_name"]

export interface ValidationResult {
	valid: boolean
	errors: string[]
	extracted?: Record<string, unknown>
}

export function validateConfigSyntax(source: string): string[] {
	const errors: string[] = []
	try {
		execFileSync(
			process.platform === "win32" ? "python" : "python3",
			[
				"-c",
				"import ast; ast.parse(open(__import__('sys').argv[1], 'r', encoding='utf-8').read())",
				"-",
			],
			{
				input: source,
				encoding: "utf-8",
				timeout: 5000,
			},
		)
	} catch (error) {
		errors.push(
			`语法错误: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	return errors
}

export function validateConfigVariables(
	extracted: Record<string, unknown>,
): string[] {
	const errors: string[] = []
	for (const name of REQUIRED_VARS) {
		if (!(name in extracted)) {
			errors.push(`缺少必填变量: ${name}`)
		}
	}
	return errors
}

export function validateStrategy(configPath: string): ValidationResult {
	if (!existsSync(configPath)) {
		return { valid: false, errors: [`文件不存在: ${configPath}`] }
	}

	const pythonExe = join(process.cwd(), "resources", "python", "python.exe")
	const parseScript = join(process.cwd(), "resources", "parse_config.py")
	const pythonCmd = existsSync(pythonExe)
		? pythonExe
		: process.platform === "win32"
			? "python"
			: "python3"

	try {
		const output = execFileSync(
			pythonCmd,
			[parseScript, configPath, ...REQUIRED_VARS],
			{
				encoding: "utf-8",
				timeout: 10000,
			},
		)

		const extracted = JSON.parse(output) as Record<string, unknown>
		if (extracted.__error__) {
			return { valid: false, errors: [String(extracted.__error__)] }
		}

		const missingErrors = validateConfigVariables(extracted)
		if (missingErrors.length > 0) {
			return { valid: false, errors: missingErrors, extracted }
		}

		return { valid: true, errors: [], extracted }
	} catch (error) {
		return {
			valid: false,
			errors: [
				`校验失败: ${error instanceof Error ? error.message : String(error)}`,
			],
		}
	}
}
