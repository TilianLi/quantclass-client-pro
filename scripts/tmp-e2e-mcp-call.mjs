#!/usr/bin/env node
// 临时 e2e 验证用 MCP 调用器（用完即删）：
//   node scripts/tmp-e2e-mcp-call.mjs <tool> '<jsonArgs|@argsFile>' [timeoutMs]
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const [toolName, argsJson = "{}", timeoutMs = "120000"] = process.argv.slice(2)
if (!toolName) {
	console.error(
		"usage: node scripts/tmp-e2e-mcp-call.mjs <tool> '<jsonArgs|@argsFile>' [timeoutMs]",
	)
	process.exit(2)
}
const toolArgs = argsJson.startsWith("@")
	? readFileSync(argsJson.slice(1), "utf-8")
	: argsJson

const repoRoot = process.cwd()
const transport = new StdioClientTransport({
	command: "node",
	args: [join(repoRoot, "resources", "mcp-server", "index.js")],
	env: {
		...process.env,
		QUANTCLASS_AGENT_WORKSPACE: join(repoRoot, "workspace", "agent-strategies"),
		QUANTCLASS_PORT: "8787",
	},
})
const client = new Client({ name: "e2e", version: "1.0.0" })
try {
	await client.connect(transport)
	const result = await client.callTool(
		{ name: toolName, arguments: JSON.parse(toolArgs) },
		undefined,
		{ timeout: Number(timeoutMs) },
	)
	for (const c of result.content ?? []) {
		if (c.type === "text") console.log(c.text)
	}
	if (result.isError) process.exitCode = 1
} finally {
	await client.close()
}
