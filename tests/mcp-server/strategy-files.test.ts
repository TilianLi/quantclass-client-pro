import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-agent-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

const {
	listRuns,
	listVariants,
	readStrategyFile,
	writeStrategyFile,
	listStrategyFiles,
} = await import("../../src/mcp-server/strategy-files.ts")

describe("strategy-files", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("lists empty workspace", () => {
		assert.deepStrictEqual(listRuns(), [])
	})

	it("writes and reads strategy file", () => {
		writeStrategyFile("run-001", "v1", "config.py", "X = 1")
		assert.strictEqual(readStrategyFile("run-001", "v1", "config.py"), "X = 1")
	})

	it("lists variants", () => {
		writeStrategyFile("run-001", "v2", "config.py", "X = 2")
		assert.deepStrictEqual(listVariants("run-001"), ["v1", "v2"])
	})

	it("lists files in variant", () => {
		assert.deepStrictEqual(listStrategyFiles("run-001", "v1"), ["config.py"])
	})

	it("throws on missing file", () => {
		assert.throws(() => readStrategyFile("run-001", "v1", "missing.py"))
	})
})
