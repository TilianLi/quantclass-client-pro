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
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkFactorSource } from "./factor-check.ts"

const REQUIRED_VARS = ["backtest_name", "strategy_list"]

export interface ValidationResult {
	valid: boolean
	errors: string[]
	extracted?: Record<string, unknown>
}

export function validateConfigSyntax(source: string): string[] {
	const errors: string[] = []
	const tmpDir = mkdtempSync(join(tmpdir(), "qc-syntax-"))
	const tmpFile = join(tmpDir, "config.py")
	try {
		writeFileSync(tmpFile, source, "utf-8")
		execFileSync(
			process.platform === "win32" ? "python" : "python3",
			[
				"-c",
				"import ast; ast.parse(open(__import__('sys').argv[1], 'r', encoding='utf-8').read())",
				tmpFile,
			],
			{
				encoding: "utf-8",
				timeout: 5000,
			},
		)
	} catch (error) {
		errors.push(
			`语法错误: ${error instanceof Error ? error.message : String(error)}`,
		)
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
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

/**
 * 从因子元组中提取因子名称（兼容 4/5 元组）
 */
function getFactorName(factor: unknown[]): string {
	return typeof factor[0] === "string" ? factor[0] : ""
}

/**
 * 收集 strategy_list 中引用的所有因子名称
 */
function collectFactorNames(strategyList: unknown[]): Set<string> {
	const names = new Set<string>()
	for (const stg of strategyList) {
		if (typeof stg !== "object" || stg === null) continue
		const s = stg as Record<string, unknown>

		for (const listKey of ["factor_list", "filter_list", "filter_list_post"]) {
			const list = s[listKey]
			if (!Array.isArray(list)) continue
			for (const item of list) {
				if (!Array.isArray(item)) continue
				// filter_list 元素可能是 [name, param, condition, post?]
				const name = getFactorName(item)
				if (name) names.add(name)
			}
		}

		// 个股择时因子
		const stockTimingList = s.stock_timing_list
		if (Array.isArray(stockTimingList)) {
			for (const timing of stockTimingList) {
				if (typeof timing !== "object" || timing === null) continue
				const factorList = (timing as Record<string, unknown>).factor_list
				if (Array.isArray(factorList)) {
					for (const f of factorList) {
						if (Array.isArray(f)) {
							const name = getFactorName(f)
							if (name) names.add(name)
						}
					}
				}
			}
		}
	}
	return names
}

/**
 * 收集 strategy_list 中引用的所有信号名称
 */
function collectSignalNames(strategyList: unknown[]): Set<string> {
	const names = new Set<string>()
	for (const stg of strategyList) {
		if (typeof stg !== "object" || stg === null) continue
		const s = stg as Record<string, unknown>

		for (const key of ["timing", "override"]) {
			const timing = s[key]
			if (typeof timing === "object" && timing !== null) {
				const name = (timing as Record<string, unknown>).name
				if (typeof name === "string" && name) names.add(name)
			}
		}

		const stockTimingList = s.stock_timing_list
		if (Array.isArray(stockTimingList)) {
			for (const timing of stockTimingList) {
				if (typeof timing !== "object" || timing === null) continue
				const name = (timing as Record<string, unknown>).name
				if (typeof name === "string" && name) names.add(name)
			}
		}
	}
	return names
}

/**
 * 校验策略目录下的因子库结构
 */
function validateFactorLibrary(configDir: string): string[] {
	const errors: string[] = []
	const factorLibDir = join(configDir, "因子库")
	if (!existsSync(factorLibDir)) return errors

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry)
			const stat = statSync(fullPath)
			if (stat.isDirectory()) {
				const initPath = join(fullPath, "__init__.py")
				if (!existsSync(initPath)) {
					errors.push(
						`因子子目录缺少 __init__.py: ${fullPath.replace(`${configDir}/`, "")}`,
					)
				}
				walk(fullPath)
			}
		}
	}
	walk(factorLibDir)
	return errors
}

/**
 * 校验策略目录下因子库中每个因子源码（语法 + AST 白名单 + 接口）。
 * 与 write_factor_file 使用同一套静态检查，防止绕过工具手工放置的因子。
 */
function validateFactorContents(configDir: string): string[] {
	const errors: string[] = []
	const factorLibDir = join(configDir, "因子库")
	if (!existsSync(factorLibDir)) return errors

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry)
			const stat = statSync(fullPath)
			if (stat.isDirectory()) {
				walk(fullPath)
			} else if (entry.endsWith(".py") && entry !== "__init__.py") {
				const rel = fullPath.replace(`${configDir}/`, "")
				const check = checkFactorSource(readFileSync(fullPath, "utf-8"))
				if (!check.ok) {
					for (const e of check.errors) {
						errors.push(`${rel}: ${e}`)
					}
				}
			}
		}
	}
	walk(factorLibDir)
	return errors
}

/**
 * 解析因子名称对应的候选文件路径
 */
function resolveFactorPaths(
	name: string,
	configDir: string,
	realTradingDir: string,
): string[] {
	const parts = name.split(".")
	const fileName = `${parts[parts.length - 1]}.py`
	const subDirs = parts.slice(0, -1)

	const localDir = join(configDir, "因子库", ...subDirs)
	const rtDir = join(realTradingDir, "因子库", ...subDirs)

	return [join(localDir, fileName), join(rtDir, fileName)]
}

/**
 * 解析信号名称对应的候选文件路径
 */
function resolveSignalPaths(
	name: string,
	configDir: string,
	realTradingDir: string,
): string[] {
	const fileName = `${name}.py`
	return [
		join(configDir, "信号库", fileName),
		join(realTradingDir, "信号库", fileName),
	]
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

		const errors = validateConfigVariables(extracted)

		// -- 因子库结构检查
		const configDir = dirname(configPath)
		errors.push(...validateFactorLibrary(configDir))
		// -- 因子源码内容检查（语法 + AST 白名单 + 接口）
		errors.push(...validateFactorContents(configDir))

		// -- 因子/信号存在性检查
		const strategyList = Array.isArray(extracted.strategy_list)
			? extracted.strategy_list
			: []
		const realTradingDir = join(
			process.env.ALL_DATA_PATH || "D:/QuantClassSpace/QuantData",
			"real_trading",
		)

		for (const name of collectFactorNames(strategyList)) {
			const candidates = resolveFactorPaths(name, configDir, realTradingDir)
			if (!candidates.some(existsSync)) {
				errors.push(
					`因子文件不存在: ${name}（ expected: ${candidates.join(" or ")}）`,
				)
			}
		}

		for (const name of collectSignalNames(strategyList)) {
			const candidates = resolveSignalPaths(name, configDir, realTradingDir)
			if (!candidates.some(existsSync)) {
				errors.push(
					`择时信号文件不存在: ${name}（expected: ${candidates.join(" or ")}）`,
				)
			}
		}

		if (errors.length > 0) {
			return { valid: false, errors, extracted }
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
