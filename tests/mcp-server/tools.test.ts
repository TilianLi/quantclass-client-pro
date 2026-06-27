import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

describe("mcp tools integration", () => {
	const TMP = mkdtempSync(join(tmpdir(), "qc-tools-"))

	before(() => {
		process.env.QUANTCLASS_AGENT_WORKSPACE = TMP
	})

	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("workspace root is set", async () => {
		const { getWorkspaceRoot } = await import(
			"../../src/mcp-server/strategy-files.ts"
		)
		assert.strictEqual(getWorkspaceRoot(), TMP)
	})
})
