import assert from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-catalog-"))
process.env.ALL_DATA_PATH = TMP

const { listFactorComponents } = await import(
	"../../src/mcp-server/component-catalog.ts"
)

describe("component-catalog", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("returns empty catalogs when real_trading does not exist", () => {
		const r = listFactorComponents()
		assert.deepStrictEqual(r.factor, {})
		assert.deepStrictEqual(r.crossFactor, {})
	})

	it("enumerates factor libraries by category, skipping __init__ and pycache", () => {
		const rt = join(TMP, "real_trading")
		mkdirSync(join(rt, "因子库", "动量"), { recursive: true })
		mkdirSync(join(rt, "因子库", "波动"), { recursive: true })
		mkdirSync(join(rt, "因子库", "__pycache__"), { recursive: true })
		writeFileSync(join(rt, "因子库", "动量", "动量20.py"), "x")
		writeFileSync(join(rt, "因子库", "动量", "__init__.py"), "")
		writeFileSync(join(rt, "因子库", "波动", "波动率20.py"), "x")
		mkdirSync(join(rt, "截面因子库"), { recursive: true })
		writeFileSync(join(rt, "截面因子库", "行业中性化.py"), "x")

		const r = listFactorComponents()
		assert.deepStrictEqual(r.factor, {
			动量: ["动量20"],
			波动: ["波动率20"],
		})
		assert.deepStrictEqual(r.crossFactor, { "(根目录)": ["行业中性化"] })
	})
})
