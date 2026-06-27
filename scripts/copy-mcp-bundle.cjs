/**
 * 将 MCP server bundle 从 resources 同步到已打包的 dist 目录（如果存在）。
 */
const fs = require("node:fs")
const path = require("node:path")

const source = path.resolve(__dirname, "../resources/mcp-server/index.js")
const targets = [
	path.resolve(__dirname, "../dist/win-unpacked/resources/mcp-server/index.js"),
	path.resolve(
		__dirname,
		"../dist/mac/QuantclassClient.app/Contents/Resources/mcp-server/index.js",
	),
	path.resolve(
		__dirname,
		"../dist/linux-unpacked/resources/mcp-server/index.js",
	),
]

for (const target of targets) {
	try {
		if (fs.existsSync(path.dirname(target))) {
			fs.copyFileSync(source, target)
			console.log(`[copy-mcp-bundle] copied to ${target}`)
		}
	} catch (error) {
		console.error(
			`[copy-mcp-bundle] failed to copy to ${target}:`,
			error.message,
		)
	}
}
