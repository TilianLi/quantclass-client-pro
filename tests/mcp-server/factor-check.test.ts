import assert from "node:assert"
import { describe, it } from "node:test"

const { checkFactorSource } = await import(
	"../../src/mcp-server/factor-check.ts"
)

const GOOD_FACTOR = `import pandas as pd

fin_cols = []

def add_factor(df: pd.DataFrame, param=None, **kwargs) -> pd.DataFrame:
    col_name = kwargs['col_name']
    n = int(param) if param else 20
    df[col_name] = df['收盘价'].pct_change(n)
    return df[[col_name]]
`

describe("factor-check", () => {
	it("accepts a well-formed factor", () => {
		const r = checkFactorSource(GOOD_FACTOR)
		assert.strictEqual(r.ok, true)
		assert.deepStrictEqual(r.errors, [])
		assert.strictEqual(r.interface.add_factor, true)
		assert.deepStrictEqual(r.interface.fin_cols, [])
		assert.deepStrictEqual(r.interface.referenced_columns, ["收盘价"])
	})

	it("rejects non-pure imports", () => {
		const src = GOOD_FACTOR.replace(
			"import pandas as pd",
			"import os\nimport pandas as pd",
		)
		const r = checkFactorSource(src)
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("禁止的 import: os")))
	})

	it("rejects forbidden from-import", () => {
		const r = checkFactorSource(`from subprocess import run\n${GOOD_FACTOR}`)
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("禁止的 from import")))
	})

	it("rejects open/exec/eval calls", () => {
		for (const call of ["open('x')", "exec('1')", "eval('1')"]) {
			const r = checkFactorSource(`${GOOD_FACTOR}\n${call}\n`)
			assert.strictEqual(r.ok, false, `应拒绝 ${call}`)
		}
	})

	it("rejects dunder attribute access", () => {
		const r = checkFactorSource(`${GOOD_FACTOR}\nx = pd.__globals__\n`)
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("__globals__")))
	})

	it("requires add_factor function", () => {
		const r = checkFactorSource("fin_cols = []\nx = 1\n")
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("add_factor")))
	})

	it("requires module-level fin_cols", () => {
		const r = checkFactorSource(
			"def add_factor(df, param=None, **kwargs):\n    return df\n",
		)
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("fin_cols")))
	})

	it("warns on uncommon referenced columns", () => {
		const src = GOOD_FACTOR.replace("df['收盘价']", "df['自定义列X']")
		const r = checkFactorSource(src)
		assert.strictEqual(r.ok, true)
		assert.ok(r.warnings.some((w) => w.includes("自定义列X")))
	})

	it("reports syntax errors", () => {
		const r = checkFactorSource("def add_factor(:\n")
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("语法错误")))
	})
})
