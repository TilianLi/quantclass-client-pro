/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * 资源路径解析。
 *
 * MCP Server 可能被打包为 resources/mcp-server/index.js 并由外部宿主
 * （Kimi Work、Claude Desktop 等）以任意 cwd spawn，因此禁止依赖
 * process.cwd() 定位 resources 目录。统一以模块自身位置为锚：
 * - 打包产物：resources/mcp-server/.. → resources
 * - 源码树：  src/mcp-server/../../resources → resources
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

const RESOURCE_DIR_CANDIDATES = [
	join(MODULE_DIR, ".."),
	join(MODULE_DIR, "..", "..", "resources"),
	join(process.cwd(), "resources"),
]

/** 定位 resources 目录（含 parse_config.py / check_factor.py 的目录） */
export function resolveResourcesDir(): string {
	for (const dir of RESOURCE_DIR_CANDIDATES) {
		if (
			existsSync(join(dir, "parse_config.py")) ||
			existsSync(join(dir, "check_factor.py"))
		) {
			return dir
		}
	}
	return RESOURCE_DIR_CANDIDATES[0]
}

/** 定位 resources 下的脚本文件 */
export function resourceScript(name: string): string {
	return join(resolveResourcesDir(), name)
}

/**
 * 内嵌 Python 候选路径（按优先级）。
 * 布局：resources/python/<arch>/python.exe（Windows），
 * mac/linux standalone 为 resources/python/<arch>/bin/python3。
 */
export function pythonCandidates(): string[] {
	const resourcesDir = resolveResourcesDir()
	const archDir = join(resourcesDir, "python", process.arch)
	return [
		join(resourcesDir, "python", "python.exe"),
		join(archDir, "python.exe"),
		join(archDir, "bin", "python3"),
		join(archDir, "bin", "python"),
	]
}

export interface PythonResolution {
	/** 实际使用的 python 命令（候选均不存在时为系统 python/python3 兜底） */
	cmd: string
	/** 已尝试的内嵌候选列表，用于错误提示 */
	searched: string[]
}

/** 解析可用的 python 命令：优先内嵌，其次系统 PATH 兜底 */
export function resolvePythonCmd(): PythonResolution {
	const searched = pythonCandidates()
	for (const p of searched) {
		if (existsSync(p)) return { cmd: p, searched }
	}
	return { cmd: process.platform === "win32" ? "python" : "python3", searched }
}

/** ENOENT 时给出可操作提示（列出已搜索路径），非 ENOENT 返回空串 */
export function pythonErrorHint(
	resolved: PythonResolution,
	errorMessage: string,
): string {
	if (!errorMessage.includes("ENOENT")) return ""
	return `（未找到 Python：内嵌候选 ${resolved.searched.join("、")} 均不存在，系统 PATH 也无 ${resolved.cmd}；请确认客户端内嵌 Python 已下载）`
}
