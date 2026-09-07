/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 *
 * Note: shebang `#!/usr/bin/env node` is injected by the build:mcp
 * esbuild banner, not from source.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerResources } from "./resources.js"
import { registerTools } from "./tools.js"

const server = new McpServer({
	name: "quantclass",
	version: "1.0.0",
})

registerTools(server)
registerResources(server)

async function main(): Promise<void> {
	const transport = new StdioServerTransport()
	await server.connect(transport)
}

main().catch((error) => {
	console.error("MCP Server 启动失败:", error)
	process.exit(1)
})
