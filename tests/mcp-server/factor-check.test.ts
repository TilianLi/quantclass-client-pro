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

const GOOD_CROSS_FACTOR = `import pandas as pd
import numpy as np
from scipy.special import erfinv
import core.market_essentials as me

fin_cols = []
ov_cols = []

def add_factor(df: pd.DataFrame, param=None, **kwargs) -> pd.DataFrame:
    col_name = kwargs["col_name"]
    section_factor = kwargs["section_factor"]
    y_col = section_factor.factor_list[0].col_name
    x_col = section_factor.factor_list[1].col_name
    df["_y"] = df.groupby("交易日期")[y_col].rank(pct=True)
    df["_x"] = df.groupby("交易日期")[x_col].rank(pct=True)
    df[col_name] = df["_y"] - df["_x"]
    return df[["交易日期", "股票代码", col_name]]
`

describe("factor-check cross_factor", () => {
	it("accepts a well-formed cross factor (core/scipy allowed)", () => {
		const r = checkFactorSource(GOOD_CROSS_FACTOR, "cross_factor")
		assert.strictEqual(r.ok, true)
		assert.deepStrictEqual(r.errors, [])
		assert.strictEqual(r.interface.kind, "cross_factor")
		assert.deepStrictEqual(r.interface.ov_cols, [])
	})

	it("rejects cross factor missing ov_cols", () => {
		const src = GOOD_CROSS_FACTOR.replace("ov_cols = []\n", "")
		const r = checkFactorSource(src, "cross_factor")
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("ov_cols")))
	})

	it("still rejects dangerous imports in cross factor", () => {
		const src = `import os\n${GOOD_CROSS_FACTOR}`
		const r = checkFactorSource(src, "cross_factor")
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("禁止的 import: os")))
	})

	it("rejects core/scipy imports for plain factor kind", () => {
		const r = checkFactorSource(GOOD_CROSS_FACTOR, "factor")
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("禁止")))
	})

	it("rejects unknown kind", () => {
		const r = checkFactorSource(GOOD_FACTOR, "signal" as never)
		assert.strictEqual(r.ok, false)
		assert.ok(r.errors.some((e) => e.includes("未知因子类型")))
	})
})
