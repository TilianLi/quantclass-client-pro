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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
	validateConfigSyntax,
	validateConfigVariables,
	validateStrategy,
} from "../../src/mcp-server/strategy-validator.ts"

const TMP = mkdtempSync(join(tmpdir(), "qc-validator-"))

describe("strategy-validator", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("returns empty errors for valid Python syntax", () => {
		const errors = validateConfigSyntax("x = 1\ny = 2")
		assert.deepStrictEqual(errors, [])
	})

	it("returns errors for invalid Python syntax", () => {
		const errors = validateConfigSyntax("x =\n")
		assert.strictEqual(errors.length, 1)
		assert.ok(errors[0]?.includes("语法错误"))
	})

	it("reports missing variables", () => {
		const path = join(TMP, "bad.py")
		writeFileSync(path, "x = 1")
		const result = validateStrategy(path)
		assert.strictEqual(result.valid, false)
		assert.ok(result.errors.some((e) => e.includes("缺少必填变量")))
	})

	it("validates correct config", () => {
		const path = join(TMP, "good.py")
		writeFileSync(
			path,
			`start_date = "2020-01-01"\nend_date = "2024-01-01"\nperiod = "daily"\nstrategy_name = "demo"`,
		)
		const result = validateStrategy(path)
		assert.strictEqual(result.valid, true)
		assert.strictEqual(result.extracted?.strategy_name, "demo")
	})

	it("reports missing start_date", () => {
		const errors = validateConfigVariables({ end_date: "2024-01-01" })
		assert.ok(errors.some((e) => e.includes("start_date")))
	})
})
