import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

describe("mcp tools integration", () => {
	const TMP = mkdtempSync(join(tmpdir(), "qc-tools-"))
	let client: Client
	let transport: StdioClientTransport

	before(async () => {
		process.env.QUANTCLASS_AGENT_WORKSPACE = TMP
		transport = new StdioClientTransport({
			command: "node",
			args: [join(process.cwd(), "resources", "mcp-server", "index.js")],
			env: { ...process.env, QUANTCLASS_AGENT_WORKSPACE: TMP },
		})
		client = new Client({ name: "test", version: "1.0.0" })
		await client.connect(transport)
	})

	after(async () => {
		await client.close()
		rmSync(TMP, { recursive: true, force: true })
	})

	it("workspace root is set", async () => {
		const { getWorkspaceRoot } = await import(
			"../../src/mcp-server/strategy-files.ts"
		)
		assert.strictEqual(getWorkspaceRoot(), TMP)
	})

	it("exposes strategy development tools", async () => {
		const tools = await client.listTools()
		const names = tools.tools.map((t) => t.name)
		assert.ok(names.includes("list_strategies"))
		assert.ok(names.includes("read_strategy_file"))
		assert.ok(names.includes("write_strategy_file"))
		assert.ok(names.includes("validate_strategy"))
		assert.ok(names.includes("evaluate_backtest"))
		assert.ok(names.includes("submit_strategy_for_review"))
	})

	it("writes and reads strategy file via MCP", async () => {
		const content = "backtest_name = 'test'\nstrategy_list = []\n"
		const writeRes = await client.callTool({
			name: "write_strategy_file",
			arguments: {
				runId: "run1",
				variantId: "v1",
				filename: "config.py",
				content,
			},
		})
		assert.ok(JSON.stringify(writeRes).includes("success"))

		const readRes = await client.callTool({
			name: "read_strategy_file",
			arguments: { runId: "run1", variantId: "v1", filename: "config.py" },
		})
		const text = readRes.content.find((c) => c.type === "text")?.text
		assert.strictEqual(text, content)
	})

	it("validates strategy config via MCP", async () => {
		const configPath = join(TMP, "run1", "v1", "config.py")
		const res = await client.callTool({
			name: "validate_strategy",
			arguments: { configFilePath: configPath },
		})
		const text = res.content.find((c) => c.type === "text")?.text ?? ""
		const parsed = JSON.parse(text)
		assert.strictEqual(parsed.valid, true)
	})

	it("evaluates backtest via MCP", async () => {
		const res = await client.callTool({
			name: "evaluate_backtest",
			arguments: {
				performances: [
					{ variantId: "v1", annual_return_pct: 10, max_drawdown_pct: -20 },
				],
				thresholds: { annual_return_pct: 0, max_drawdown_pct: -30 },
			},
		})
		const text = res.content.find((c) => c.type === "text")?.text ?? ""
		const parsed = JSON.parse(text)
		assert.strictEqual(parsed.passed, true)
		assert.strictEqual(parsed.bestVariantId, "v1")
	})

	it("submits strategy for review via MCP", async () => {
		const res = await client.callTool({
			name: "submit_strategy_for_review",
			arguments: {
				runId: "run1",
				variantId: "v1",
				evaluation: {
					passed: true,
					score: 1,
					details: {
						annual_return_pct: { value: 10, threshold: 0, passed: true },
					},
				},
				strategyPath: "run1/v1/config.py",
				summary: "test summary",
			},
		})
		const text = res.content.find((c) => c.type === "text")?.text ?? ""
		const parsed = JSON.parse(text)
		assert.ok(parsed.reportPath.endsWith("candidate-report.md"))
	})
})
