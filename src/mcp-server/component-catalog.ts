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
