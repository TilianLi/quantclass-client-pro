#!/usr/bin/env node
/**
 * 在 dev 模式下启动 MCP Server 前，检查 resources/mcp-server/index.js
 * 是否比 src/mcp-server/ 源码旧。如果是，自动运行 pnpm build:mcp。
 */
import { execSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const srcDir = resolve(process.cwd(), "src", "mcp-server")
const bundlePath = resolve(process.cwd(), "resources", "mcp-server", "index.js")

function newestMtime(dir) {
	let max = 0
	for (const entry of readdirSync(dir, {
		withFileTypes: true,
		recursive: true,
	})) {
		if (!entry.isFile()) continue
		const mtime = statSync(join(entry.parentPath ?? dir, entry.name)).mtimeMs
		if (mtime > max) max = mtime
	}
	return max
}

const bundleMtime = existsSync(bundlePath) ? statSync(bundlePath).mtimeMs : 0
const srcMtime = newestMtime(srcDir)

if (srcMtime > bundleMtime) {
	console.log("[ensure-mcp-bundle] MCP bundle is stale, rebuilding...")
	execSync("pnpm build:mcp", { stdio: "inherit" })
} else {
	console.log("[ensure-mcp-bundle] MCP bundle is up to date")
}
