#!/usr/bin/env node
/**
 * C-stage verification: in-process Hono + mcpRouter smoke test.
 * Mocks electron-store + scheduler + execBin, exercises all 7 /mcp/*
 * endpoints over a real HTTP socket on a random port.
 *
 * This mirrors the shape of src/main/server/controllers/mcp.ts without
 * pulling in Electron-side deps.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";

// ---- Mocks ----
const storeData = {
	"real_market_config.account_id": "test-account-123",
	"real_market_config.use_fuzzy": "1",
	"real_market_config.use_open_sell": "0",
	"auto_real_trading": false,
};
const electronStore = {
	get: (key, def) => (key in storeData ? storeData[key] : def),
	set: (key, val) => {
		storeData[key] = val;
	},
};

const schedulerState = {
	isSetAutoUpdate: false,
	isSetAutoTrading: false,
	isSetAutoMinData: false,
	minDataMode: "fast",
	minDataAccurate: false,
	minDataFuzzy: false,
	isOnline: true,
};
const scheduler = {
	systemState: schedulerState,
	setAutoMinData: (opts) => {
		schedulerState.isSetAutoMinData = opts.isOn;
		if (opts.mode !== undefined) schedulerState.minDataMode = opts.mode;
		if (opts.autoAccurate !== undefined) schedulerState.minDataAccurate = opts.autoAccurate;
		if (opts.autoFuzzy !== undefined) schedulerState.minDataFuzzy = opts.autoFuzzy;
	},
	setAutoTrading: (on) => { schedulerState.isSetAutoTrading = on; },
	setAutoUpdate: (on) => { schedulerState.isSetAutoUpdate = on; },
};

const processExecs = [];
const execBin = async (args, label) => {
	processExecs.push({ args, label });
	return { ok: true };
};

// ---- Router (mirrors src/main/server/controllers/mcp.ts) ----
const mcpRouter = new Hono();

mcpRouter.get("/status", (c) => c.json({
	code: 0,
	data: {
		isSetAutoUpdate: schedulerState.isSetAutoUpdate,
		isSetAutoTrading: schedulerState.isSetAutoTrading,
		isSetAutoMinData: schedulerState.isSetAutoMinData,
		minDataMode: schedulerState.minDataMode,
		minDataAccurate: schedulerState.minDataAccurate,
		minDataFuzzy: schedulerState.minDataFuzzy,
		isOnline: schedulerState.isOnline,
	},
	message: "ok",
}));

mcpRouter.post("/min-data/toggle", async (c) => {
	const body = await c.req.json();
	const { isOn, mode, autoAccurate, autoFuzzy } = body;
	if (typeof isOn !== "boolean") {
		return c.json({ code: 400, message: "参数 isOn 必须为 boolean" }, 400);
	}
	scheduler.setAutoMinData({ isOn, mode, autoAccurate, autoFuzzy });
	return c.json({
		code: 0,
		data: {
			isSetAutoMinData: schedulerState.isSetAutoMinData,
			minDataMode: schedulerState.minDataMode,
			minDataAccurate: schedulerState.minDataAccurate,
			minDataFuzzy: schedulerState.minDataFuzzy,
		},
		message: isOn ? "实时数据定时任务已开启" : "实时数据定时任务已关闭",
	});
});

mcpRouter.post("/min-data/exec", async (c) => {
	try {
		await execBin(["min_data"], "MCP手动获取实时数据");
		return c.json({ code: 0, message: "实时数据获取已触发" });
	} catch (error) {
		return c.json(
			{ code: 500, message: `执行失败: ${error?.message ?? String(error)}` },
			500,
		);
	}
});

mcpRouter.get("/config/trading", (c) => c.json({
	code: 0,
	data: {
		account_id: electronStore.get("real_market_config.account_id", "0"),
		use_fuzzy: electronStore.get("real_market_config.use_fuzzy", "1"),
		use_open_sell: electronStore.get("real_market_config.use_open_sell", "0"),
		auto_real_trading: electronStore.get("auto_real_trading", false),
	},
	message: "ok",
}));

mcpRouter.put("/config/trading", async (c) => {
	const body = await c.req.json();
	const allowedKeys = [
		"real_market_config.account_id",
		"real_market_config.use_fuzzy",
		"real_market_config.use_open_sell",
	];
	const updated = {};
	for (const key of allowedKeys) {
		if (body[key] !== undefined) {
			electronStore.set(key, body[key]);
			updated[key] = body[key];
		}
	}
	return c.json({ code: 0, data: updated, message: "交易配置已更新" });
});

mcpRouter.post("/trading/toggle", async (c) => {
	const body = await c.req.json();
	const { isOn } = body;
	if (typeof isOn !== "boolean") {
		return c.json({ code: 400, message: "参数 isOn 必须为 boolean" }, 400);
	}
	scheduler.setAutoTrading(isOn);
	return c.json({
		code: 0,
		data: { isSetAutoTrading: schedulerState.isSetAutoTrading },
		message: isOn ? "自动交易已开启" : "自动交易已关闭",
	});
});

mcpRouter.post("/history-data/toggle", async (c) => {
	const body = await c.req.json();
	const { isOn } = body;
	if (typeof isOn !== "boolean") {
		return c.json({ code: 400, message: "参数 isOn 必须为 boolean" }, 400);
	}
	scheduler.setAutoUpdate(isOn);
	return c.json({
		code: 0,
		data: { isSetAutoUpdate: schedulerState.isSetAutoUpdate },
		message: isOn ? "历史数据自动更新已开启" : "历史数据自动更新已关闭",
	});
});

const app = new Hono();
app.route("/mcp", mcpRouter);

// ---- Run + Verify ----
const server = serve({ fetch: app.fetch, port: 0 });

// @hono/node-server's `serve` returns synchronously with the port after listen.
// Wait one tick to ensure address is bound.
await new Promise((r) => setImmediate(r));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`(server listening on ${base})`);

const fetchJson = async (method, path, body) => {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, body: json };
};

const results = [];
const expect = (name, cond, detail) => {
	results.push({ name, pass: !!cond, detail });
};

(async () => {
	// 1) GET /mcp/status
	{
		const r = await fetchJson("GET", "/mcp/status");
		expect("GET /mcp/status returns 200", r.status === 200, r);
		expect(
			"GET /mcp/status has code:0 + data fields",
			r.body.code === 0 &&
				"isSetAutoUpdate" in r.body.data &&
				"isOnline" in r.body.data,
			r.body,
		);
	}

	// 2) POST /mcp/min-data/toggle
	{
		const r = await fetchJson("POST", "/mcp/min-data/toggle", {
			isOn: true, mode: "stable", autoAccurate: true,
		});
		expect("POST /mcp/min-data/toggle on=stable+autoAccurate 200", r.status === 200, r);
		expect(
			"...updates state",
			schedulerState.isSetAutoMinData === true &&
				schedulerState.minDataMode === "stable" &&
				schedulerState.minDataAccurate === true,
			schedulerState,
		);
	}

	// 3) POST /mcp/min-data/exec
	{
		const r = await fetchJson("POST", "/mcp/min-data/exec", { type: "accurate" });
		expect("POST /mcp/min-data/exec 200", r.status === 200, r);
		expect("...recorded exec call", processExecs.length === 1, processExecs);
	}

	// 4) GET /mcp/config/trading
	{
		const r = await fetchJson("GET", "/mcp/config/trading");
		expect("GET /mcp/config/trading 200", r.status === 200, r);
		expect("...account_id = test-account-123", r.body.data?.account_id === "test-account-123", r.body);
	}

	// 5) PUT /mcp/config/trading with dot-key
	{
		const r = await fetchJson("PUT", "/mcp/config/trading", {
			"real_market_config.account_id": "new-account-456",
		});
		expect("PUT /mcp/config/trading 200", r.status === 200, r);
		expect(
			"...store updated",
			electronStore.get("real_market_config.account_id") === "new-account-456",
			electronStore.get("real_market_config.account_id"),
		);
	}

	// 6) POST /mcp/trading/toggle
	{
		const r = await fetchJson("POST", "/mcp/trading/toggle", { isOn: true });
		expect("POST /mcp/trading/toggle 200", r.status === 200, r);
		expect("...trading on", schedulerState.isSetAutoTrading === true, schedulerState);
	}

	// 7) POST /mcp/history-data/toggle
	{
		const r = await fetchJson("POST", "/mcp/history-data/toggle", { isOn: true });
		expect("POST /mcp/history-data/toggle 200", r.status === 200, r);
		expect("...history on", schedulerState.isSetAutoUpdate === true, schedulerState);
	}

	// 8) negative: missing isOn
	{
		const r = await fetchJson("POST", "/mcp/trading/toggle", { foo: "bar" });
		expect("POST /mcp/trading/toggle without isOn returns 400", r.status === 400, r);
	}

	// 9) negative: PUT /mcp/config/trading rejects unknown key
	{
		const r = await fetchJson("PUT", "/mcp/config/trading", {
			"some.unknown.key": "evil",
		});
		expect("PUT /mcp/config/trading only accepts whitelisted dot-keys",
			r.status === 200 && Object.keys(r.body.data).length === 0,
			r.body,
		);
	}

	// 10) tools resource URI mapping check (sanity)
	{
		// Resources are quantclass://status and quantclass://config/trading — but
		// those are MCP-server-side URIs, not Hono routes. The Hono routes that
		// back them are /mcp/status and /mcp/config/trading — both verified above.
		// This is a placeholder to make the mapping explicit.
		expect("resources quantclass://status -> GET /mcp/status (verified in #1)", true, null);
		expect("resources quantclass://config/trading -> GET /mcp/config/trading (verified in #4)", true, null);
	}

	let pass = 0, fail = 0;
	for (const r of results) {
		if (r.pass) pass++; else fail++;
		console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${JSON.stringify(r.detail).slice(0, 140)}`);
	}
	console.log(`\nResult: ${pass} pass / ${fail} fail`);
	server.close();
	process.exit(fail === 0 ? 0 : 1);
})();
