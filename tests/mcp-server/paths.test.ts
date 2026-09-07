/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import assert from "node:assert"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
	pythonCandidates,
	resolvePythonCmd,
	resolveResourcesDir,
} from "../../src/mcp-server/paths.ts"

describe("paths", () => {
	it("resolves resources dir independent of process.cwd", () => {
		const dir = resolveResourcesDir()
		// 不依赖 process.cwd()：从源码树（src/mcp-server）或打包产物
		// （resources/mcp-server）出发都必须定位到含脚本的 resources 目录
		assert.ok(
			existsSync(join(dir, "parse_config.py")),
			`missing parse_config.py in ${dir}`,
		)
		assert.ok(
			existsSync(join(dir, "check_factor.py")),
			`missing check_factor.py in ${dir}`,
		)
	})

	it("python candidates include the arch-specific bundled python", () => {
		const candidates = pythonCandidates()
		assert.ok(
			candidates.some((p) =>
				p.includes(join("python", process.arch, "python")),
			),
			`candidates missing arch dir: ${candidates.join(", ")}`,
		)
	})

	it("resolvePythonCmd prefers an existing bundled python", () => {
		const existing = pythonCandidates().filter((p) => existsSync(p))
		const resolved = resolvePythonCmd()
		if (existing.length > 0) {
			assert.ok(
				existing.includes(resolved.cmd),
				`expected one of ${existing.join(", ")}, got ${resolved.cmd}`,
			)
			assert.ok(existsSync(resolved.cmd))
		} else {
			// 无内嵌 python 时回退系统命令，并保留搜索记录用于错误提示
			assert.ok(resolved.cmd === "python" || resolved.cmd === "python3")
		}
		assert.ok(resolved.searched.length > 0)
	})
})
