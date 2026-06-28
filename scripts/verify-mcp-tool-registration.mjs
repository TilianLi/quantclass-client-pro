#!/usr/bin/env node
/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REQUIRED_TOOLS = [
	"list_strategies",
	"read_strategy_file",
	"write_strategy_file",
	"validate_strategy",
	"evaluate_backtest",
	"submit_strategy_for_review",
]

async function main() {
	const workspace = mkdtempSync(join(tmpdir(), "qc-verify-"))
	const transport = new StdioClientTransport({
		command: "node",
		args: [join(process.cwd(), "resources", "mcp-server", "index.js")],
		env: { ...process.env, QUANTCLASS_AGENT_WORKSPACE: workspace },
	})
	const client = new Client({ name: "verify", version: "1.0.0" })
	await client.connect(transport)

	const toolsResult = await client.listTools()
	const names = toolsResult.tools.map((t) => t.name)
	const missing = REQUIRED_TOOLS.filter((n) => !names.includes(n))

	console.log("Registered tools count:", names.length)
	console.log("Required tools present:", missing.length === 0)
	if (missing.length > 0) {
		console.error("Missing tools:", missing)
		await client.close()
		rmSync(workspace, { recursive: true, force: true })
		process.exit(1)
	}

	await client.callTool({ name: "list_strategies", arguments: {} })
	await client.callTool({
		name: "write_strategy_file",
		arguments: {
			runId: "run1",
			variantId: "v1",
			filename: "config.py",
			content: "backtest_name = 'x'\nstrategy_list = []\n",
		},
	})
	await client.callTool({
		name: "read_strategy_file",
		arguments: { runId: "run1", variantId: "v1", filename: "config.py" },
	})
	await client.callTool({
		name: "validate_strategy",
		arguments: { configFilePath: join(workspace, "run1", "v1", "config.py") },
	})
	await client.callTool({
		name: "evaluate_backtest",
		arguments: {
			performances: [
				{ variantId: "v1", annual_return_pct: 10, max_drawdown_pct: -20 },
			],
			thresholds: { annual_return_pct: 0, max_drawdown_pct: -30 },
		},
	})
	await client.callTool({
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
			summary: "test",
		},
	})

	console.log("All required tools callable.")
	await client.close()
	rmSync(workspace, { recursive: true, force: true })
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
