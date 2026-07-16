/**
 * MCP stdio 客户端测试脚本：验证 import_strategy + run_backtest 流程
 */
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SERVER_PATH = path.resolve(
	__dirname,
	"../dist/win-unpacked/resources/mcp-server/index.js",
)

const CONFIG_FILE_PATH =
	"D:\\QuantClassSpace\\策略\\凌烟阁中市值选股策略精心随机_26_v3\\config_凌烟阁中市值选股策略精心随机.py"

let requestId = 0
function makeRequest(method, params) {
	return {
		jsonrpc: "2.0",
		id: ++requestId,
		method,
		params,
	}
}

function send(proc, method, params) {
	const req = makeRequest(method, params)
	const line = JSON.stringify(req)
	console.log(">> " + line)
	proc.stdin.write(line + "\n")
	return requestId
}

async function main() {
	const proc = spawn("node", [SERVER_PATH], {
		env: { ...process.env, QUANTCLASS_PORT: "8787" },
	})

	const pending = new Map()

	proc.stdout.on("data", (data) => {
		const lines = data.toString().split("\n").filter(Boolean)
		for (const line of lines) {
			console.log("<< " + line)
			try {
				const msg = JSON.parse(line)
				if (msg.id && pending.has(msg.id)) {
					const { resolve, reject } = pending.get(msg.id)
					pending.delete(msg.id)
					if (msg.error) reject(msg.error)
					else resolve(msg.result)
				}
			} catch {}
		}
	})

	proc.stderr.on("data", (data) => {
		console.error("[stderr] " + data.toString().trim())
	})

	function call(method, params, timeoutMs = 120000) {
		return new Promise((resolve, reject) => {
			const id = send(proc, method, params)
			pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id)
					reject(new Error(`Timeout waiting for response to ${method}`))
				}
			}, timeoutMs)
		})
	}

	try {
		// 1. initialize
		await call("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		})
		console.log("\n✅ initialize success")

		// 2. tools/list
		const tools = await call("tools/list", {})
		console.log("\n✅ tools/list success, tool count:", tools.tools.length)
		console.log(
			"Tools:",
			tools.tools.map((t) => t.name),
		)

		// 3. import_strategy
		const importResult = await call("tools/call", {
			name: "import_strategy",
			arguments: {
				configFilePath: CONFIG_FILE_PATH,
				capWeight: 1,
			},
		})
		console.log("\n✅ import_strategy result:")
		console.log(JSON.stringify(importResult, null, 2))

		// 4. set_backtest_config
		const configResult = await call("tools/call", {
			name: "set_backtest_config",
			arguments: {
				initial_cash: 1000000,
				start_date: "2024-01-01",
				end_date: null,
				filter_kcb: "0",
				filter_cyb: "0",
				filter_bj: "0",
			},
		})
		console.log("\n✅ set_backtest_config result:")
		console.log(JSON.stringify(configResult, null, 2))

		// 5. run_backtest
		console.log("\n⏳ run_backtest 可能需要数分钟，请等待...")
		const backtestResult = await call(
			"tools/call",
			{
				name: "run_backtest",
				arguments: {},
			},
			1_800_000,
		)
		console.log("\n✅ run_backtest result:")
		console.log(JSON.stringify(backtestResult, null, 2))

		// 6. get_backtest_result
		const resultData = await call("tools/call", {
			name: "get_backtest_result",
			arguments: {},
		})
		console.log("\n✅ get_backtest_result result:")
		console.log(JSON.stringify(resultData, null, 2))

		// 7. get_backtest_performance
		const perfData = await call("tools/call", {
			name: "get_backtest_performance",
			arguments: {},
		})
		console.log("\n✅ get_backtest_performance result:")
		console.log(JSON.stringify(perfData, null, 2))

		console.log("\n🎉 MCP 策略导入 + 回测验收流程完成")
	} catch (error) {
		console.error("\n❌ 测试失败:", error)
	} finally {
		proc.stdin.end()
		setTimeout(() => proc.kill(), 1000)
	}
}

main().catch(console.error)
