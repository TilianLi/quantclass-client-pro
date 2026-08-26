# 因子共线性/真实复杂度度量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 MCP 工具 `analyze_factor_collinearity`，对指定 run/variant 输出值级因子共线性报告（调仓日截面抽样 → 跨截面 Spearman 中位数相关矩阵 → 高相关对 / VIF / 有效复杂度 effective_complexity / 冗余因子排名）；`record_experiment` 新增 `withCollinearity` 可选参数把摘要软警告式写进 trace；`get_run_summary` 展示最近一次共线性结果。不改变现有 SOTA 排序语义，不拦截任何流程。

**Architecture:** 新增 `resources/factor_collinearity.py`（内嵌 Python 执行：子进程调 `parse_config.py` 提取 `strategy_list` → 收集时序因子引用 → 读 GBK 行情 CSV + `收盘价/前收盘价` 链式后复权 → 动态 import variant 因子模块算截面矩阵 → numpy/pandas 统计 → JSON stdout）。TS 侧新增纯函数层 `src/mcp-server/factor-collinearity.ts`（异步 `execFile`，默认超时 10 分钟，从 run 的 `brief.json` 取回测区间与板块过滤），在 `tools.ts` 注册工具并在 `record_experiment` handler 里做 withCollinearity 编排（`research-run.ts` 提供 `attachCollinearity` 补写 trace 最后一行，避免 research-run ↔ factor-collinearity 循环 import）。

**Tech Stack:** TypeScript ESM（src/mcp-server 内部 import 带 `.ts` 后缀，tools.ts 对外 import 带 `.js` 后缀）、zod、node:test（`--experimental-strip-types`）、Biome（tab 缩进、行宽 80、双引号、分号 asNeeded）；Python 3.11 内嵌（`resources/python/<arch>`）+ pandas/numpy（**需先安装，见 Task 0**）、stdlib unittest（项目无 pytest 先例，不引入新依赖）。

**关键背景（执行者必读）：**

- spec：`docs/superpowers/specs/2026-07-31-factor-collinearity-design.md`。本计划覆盖其全部章节；文末有逐节覆盖自查表。
- **重要事实修正**：spec/前置调研假设「内嵌 Python 有 pandas/numpy」，实测当前 `resources/python/x64/python.exe` **没有**（只有 pip/setuptools；`scripts/download-python.cjs` 只下载 python-build-standalone 并裁剪）。自定义因子模块本身 `import pandas as pd`，无处绕行，因此 **Task 0 必须先给内嵌 Python 装 pandas/numpy 并把安装固化进 `scripts/download-python.cjs`**（否则打包发布后功能必坏）。这是相对 spec §8 文件清单的唯一新增改动文件。
- Python 脚本调用模式参照 `src/mcp-server/factor-check.ts`：`resolvePythonCmd()` / `resourceScript()` 来自 `./paths.ts`，临时目录传参、stdout JSON。本功能用**异步** `promisify(execFile)`（超时默认 10 分钟，maxBuffer 64MB），不用 factor-check 的 10s sync 模式。
- `resources/parse_config.py` 接口：`python parse_config.py <config_path> <var1> [var2...]`，AST 提取顶层变量，stdout UTF-8 JSON。Python 脚本内用 `sys.executable` 子进程调它提取 `strategy_list`、`backtest_name`。
- config.py 结构：`strategy_list = [{"name", "factor_list", "filter_list", "filter_list_post", "cross_sections", "hold_period": "3D", "offset_list": [0], "rebalance_time": "close", "select_num"}]`。`factor_list` 条目 = `[因子名, 排序方向bool, 参数, 权重]`（param 在 index 2）；`filter_list`/`filter_list_post` 条目 = `[因子名, 参数, "pct:<=0.8", 排序方向?]`（param 在 index 1）；`cross_sections` 条目 = `{"name": <截面因子名>, "factor_list": [[因子名, 方向, 参数, 权重], ...], "method"?: ...}`——截面产出因子 v1 跳过（列入 `skipped_cross_factors`），其 `factor_list` 输入时序因子纳入分析。
- 因子名定位：`类目.名` → `因子库/类目/名.py`；裸名 → `因子库/名.py`；都找不到且不在内置映射表 → `unresolved_factors`（内置因子不可枚举：收盘价、换手率、流通市值、近期停牌天数、异常涨跌停状态等）。
- 时序因子接口：`fin_cols = []` + `def add_factor(df, param=None, **kwargs)`，`col_name` 从 `kwargs['col_name']` 取，返回 `df[[col_name]]`。样例：`workspace/agent-strategies/run-momentum-001/v10/因子库/规模/成交额Mean.py`。
- 行情数据：`{ALL_DATA_PATH}/stock-trading-data-pro/`（fallback `stock-trading-data/`），每股一个 CSV（如 `sh600000.csv`，**GBK 编码**），第一行广告行跳过，第二行表头：`股票代码,股票名称,交易日期,开盘价,最高价,最低价,收盘价,前收盘价,成交量,成交额,流通市值,市值,换手率TTM,...`。ALL_DATA_PATH 默认 `D:/QuantClassSpace/QuantData`（`src/mcp-server/strategy-validator.ts:308` 同款写法）。
- `src/mcp-server/research-run.ts`：`recordExperiment`（:394）；complexity 自动统计块（:410-423）；`countConfigKnobs`（:328）；`getResearchBrief(runId)` 已导出（:514）；`getRunSummary`（:548）；`metricsSchema`（:43-51）；`experimentEntrySchema`（:121-180）。
- 工具注册：`src/mcp-server/tools.ts` 的 `registerTools(server)`，`server.tool(name, description, zodRawShape, async handler)`；成功 `{content:[{type:"text", text: JSON.stringify(result, null, 2)}]}`，失败加 `isError: true`。`record_experiment` 在 tools.ts:1592-1648；`get_run_summary` 在 :1682-1706。tools.ts import 风格：`from "./research-run.js"`（`.js` 后缀，esbuild 解析）。
- 测试：TS 单测 `node --test --experimental-strip-types tests/mcp-server/<file>.test.ts`（全量 `npm run test:mcp`）；e2e `tests/mcp-server/tools.test.ts` 依赖先 `pnpm build:mcp`。纯函数单测风格见 `tests/mcp-server/research-run.test.ts`（env 必须在 import 被测模块**之前**设置 + 动态 import）。Python 测试用 stdlib unittest，放 `tests/python/`，命令 `resources/python/x64/python.exe -m unittest discover -s tests/python -v`（fixture 全部由测试代码在 tmp 目录动态生成，GBK 编码写 CSV，不进仓库）。
- 策略工作区根：env `QUANTCLASS_AGENT_WORKSPACE`，默认 `workspace/agent-strategies`；路径校验用 `strategy-files.ts` 的 `assertSafePathComponent` / `assertInsideWorkspace`。
- 类型检查：`npx tsc --noEmit -p tsconfig.mcp.json`（src/mcp-server 专属 tsconfig，已验证当前通过）。代码风格检查：`npx biome check <files>`。
- commit 风格（git log）：conventional commits + 中文描述，如 `feat(mcp): 修复 RDAgent 端到端验证暴露的工具链问题`、`docs: 因子共线性/真实复杂度度量改造设计文档（方案A）`。
- 新 TS 文件必须带 BUSL-1.1 版权头（见 `src/mcp-server/factor-check.ts:1-9`）。

**spec §5 错误处理表 → 实现位置映射：**

| spec 场景 | 实现位置 |
|-----------|----------|
| variant/config.py 不存在 | TS `analyzeFactorCollinearity` 前置 `existsSync` 检查返回 `ok:false`；Python `run_analysis` 双重检查 |
| 行情数据目录不存在 | Python `_pool_dir` 抛 `RuntimeError`（提示检查 ALL_DATA_PATH / 历史数据更新）→ `ok:false` |
| 内置因子无法映射 | 不失败；进 `unresolved_factors` |
| 因子模块 import/计算异常 | import 失败 → `status:"error"`；全部股票计算失败 → 报告生成后回标 `status:"error"`；单股票失败记 NaN，报告继续 |
| Python 超时（默认 10min） | TS `mapCollinearityError` → `{ok:false, error:"timeout"}`；record_experiment 场景 handler 捕获降级为 `collinearityWarning` |
| 全部因子均失败/无可分析因子 | Python 抛 `RuntimeError` → `ok:false` |

---

### Task 0: 内嵌 Python 安装 pandas/numpy + 固化进构建脚本

**Files:**
- Modify: `scripts/download-python.cjs`（skip 分支 :81-89，完成分支 :118-119，文件顶部常量区 :9-14 之后插入函数）

实测 `resources/python/x64/python.exe -c "import pandas"` → ModuleNotFoundError。因子模块运行时必须 pandas，无替代方案。

- [ ] **Step 1: 开发机手动安装并验证**

```bash
./resources/python/x64/python.exe -m pip install --no-input "pandas>=2.2,<3" "numpy>=2,<3"
./resources/python/x64/python.exe -c "import pandas, numpy; print(pandas.__version__, numpy.__version__)"
```

预期打印版本号（如 `2.3.x 2.x.x`）。注意 `resources/python/` 已 gitignore（.gitignore:101），安装产物不进仓库。

- [ ] **Step 2: 固化进 download-python.cjs**

在 `scripts/download-python.cjs` 的常量区（`const PY_VERSION = ...` 之后、`const GITHUB_PREFIX` 之前）插入：

```js
/** 因子共线性分析脚本（resources/factor_collinearity.py）的运行时依赖 */
const SCI_PACKAGES = ["pandas>=2.2,<3", "numpy>=2,<3"]

function pythonExe(targetDir) {
	return process.platform === "win32"
		? path.join(targetDir, "python.exe")
		: path.join(targetDir, "bin", "python3")
}

/** pandas/numpy 缺失时 pip 安装（幂等：已可 import 则跳过） */
function ensureSciPackages(targetDir) {
	const py = pythonExe(targetDir)
	try {
		execSync(`"${py}" -c "import pandas, numpy"`, { stdio: "ignore" })
		console.log("[download-python] pandas/numpy 已就绪，跳过安装")
		return
	} catch {}
	console.log("[download-python] 安装 pandas/numpy（因子共线性分析依赖）...")
	try {
		execSync(
			`"${py}" -m pip install --no-input ${SCI_PACKAGES.map((p) => `"${p}"`).join(" ")}`,
			{ stdio: "inherit" },
		)
	} catch {
		console.error("[download-python] pandas/numpy 安装失败")
		process.exit(1)
	}
}
```

修改 skip 分支（old_string）：

```js
		console.log(
			`[download-python] ${arch}: 已存在 (${PY_VERSION}+${TAG})，跳过`,
		)
		return
```

new_string：

```js
		console.log(
			`[download-python] ${arch}: 已存在 (${PY_VERSION}+${TAG})，跳过下载`,
		)
		ensureSciPackages(targetDir)
		return
```

修改完成分支（old_string）：

```js
	fs.writeFileSync(markerFile, `${PY_VERSION}+${TAG}\n`)
	console.log(`[download-python] ${arch}: 完成`)
```

new_string：

```js
	fs.writeFileSync(markerFile, `${PY_VERSION}+${TAG}\n`)
	ensureSciPackages(targetDir)
	console.log(`[download-python] ${arch}: 完成`)
```

- [ ] **Step 3: 验证幂等路径**

```bash
node scripts/download-python.cjs
```

预期输出含 `已存在 (...)，跳过下载` 与 `pandas/numpy 已就绪，跳过安装`（Step 1 已装）。

- [ ] **Step 4: commit**

```bash
git add scripts/download-python.cjs
git commit -m "build(mcp): 内嵌 Python 增加 pandas/numpy 依赖（共线性分析运行时）"
```

---

### Task 1: factor_collinearity.py 骨架 — params/config 解析/因子引用收集/调仓日序列

**Files:**
- Create: `resources/factor_collinearity.py`
- Test: `tests/python/test_factor_collinearity.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/python/test_factor_collinearity.py`，完整内容：

```python
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

RESOURCES_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "resources")
)
sys.path.insert(0, RESOURCES_DIR)

import factor_collinearity as fc

CSV_HEADER = (
    "股票代码,股票名称,交易日期,开盘价,最高价,最低价,收盘价,前收盘价,"
    "成交量,成交额,流通市值,市值,换手率TTM"
)

MOM_FACTOR = '''import pandas as pd

fin_cols = []


def add_factor(df, param=None, **kwargs):
    col_name = kwargs["col_name"]
    n = int(param) if param else 10
    df[col_name] = df["收盘价"].pct_change(n)
    return df[[col_name]]
'''

MOM2_FACTOR = '''import pandas as pd

fin_cols = []


def add_factor(df, param=None, **kwargs):
    col_name = kwargs["col_name"]
    n = int(param) if param else 10
    df[col_name] = df["收盘价"].pct_change(n) * 2.0
    return df[[col_name]]
'''

BAD_FACTOR = '''import pandas as pd

fin_cols = []


def add_factor(df, param=None, **kwargs):
    raise RuntimeError("boom")
'''

CONFIG_TEXT = '''backtest_name = "toy"

strategy_list = [
    {
        "name": "toy",
        "factor_list": [
            ["动量.动量N", True, 10, 1.0],
            ["动量.动量N2", True, 10, 1.0],
        ],
        "filter_list": [["异常涨跌停状态", None, "bool:==0", None]],
        "filter_list_post": [],
        "cross_sections": [
            {
                "name": "截面排名差",
                "factor_list": [["流通市值", True, None, 1]],
                "is_sort_asc": True,
                "params": None,
                "args": 1,
            }
        ],
        "hold_period": "2D",
        "offset_list": [0],
        "rebalance_time": "close",
        "select_num": 3,
    }
]
'''

CONFIG_ALL_UNRESOLVED = '''backtest_name = "toy-bad"

strategy_list = [
    {
        "name": "toy-bad",
        "factor_list": [["异常涨跌停状态", True, None, 1]],
        "filter_list": [],
        "filter_list_post": [],
        "cross_sections": [],
        "hold_period": "2D",
        "offset_list": [0],
        "rebalance_time": "close",
        "select_num": 3,
    }
]
'''


def make_prices(seed, n):
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0005, 0.02, n)
    closes = 10.0 * np.cumprod(1.0 + rets)
    prevs = np.concatenate([[10.0], closes[:-1]])
    return closes, prevs


def make_stock_csv(path, code, dates, closes, prevs, share_mult=1.0):
    """按真实行情格式写 GBK CSV：第一行广告行，第二行表头。"""
    lines = ["广告行：本数据仅供测试", CSV_HEADER]
    for d, c, p in zip(dates, closes, prevs):
        lines.append(
            f"{code},测试股,{d},{c * 0.99:.2f},{c * 1.01:.2f},{c * 0.98:.2f},"
            f"{c:.4f},{p:.4f},1000000,{c * 1e6:.0f},"
            f"{c * 1e8 * share_mult:.0f},{c * 2e8 * share_mult:.0f},1.5"
        )
    with open(path, "w", encoding="gbk", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


class FixtureTestCase(unittest.TestCase):
    """全套玩具 fixture：config + 因子库 + 4 只股票 GBK 行情（tmp 目录动态生成）。"""

    N_DAYS = 60
    START = "2024-01-02"
    END = "2024-03-25"  # bdate_range(START, 60) 的最后一天

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qc-coll-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

        # variant：config.py + 因子库/动量/*.py
        self.variant_dir = os.path.join(self.tmp, "workspace", "run-t", "v1")
        self.factor_dir = os.path.join(self.variant_dir, "因子库")
        mom_dir = os.path.join(self.factor_dir, "动量")
        os.makedirs(mom_dir)
        self.config_path = os.path.join(self.variant_dir, "config.py")
        with open(self.config_path, "w", encoding="utf-8") as f:
            f.write(CONFIG_TEXT)
        self.bad_config_path = os.path.join(self.variant_dir, "config_bad.py")
        with open(self.bad_config_path, "w", encoding="utf-8") as f:
            f.write(CONFIG_ALL_UNRESOLVED)
        for name, src in (
            ("动量N", MOM_FACTOR),
            ("动量N2", MOM2_FACTOR),
            ("坏因子", BAD_FACTOR),
        ):
            with open(os.path.join(mom_dir, name + ".py"), "w", encoding="utf-8") as f:
                f.write(src)
        for d in (self.factor_dir, mom_dir):
            with open(os.path.join(d, "__init__.py"), "w", encoding="utf-8") as f:
                f.write("")

        # 行情：stock-trading-data-pro 下 4 只股票（覆盖沪深京+科创/创业前缀）
        self.data_dir = os.path.join(self.tmp, "QuantData")
        pool = os.path.join(self.data_dir, "stock-trading-data-pro")
        os.makedirs(pool)
        dates = [
            d.strftime("%Y-%m-%d")
            for d in pd.bdate_range(self.START, periods=self.N_DAYS)
        ]
        self.pool_dir = pool
        self.dates = dates
        for i, (code, mult) in enumerate(
            [
                ("sh600000", 1.0),
                ("sh680001", 2.0),
                ("sz300001", 3.0),
                ("bj430001", 4.0),
            ]
        ):
            closes, prevs = make_prices(seed=42 + i, n=self.N_DAYS)
            make_stock_csv(
                os.path.join(pool, code + ".csv"), code, dates, closes, prevs, mult
            )

    def make_params(self, **over):
        params = {
            "config_path": self.config_path,
            "factor_dirs": [self.factor_dir],
            "data_dir": self.data_dir,
            "start_date": self.START,
            "end_date": self.END,
            "filters": {"kcb": "0", "cyb": "0", "bj": "0"},
            "max_sections": 8,
            "corr_threshold": 0.8,
            "min_stocks": 2,
        }
        params.update(over)
        return params


class TestConfigParsing(FixtureTestCase):
    def test_parse_config_vars(self):
        extracted = fc.parse_config_vars(
            self.config_path, ["strategy_list", "backtest_name"]
        )
        self.assertEqual(extracted["backtest_name"], "toy")
        self.assertEqual(len(extracted["strategy_list"]), 1)
        self.assertEqual(
            extracted["strategy_list"][0]["factor_list"][0],
            ["动量.动量N", True, 10, 1.0],
        )

    def test_collect_factor_refs(self):
        extracted = fc.parse_config_vars(
            self.config_path, ["strategy_list", "backtest_name"]
        )
        refs, cross_names = fc.collect_factor_refs(extracted["strategy_list"])
        got = {(r["name"], r["param"]) for r in refs}
        self.assertIn(("动量.动量N", 10), got)  # factor_list: param 在 index 2
        self.assertIn(("动量.动量N2", 10), got)
        self.assertIn(("异常涨跌停状态", None), got)  # filter_list: param 在 index 1
        self.assertIn(("流通市值", None), got)  # cross_sections 输入时序因子
        self.assertEqual(cross_names, ["截面排名差"])

    def test_collect_factor_refs_dedup(self):
        stg = [
            {
                "factor_list": [["动量.动量N", True, 10, 1.0]],
                "filter_list": [["动量.动量N", 10, "pct:<=0.8"]],
                "cross_sections": [],
            }
        ]
        refs, _ = fc.collect_factor_refs(stg)
        self.assertEqual(len(refs), 1)

    def test_hold_period_days(self):
        self.assertEqual(fc.hold_period_days("3D"), 3)
        self.assertEqual(fc.hold_period_days("2W"), 10)
        self.assertEqual(fc.hold_period_days("bad"), 5)
        self.assertEqual(fc.hold_period_days(None), 5)

    def test_compute_rebalance_dates(self):
        cal = pd.bdate_range(self.START, periods=self.N_DAYS)
        stgs = [{"hold_period": "5D", "offset_list": [0]}]
        dates = fc.compute_rebalance_dates(stgs, cal, self.START, self.END, 60)
        self.assertEqual(dates, list(cal[::5]))
        # offset 并集
        union = fc.compute_rebalance_dates(
            [{"hold_period": "10D", "offset_list": [0, 5]}],
            cal,
            self.START,
            self.END,
            60,
        )
        self.assertEqual(union, sorted(set(list(cal[::10]) + list(cal[5::10]))))
        # max_sections 等距抽样：保留首尾
        sampled = fc.compute_rebalance_dates(
            [{"hold_period": "1D", "offset_list": [0]}],
            cal,
            self.START,
            self.END,
            4,
        )
        self.assertEqual(len(sampled), 4)
        self.assertEqual(sampled[0], cal[0])
        self.assertEqual(sampled[-1], cal[-1])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期：import factor_collinearity 失败（ModuleNotFoundError），全红。

- [ ] **Step 3: 最小实现 — 创建 resources/factor_collinearity.py**

```python
"""
因子共线性 / 真实复杂度度量（研究用近似口径）。

用法: python factor_collinearity.py <params_json_path>
params JSON 字段:
  config_path     variant 的 config.py 绝对路径
  factor_dirs     自定义时序因子库目录列表（通常为 <variant>/因子库）
  data_dir        QuantData 根目录（其下含 stock-trading-data-pro/）
  start_date      回测开始日期 YYYY-MM-DD
  end_date        回测结束日期 YYYY-MM-DD 或 null（= 今天）
  filters         {"kcb": "0/1", "cyb": "0/1", "bj": "0/1"}，1=过滤该板块
  max_sections    调仓日截面抽样上限（默认 60）
  corr_threshold  高相关对阈值 |ρ|（默认 0.8）
  min_stocks      截面最少股票数（默认 30，测试可调小）
结果 JSON 写 stdout（UTF-8）；业务错误也输出 {"ok": false, "error": ...}。
"""

import importlib.util
import json
import os
import subprocess
import sys
import time
import warnings

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARSE_CONFIG_SCRIPT = os.path.join(SCRIPT_DIR, "parse_config.py")

CAVEAT = "研究用近似口径：复权/停牌处理与闭源内核不保证逐位一致，数值用于相对比较"


def _deps_error(exc):
    return {
        "ok": False,
        "error": (
            f"内嵌 Python 缺少依赖: {exc}。请执行 "
            "resources/python/<arch>/python.exe -m pip install pandas numpy"
            "（或重跑 scripts/download-python.cjs）"
        ),
        "caveat": CAVEAT,
    }


try:
    import numpy as np
    import pandas as pd
except ImportError as _exc:  # pragma: no cover - 环境缺依赖时的兜底提示
    sys.stdout.buffer.write(
        json.dumps(_deps_error(_exc), ensure_ascii=False).encode("utf-8")
    )
    sys.exit(1)

# 内置因子映射表：name -> (mode, csv 列名)
# mode=price: 价量列，需后复权还原；mode=raw: 直接取列。
# 未覆盖的内置因子（近期停牌天数、异常涨跌停状态等，官方称不可枚举）
# 进 unresolved_factors，映射表随使用逐步补全。
BUILTIN_FACTOR_MAP = {
    "收盘价": ("price", "收盘价"),
    "开盘价": ("price", "开盘价"),
    "最高价": ("price", "最高价"),
    "最低价": ("price", "最低价"),
    "成交额": ("raw", "成交额"),
    "成交量": ("raw", "成交量"),
    "流通市值": ("raw", "流通市值"),
    "市值": ("raw", "市值"),
    "换手率": ("raw", "换手率TTM"),
}


def emit(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def analyze_or_error(params):
    """run_analysis 的业务异常统一转为 ok:false JSON（由 main 输出）。"""
    try:
        return run_analysis(params)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "caveat": CAVEAT}


def parse_config_vars(config_path, var_names):
    """子进程调 parse_config.py（AST 提取 config.py 顶层变量），返回 dict。"""
    proc = subprocess.run(
        [sys.executable, PARSE_CONFIG_SCRIPT, config_path, *var_names],
        capture_output=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "parse_config.py 调用失败: "
            + proc.stderr.decode("utf-8", "replace")[:500]
        )
    data = json.loads(proc.stdout.decode("utf-8"))
    if "__error__" in data:
        raise RuntimeError(str(data["__error__"]))
    return data


def _ref_key(name, param):
    return f"{name}|{json.dumps(param, ensure_ascii=False)}"


def ref_label(ref):
    """因子在报告中的展示名：带参数时 '名称(参数)'，区分同因子不同参数。"""
    return ref["name"] if ref["param"] in (None, "") else f"{ref['name']}({ref['param']})"


def _add_ref(refs, name, param):
    if not isinstance(name, str) or not name:
        return
    refs.setdefault(_ref_key(name, param), {"name": name, "param": param})


def collect_factor_refs(strategy_list):
    """
    从 strategy_list 收集时序因子引用（按 name+param 去重）与截面产出因子名。
    factor_list 条目: [name, asc, param, weight]；filter 条目: [name, param, cond, asc?]；
    cross_sections 条目: {"name": 截面因子名, "factor_list": [factor_list 条目, ...]}。
    返回 (refs: list[dict(name, param)], cross_factor_names: list[str])。
    """
    refs = {}
    cross_names = []
    for stg in strategy_list or []:
        if not isinstance(stg, dict):
            continue
        for key in ("factor_list", "filter_list", "filter_list_post"):
            for item in stg.get(key) or []:
                if not isinstance(item, list) or not item:
                    continue
                param = item[2] if key == "factor_list" else (
                    item[1] if len(item) > 1 else None
                )
                _add_ref(refs, item[0], param)
        for cs in stg.get("cross_sections") or []:
            if not isinstance(cs, dict):
                continue
            cname = cs.get("name")
            if isinstance(cname, str) and cname and cname not in cross_names:
                cross_names.append(cname)
            for item in cs.get("factor_list") or []:
                if not isinstance(item, list) or not item:
                    continue
                param = item[2] if len(item) > 2 else None
                _add_ref(refs, item[0], param)
    return list(refs.values()), cross_names


def hold_period_days(hold_period):
    """'3D'->3（交易日步进），'2W'->10（按 5 交易日/周折算），无法解析->5。"""
    if not isinstance(hold_period, str):
        return 5
    s = hold_period.strip().upper()
    try:
        if s.endswith("D"):
            return max(1, int(s[:-1]))
        if s.endswith("W"):
            return max(1, int(s[:-1])) * 5
    except ValueError:
        pass
    return 5


def compute_rebalance_dates(strategy_list, trade_dates, start_date, end_date, max_sections):
    """
    各 strategy 按 hold_period（交易日步进）+ offset_list 生成调仓日，取并集；
    总数超 max_sections 时等距抽样（保留首尾）。
    trade_dates: 已排序的 DatetimeIndex（全市场交易日历）。
    """
    start_ts = pd.Timestamp(start_date)
    end_ts = pd.Timestamp(end_date)
    window = trade_dates[(trade_dates >= start_ts) & (trade_dates <= end_ts)]
    if len(window) == 0:
        return []
    picked = set()
    for stg in strategy_list or []:
        if not isinstance(stg, dict):
            continue
        step = hold_period_days(stg.get("hold_period"))
        offsets = stg.get("offset_list") or [0]
        for off in offsets:
            try:
                off = int(off)
            except (TypeError, ValueError):
                off = 0
            idx = off % step
            while idx < len(window):
                picked.add(window[idx])
                idx += step
    dates = sorted(picked)
    if max_sections and len(dates) > max_sections:
        sel = np.linspace(0, len(dates) - 1, max_sections).round().astype(int)
        dates = [dates[i] for i in sorted(set(sel))]
    return dates
```

- [ ] **Step 4: 跑测试确认通过**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期 `TestConfigParsing` 5 个测试全过（`analyze_or_error` 引用的 `run_analysis` 尚不存在，但只在调用时才解析名字，import 不受影响）。

- [ ] **Step 5: commit**

```bash
git add resources/factor_collinearity.py tests/python/test_factor_collinearity.py
git commit -m "feat(mcp): 因子共线性脚本骨架与 config 因子引用收集"
```

---

### Task 2: 行情 CSV 读取 + 后复权还原 + 内置因子映射 + 股票池过滤

**Files:**
- Modify: `resources/factor_collinearity.py`（在 `compute_rebalance_dates` 之后追加）
- Test: `tests/python/test_factor_collinearity.py`（在 `if __name__ == "__main__":` 之前插入新 TestCase）

- [ ] **Step 1: 写失败测试**

在 `tests/python/test_factor_collinearity.py` 的 `if __name__ == "__main__":` 之前插入：

```python
class TestMarketData(FixtureTestCase):
    def test_load_stock_csv_gbk(self):
        df = fc.load_stock_csv(os.path.join(self.pool_dir, "sh600000.csv"))
        self.assertEqual(len(df), self.N_DAYS)
        self.assertEqual(df.index.name, "交易日期")
        self.assertIn("换手率TTM", df.columns)
        self.assertEqual(df.index[0], pd.Timestamp(self.START))
        self.assertEqual(df.index[-1], pd.Timestamp(self.END))

    def test_hfq_restore_ex_dividend(self):
        # 除权日：前收盘价为除权参考价（5.5），收盘价 5.5 → 真实收益 0
        df = pd.DataFrame(
            {"收盘价": [10.0, 11.0, 5.5], "前收盘价": [10.0, 10.0, 5.5]},
            index=pd.bdate_range("2024-01-02", periods=3),
        )
        hfq_close, ratio = fc.hfq_restore(df)
        np.testing.assert_allclose(hfq_close.to_numpy(), [10.0, 11.0, 11.0], atol=1e-9)
        np.testing.assert_allclose(ratio.to_numpy(), [1.0, 1.0, 2.0], atol=1e-9)

    def test_pool_dir_fallback(self):
        # 只有 stock-trading-data（无 -pro）时回退
        legacy = os.path.join(self.tmp, "LegacyData")
        os.makedirs(os.path.join(legacy, "stock-trading-data"))
        self.assertEqual(
            fc._pool_dir(legacy), os.path.join(legacy, "stock-trading-data")
        )
        self.assertEqual(
            fc._pool_dir(self.data_dir),
            os.path.join(self.data_dir, "stock-trading-data-pro"),
        )
        with self.assertRaises(RuntimeError) as ctx:
            fc._pool_dir(os.path.join(self.tmp, "nonexistent"))
        self.assertIn("ALL_DATA_PATH", str(ctx.exception))

    def test_list_stock_pool_filters(self):
        _, all_codes = fc.list_stock_pool(
            self.data_dir, {"kcb": "0", "cyb": "0", "bj": "0"}
        )
        self.assertEqual(
            all_codes, ["bj430001", "sh600000", "sh680001", "sz300001"]
        )
        _, filtered = fc.list_stock_pool(
            self.data_dir, {"kcb": "1", "cyb": "1", "bj": "1"}
        )
        self.assertEqual(filtered, ["sh600000"])

    def test_load_trade_calendar(self):
        cal = fc.load_trade_calendar(self.data_dir)
        self.assertEqual(len(cal), self.N_DAYS)
        self.assertEqual(cal[0], pd.Timestamp(self.START))
```

- [ ] **Step 2: 跑测试确认失败**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期 `TestMarketData` 全红（`load_stock_csv` 等 AttributeError）。

- [ ] **Step 3: 最小实现**

在 `resources/factor_collinearity.py` 的 `compute_rebalance_dates` 函数之后追加：

```python
def _pool_dir(data_dir):
    """行情目录：优先 stock-trading-data-pro，fallback stock-trading-data。"""
    for sub in ("stock-trading-data-pro", "stock-trading-data"):
        d = os.path.join(data_dir, sub)
        if os.path.isdir(d):
            return d
    raise RuntimeError(
        "行情数据目录不存在: "
        + os.path.join(data_dir, "stock-trading-data-pro")
        + "（请检查 ALL_DATA_PATH 或先执行历史数据更新）"
    )


def list_stock_pool(data_dir, filters):
    """全市场股票代码列表，按板块前缀过滤（filters 值为 "1" 时剔除该板块）。"""
    pool_dir = _pool_dir(data_dir)
    codes = []
    for fn in sorted(os.listdir(pool_dir)):
        if not fn.endswith(".csv"):
            continue
        code = fn[: -len(".csv")]
        if filters.get("kcb") == "1" and code.startswith("sh68"):
            continue
        if filters.get("cyb") == "1" and code.startswith("sz30"):
            continue
        if filters.get("bj") == "1" and code.startswith("bj"):
            continue
        codes.append(code)
    return pool_dir, codes


def load_stock_csv(path):
    """行情 CSV：GBK 编码，第一行为广告行（跳过），第二行为表头；按交易日期索引。"""
    df = pd.read_csv(path, encoding="gbk", skiprows=1, low_memory=False)
    df["交易日期"] = pd.to_datetime(df["交易日期"], errors="coerce")
    df = df.dropna(subset=["交易日期"])
    df = df.sort_values("交易日期").set_index("交易日期")
    return df[~df.index.duplicated(keep="last")]


def load_trade_calendar(data_dir):
    """用浦发银行（或目录内首只）股票的交易日作为全市场交易日历。"""
    pool_dir = _pool_dir(data_dir)
    ref = os.path.join(pool_dir, "sh600000.csv")
    if not os.path.isfile(ref):
        csvs = [f for f in sorted(os.listdir(pool_dir)) if f.endswith(".csv")]
        if not csvs:
            raise RuntimeError(f"行情目录为空: {pool_dir}")
        ref = os.path.join(pool_dir, csvs[0])
    return load_stock_csv(ref).index


def hfq_restore(df):
    """
    后复权还原：前收盘价为除权参考价，收盘价/前收盘价 = 真实日收益，
    链式累乘得复权因子，锚定首日复权价 = 首日收盘价（标准后复权口径）。
    返回 (hfq_close, ratio)；ratio = hfq_close/收盘价，用于同步还原 开/高/低。
    """
    close = pd.to_numeric(df["收盘价"], errors="coerce")
    prev = pd.to_numeric(df["前收盘价"], errors="coerce")
    ret = close / prev
    ret = ret.where(np.isfinite(ret) & (ret > 0), 1.0)
    adj = ret.cumprod()
    valid = close.dropna()
    if valid.empty:
        return close, pd.Series(1.0, index=df.index)
    hfq_close = valid.iloc[0] * adj / adj.iloc[0]
    ratio = hfq_close / close
    return hfq_close, ratio
```

- [ ] **Step 4: 跑测试确认通过**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期 `TestMarketData` 5 个测试全过。

- [ ] **Step 5: commit**

```bash
git add resources/factor_collinearity.py tests/python/test_factor_collinearity.py
git commit -m "feat(mcp): 共线性脚本行情读取、后复权还原与股票池过滤"
```

---

### Task 3: 因子模块动态加载与截面矩阵计算

**Files:**
- Modify: `resources/factor_collinearity.py`（在 `hfq_restore` 之后追加）
- Test: `tests/python/test_factor_collinearity.py`（在 `if __name__ == "__main__":` 之前插入新 TestCase）

- [ ] **Step 1: 写失败测试**

在 `tests/python/test_factor_collinearity.py` 的 `if __name__ == "__main__":` 之前插入：

```python
class TestFactorCompute(FixtureTestCase):
    def _load_df(self, code="sh600000"):
        return fc.load_stock_csv(os.path.join(self.pool_dir, code + ".csv"))

    def test_load_custom_factor_module(self):
        module, path = fc.load_custom_factor_module([self.factor_dir], "动量.动量N")
        self.assertTrue(path.endswith(os.path.join("动量", "动量N.py")))
        self.assertTrue(hasattr(module, "add_factor"))
        # 裸名 → 因子库/名.py
        bare_dir = os.path.join(self.tmp, "bare-lib")
        os.makedirs(bare_dir)
        with open(os.path.join(bare_dir, "动量N.py"), "w", encoding="utf-8") as f:
            f.write(MOM_FACTOR)
        module2, _ = fc.load_custom_factor_module([bare_dir], "动量N")
        self.assertTrue(hasattr(module2, "add_factor"))
        # 找不到 → (None, 候选路径)
        module3, candidates = fc.load_custom_factor_module(
            [self.factor_dir], "不存在因子"
        )
        self.assertIsNone(module3)
        self.assertEqual(len(candidates), 1)

    def test_compute_stock_factor_frame(self):
        df = self._load_df()
        mom_mod, _ = fc.load_custom_factor_module([self.factor_dir], "动量.动量N")
        bad_mod, _ = fc.load_custom_factor_module([self.factor_dir], "动量.坏因子")
        specs = [
            {
                "label": "收盘价",
                "name": "收盘价",
                "param": None,
                "kind": "builtin",
                "builtin": fc.BUILTIN_FACTOR_MAP["收盘价"],
            },
            {
                "label": "动量.动量N(10)",
                "name": "动量.动量N",
                "param": 10,
                "kind": "custom",
                "module": mom_mod,
            },
            {
                "label": "动量.坏因子",
                "name": "动量.坏因子",
                "param": None,
                "kind": "custom",
                "module": bad_mod,
            },
        ]
        frame, errors = fc.compute_stock_factor_frame(df, specs)
        self.assertIn("收盘价", frame.columns)
        self.assertIn("动量.动量N(10)", frame.columns)
        # 坏因子不进矩阵，错误被记录（单因子不拖垮整体）
        self.assertNotIn("动量.坏因子", frame.columns)
        self.assertIn("动量.坏因子", errors)
        # builtin 收盘价 = 后复权收盘价
        hfq_close, _ = fc.hfq_restore(df)
        pd.testing.assert_series_equal(frame["收盘价"], hfq_close, check_names=False)
        # 自定义因子收到的是后复权数据：与 hfq 收盘价 pct_change(10) 一致
        expected = hfq_close.pct_change(10)
        pd.testing.assert_series_equal(
            frame["动量.动量N(10)"], expected, check_names=False
        )

    def test_compute_stock_factor_frame_uses_hfq(self):
        # 构造含除权日的数据：自定义因子应基于后复权价，不出现 -50% 假跌幅
        dates = pd.bdate_range("2024-01-02", periods=15)
        closes = [10.0] * 7 + [5.0] * 8
        prevs = [10.0] * 7 + [5.0] + [5.0] * 7  # 第 8 天除权（参考价同步 5.0）
        df = pd.DataFrame(
            {"收盘价": closes, "前收盘价": prevs, "成交额": [1e6] * 15},
            index=dates,
        )
        mom_mod, _ = fc.load_custom_factor_module([self.factor_dir], "动量.动量N")
        specs = [
            {
                "label": "m",
                "name": "动量.动量N",
                "param": 5,
                "kind": "custom",
                "module": mom_mod,
            }
        ]
        frame, errors = fc.compute_stock_factor_frame(df, specs)
        self.assertEqual(errors, {})
        # 后复权价全程不变 → 动量恒为 0；若误用原始价，除权日会出现 -0.5
        np.testing.assert_allclose(frame["m"].dropna().to_numpy(), 0.0, atol=1e-9)

    def test_align_and_build_sections(self):
        # 用内置收盘价因子（全程非 NaN），避免 rolling 预热期干扰截面计数断言
        df = self._load_df()
        specs = [
            {
                "label": "收盘价",
                "name": "收盘价",
                "param": None,
                "kind": "builtin",
                "builtin": fc.BUILTIN_FACTOR_MAP["收盘价"],
            }
        ]
        frame, _ = fc.compute_stock_factor_frame(df, specs)
        section_dates = list(pd.bdate_range(self.START, periods=self.N_DAYS)[::10])
        aligned = fc.align_to_sections(frame, section_dates)
        self.assertEqual(list(aligned.index), section_dates)
        # as-of 语义：截面日取值 = 截至当日最后可见值
        for d in section_dates:
            self.assertEqual(
                aligned.loc[d, "收盘价"],
                frame.loc[:d, "收盘价"].iloc[-1],
            )
        matrices = fc.build_section_matrices(
            {"sh600000": aligned, "sz300001": aligned}, section_dates, min_stocks=2
        )
        self.assertEqual(len(matrices), len(section_dates))
        _, mat = matrices[0]
        self.assertEqual(sorted(mat.index), ["sh600000", "sz300001"])
        # 股票数不足 min_stocks 的截面被剔除
        few = fc.build_section_matrices({"sh600000": aligned}, section_dates, 2)
        self.assertEqual(few, [])
```

- [ ] **Step 2: 跑测试确认失败**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期 `TestFactorCompute` 全红。

- [ ] **Step 3: 最小实现**

在 `resources/factor_collinearity.py` 的 `hfq_restore` 函数之后追加：

```python
def load_custom_factor_module(factor_dirs, name):
    """
    按因子名定位并加载模块：'类目.名' → <dir>/类目/名.py；裸名 → <dir>/名.py。
    返回 (module, path)；文件不存在返回 (None, 候选路径列表)。
    加载异常（语法错误等）向上抛，由调用方标记 status=error。
    因子文件写入时已过 AST 白名单静态检查（write_factor_file），此处信任执行。
    """
    rel = name.split(".")
    candidates = [os.path.join(d, *rel) + ".py" for d in factor_dirs]
    for path in candidates:
        if not os.path.isfile(path):
            continue
        spec = importlib.util.spec_from_file_location(
            "qc_coll_" + str(abs(hash(os.path.abspath(path)))), path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, path
    return None, candidates


def compute_stock_factor_frame(df, factor_specs):
    """
    计算单只股票的因子值矩阵。
    df: load_stock_csv 结果（原始价）；factor_specs: list[dict]，kind=builtin
    带 builtin=(mode, 列名)，kind=custom 带 module。
    自定义因子收到后复权价量（内核口径：因子计算用后复权数据）。
    返回 (DataFrame[index=交易日期, columns=label], errors: dict[label, str])。
    """
    hfq_close, ratio = hfq_restore(df)
    work = df.copy()
    work["收盘价"] = hfq_close
    for col in ("开盘价", "最高价", "最低价"):
        if col in work.columns:
            work[col] = pd.to_numeric(work[col], errors="coerce") * ratio
    cols = {}
    errors = {}
    for spec in factor_specs:
        label = spec["label"]
        try:
            if spec["kind"] == "builtin":
                mode, col = spec["builtin"]
                if col not in df.columns:
                    raise KeyError(f"行情 CSV 缺少列: {col}")
                if mode == "price":
                    series = pd.to_numeric(work[col], errors="coerce")
                else:
                    series = pd.to_numeric(df[col], errors="coerce")
            else:
                col_name = "__qc_col__"
                result = spec["module"].add_factor(
                    work.copy(), param=spec["param"], col_name=col_name
                )
                series = pd.to_numeric(result[col_name], errors="coerce")
            cols[label] = series
        except Exception as exc:
            errors[label] = f"{type(exc).__name__}: {exc}"
    frame = pd.DataFrame(cols, index=df.index) if cols else pd.DataFrame(index=df.index)
    return frame, errors


def align_to_sections(frame, section_dates):
    """取每个调仓日「截至当日最后可见」的因子值（ffill as-of 对齐）。"""
    if frame.empty:
        return frame
    idx = frame.index.union(section_dates)
    return frame.reindex(idx).ffill().reindex(section_dates)


def build_section_matrices(stock_frames, section_dates, min_stocks=30):
    """
    组装逐日截面矩阵。
    stock_frames: {code: DataFrame(index=section_dates, columns=labels)}（已 as-of 对齐）。
    剔除全空行（停牌/无数据个股）与股票数不足 min_stocks 的截面。
    返回 list[(date, DataFrame[index=code, columns=label])]。
    """
    matrices = []
    for d in section_dates:
        rows = {code: f.loc[d] for code, f in stock_frames.items() if d in f.index}
        if not rows:
            continue
        mat = pd.DataFrame(rows).T.dropna(how="all")
        if len(mat) >= min_stocks:
            matrices.append((d, mat))
    return matrices
```

- [ ] **Step 4: 跑测试确认通过**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期 `TestFactorCompute` 4 个测试全过。

- [ ] **Step 5: commit**

```bash
git add resources/factor_collinearity.py tests/python/test_factor_collinearity.py
git commit -m "feat(mcp): 共线性脚本因子模块加载与截面矩阵计算"
```

---

### Task 4: 相关矩阵统计 + run_analysis/main + JSON 输出

**Files:**
- Modify: `resources/factor_collinearity.py`（在 `build_section_matrices` 之后追加，文件收尾）
- Test: `tests/python/test_factor_collinearity.py`（在 `if __name__ == "__main__":` 之前插入新 TestCase）

- [ ] **Step 1: 写失败测试**

在 `tests/python/test_factor_collinearity.py` 的 `if __name__ == "__main__":` 之前插入：

```python
class TestStatsAndReport(FixtureTestCase):
    def test_spearman_matrix_monotonic(self):
        # Spearman 对单调变换不变：y = x^3（严格单调）与 x 的秩相关 = 1
        mat = pd.DataFrame(
            {"x": [1.0, 2.0, 3.0, 4.0, 5.0], "y": [1.0, 8.0, 27.0, 64.0, 125.0]}
        )
        r = fc.spearman_matrix(mat)
        self.assertAlmostEqual(r.loc["x", "y"], 1.0, places=9)

    def test_effective_complexity_participation_ratio(self):
        # 两因子完全相关 + 一个独立：特征值 {2,1,0} → 参与比 9/5 = 1.8
        r = pd.DataFrame(
            [[1.0, 1.0, 0.0], [1.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            index=["a", "b", "c"],
            columns=["a", "b", "c"],
        )
        self.assertAlmostEqual(fc.effective_complexity_from_corr(r), 1.8, places=6)
        # 单位矩阵 → 有效复杂度 = 因子数
        eye = pd.DataFrame(np.eye(4), index=list("abcd"), columns=list("abcd"))
        self.assertAlmostEqual(fc.effective_complexity_from_corr(eye), 4.0, places=6)

    def test_vif_singular_fallback(self):
        # 完全相关矩阵不可逆 → pinv 兜底，不抛异常
        r = pd.DataFrame([[1.0, 1.0], [1.0, 1.0]], index=["a", "b"], columns=["a", "b"])
        vif = fc.compute_vif(r)
        self.assertEqual(set(vif), {"a", "b"})
        self.assertTrue(all(v > 0 for v in vif.values()))
        # 独立因子 VIF = 1
        eye = pd.DataFrame(np.eye(2), index=["a", "b"], columns=["a", "b"])
        self.assertAlmostEqual(fc.compute_vif(eye)["a"], 1.0, places=6)

    def test_run_analysis_end_to_end(self):
        report = fc.analyze_or_error(self.make_params())
        self.assertTrue(report["ok"], msg=report.get("error"))
        self.assertEqual(report["caveat"], fc.CAVEAT)
        self.assertLessEqual(report["sections_used"], 8)
        self.assertGreaterEqual(report["sections_used"], 4)
        self.assertEqual(report["stocks_per_section_median"], 4)
        # 两个构造上完全共线的玩具因子必须被检出
        labels = {"动量.动量N(10)", "动量.动量N2(10)"}
        pair = next(
            p for p in report["high_corr_pairs"] if {p["a"], p["b"]} == labels
        )
        self.assertGreaterEqual(pair["rho"], 0.99)
        self.assertGreaterEqual(report["max_abs_rho"], 0.99)
        # 有效复杂度：3 个因子中 2 个完全共线 → 明显小于 3
        self.assertGreaterEqual(report["effective_complexity"], 1.0)
        self.assertLess(report["effective_complexity"], 2.9)
        # 不可枚举内置因子进 unresolved，截面产出因子被跳过
        self.assertEqual(report["unresolved_factors"], ["异常涨跌停状态"])
        self.assertEqual(report["skipped_cross_factors"], ["截面排名差"])
        # 因子状态与矩阵键
        status = {f["name"]: f["status"] for f in report["factors"]}
        self.assertEqual(status["动量.动量N(10)"], "ok")
        self.assertEqual(status["流通市值"], "ok")
        self.assertIn("动量.动量N(10)", report["correlation_matrix"])
        self.assertIn("动量.动量N(10)", report["vif"])
        self.assertTrue(report["factor_redundancy_rank"])
        self.assertGreaterEqual(report["duration_ms"], 0)

    def test_run_analysis_all_factors_unresolved(self):
        report = fc.analyze_or_error(
            self.make_params(config_path=self.bad_config_path)
        )
        self.assertFalse(report["ok"])
        self.assertIn("无可分析因子", report["error"])

    def test_run_analysis_missing_data_dir(self):
        report = fc.analyze_or_error(
            self.make_params(data_dir=os.path.join(self.tmp, "nonexistent"))
        )
        self.assertFalse(report["ok"])
        self.assertIn("行情数据目录不存在", report["error"])

    def test_run_analysis_respects_board_filters(self):
        # 过滤到只剩 sh600000 一只（不足 min_stocks=2）→ 无有效截面
        report = fc.analyze_or_error(
            self.make_params(filters={"kcb": "1", "cyb": "1", "bj": "1"}, min_stocks=2)
        )
        self.assertFalse(report["ok"])
        self.assertIn("无有效截面", report["error"])

    def test_main_subprocess_smoke(self):
        params_path = os.path.join(self.tmp, "params.json")
        with open(params_path, "w", encoding="utf-8") as f:
            json.dump(self.make_params(), f)
        proc = subprocess.run(
            [sys.executable, os.path.join(RESOURCES_DIR, "factor_collinearity.py"), params_path],
            capture_output=True,
            timeout=300,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr.decode("utf-8", "replace"))
        report = json.loads(proc.stdout.decode("utf-8"))
        self.assertTrue(report["ok"])
        self.assertGreaterEqual(report["max_abs_rho"], 0.99)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期 `TestStatsAndReport` 全红（`spearman_matrix` 等 AttributeError / `run_analysis` NameError）。

- [ ] **Step 3: 最小实现**

在 `resources/factor_collinearity.py` 的 `build_section_matrices` 函数之后追加（这是文件的最终完整形态）：

```python
def spearman_matrix(mat):
    """单截面 Spearman 秩相关：先按列排名再算 Pearson（不用 scipy）。"""
    ranked = mat.rank(method="average", na_option="keep")
    return ranked.corr(min_periods=max(3, min(30, len(mat) - 1)))


def robust_correlation(mats):
    """跨截面相关系数中位数 → 稳健相关矩阵；全空因子对补 0、对角线置 1。"""
    corrs = [spearman_matrix(m) for m in mats]
    if not corrs:
        raise RuntimeError("无有效截面（股票数不足或因子值全空）")
    labels = list(corrs[0].columns)
    stack = np.stack(
        [c.reindex(index=labels, columns=labels).to_numpy() for c in corrs]
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        median = np.nanmedian(stack, axis=0)
    r = pd.DataFrame(median, index=labels, columns=labels).fillna(0.0)
    np.fill_diagonal(r.values, 1.0)
    return r


def compute_vif(r):
    """VIF = 相关矩阵逆的对角线；矩阵奇异时退化为 pinv（numpy.linalg，无 scipy）。"""
    try:
        inv = np.linalg.inv(r.to_numpy())
    except np.linalg.LinAlgError:
        inv = np.linalg.pinv(r.to_numpy())
    return {
        label: float(max(v, 0.0)) for label, v in zip(r.index, np.diag(inv))
    }


def effective_complexity_from_corr(r):
    """有效复杂度 = 参与比 (Σλ)²/Σλ²，λ 为相关矩阵特征值（eigvalsh，负值噪声截 0）。"""
    eig = np.clip(np.linalg.eigvalsh(r.to_numpy()), 0.0, None)
    s1 = float(eig.sum())
    s2 = float((eig ** 2).sum())
    if s2 <= 0:
        return float(len(eig))
    return s1 * s1 / s2


def high_corr_pairs(r, threshold):
    """|ρ| >= threshold 的因子对，按 |ρ| 降序。"""
    pairs = []
    labels = list(r.columns)
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            rho = float(r.iloc[i, j])
            if abs(rho) >= threshold:
                pairs.append({"a": labels[i], "b": labels[j], "rho": round(rho, 6)})
    pairs.sort(key=lambda p: -abs(p["rho"]))
    return pairs


def factor_redundancy_rank(r):
    """每因子对其他因子的平均 |ρ|，降序 —— 越靠前越冗余。"""
    out = []
    for name in r.columns:
        others = r.loc[name].drop(index=name).abs()
        mean_rho = round(float(others.mean()), 6) if len(others) else 0.0
        out.append({"name": name, "mean_abs_rho": mean_rho})
    out.sort(key=lambda x: -x["mean_abs_rho"])
    return out


def max_abs_rho(r):
    if len(r.columns) < 2:
        return 0.0
    vals = r.to_numpy().copy()
    np.fill_diagonal(vals, 0.0)
    return round(float(np.abs(vals).max()), 6)


def _resolve_factor_specs(refs, factor_dirs):
    """把因子引用解析为计算 spec：内置映射表 / 自定义模块 / unresolved。"""
    factor_specs = []
    unresolved = []
    factor_status = []
    for ref in refs:
        label = ref_label(ref)
        name = ref["name"]
        if name in BUILTIN_FACTOR_MAP:
            factor_specs.append(
                {
                    "label": label,
                    "name": name,
                    "param": ref["param"],
                    "kind": "builtin",
                    "builtin": BUILTIN_FACTOR_MAP[name],
                }
            )
            factor_status.append({"name": label, "kind": "builtin", "status": "ok"})
            continue
        module = None
        load_error = None
        try:
            module, _ = load_custom_factor_module(factor_dirs, name)
        except Exception as exc:
            load_error = f"{type(exc).__name__}: {exc}"
        if module is not None:
            factor_specs.append(
                {
                    "label": label,
                    "name": name,
                    "param": ref["param"],
                    "kind": "custom",
                    "module": module,
                }
            )
            factor_status.append({"name": label, "kind": "custom", "status": "ok"})
        elif load_error is not None:
            factor_status.append(
                {"name": label, "kind": "custom", "status": "error", "error": load_error}
            )
        else:
            unresolved.append(name)
    return factor_specs, unresolved, factor_status


def run_analysis(params):
    """主流程：config 解析 → 因子解析 → 调仓日 → 逐股因子矩阵 → 截面统计 → 报告 dict。"""
    t0 = time.time()
    config_path = params["config_path"]
    if not os.path.isfile(config_path):
        raise RuntimeError(f"config.py 不存在: {config_path}")
    factor_dirs = list(params.get("factor_dirs") or [])
    data_dir = params["data_dir"]
    start_date = params["start_date"]
    end_date = params.get("end_date") or pd.Timestamp.today().strftime("%Y-%m-%d")
    filters = params.get("filters") or {}
    max_sections = int(params.get("max_sections") or 60)
    corr_threshold = float(params.get("corr_threshold") or 0.8)
    min_stocks = int(params.get("min_stocks") or 30)

    extracted = parse_config_vars(config_path, ["strategy_list", "backtest_name"])
    strategy_list = extracted.get("strategy_list") or []
    if not isinstance(strategy_list, list) or not strategy_list:
        raise RuntimeError("config.py 的 strategy_list 为空或无法解析")

    refs, cross_names = collect_factor_refs(strategy_list)
    factor_specs, unresolved, factor_status = _resolve_factor_specs(refs, factor_dirs)
    if not factor_specs:
        raise RuntimeError("无可分析因子（全部无法解析或未找到因子文件）")

    calendar = load_trade_calendar(data_dir)
    section_dates = compute_rebalance_dates(
        strategy_list, calendar, start_date, end_date, max_sections
    )
    if not section_dates:
        raise RuntimeError(f"回测区间 [{start_date}, {end_date}] 内无调仓日")

    pool_dir, codes = list_stock_pool(data_dir, filters)

    # 回看窗口：max(param) × 2 + 20 个交易日 buffer，限制内存占用
    lookback = 20
    for spec in factor_specs:
        try:
            lookback = max(lookback, int(spec["param"]))
        except (TypeError, ValueError):
            pass

    stock_frames = {}
    skipped_stocks = 0
    error_counts = {}
    first_ts = pd.Timestamp(section_dates[0])
    last_ts = pd.Timestamp(section_dates[-1])
    for code in codes:
        try:
            df = load_stock_csv(os.path.join(pool_dir, code + ".csv"))
            df = df.loc[:last_ts]
            if df.empty:
                skipped_stocks += 1
                continue
            pos = df.index.searchsorted(first_ts)
            df = df.iloc[max(0, pos - lookback * 2 - 20):]
            frame, errors = compute_stock_factor_frame(df, factor_specs)
            for label, msg in errors.items():
                error_counts.setdefault(label, [0, msg])
                error_counts[label][0] += 1
            aligned = align_to_sections(frame, section_dates)
            if not aligned.dropna(how="all").empty:
                stock_frames[code] = aligned
        except Exception:
            skipped_stocks += 1

    matrices = build_section_matrices(stock_frames, section_dates, min_stocks)
    if not matrices:
        raise RuntimeError("无有效截面（股票数不足或因子值全空）")

    r = robust_correlation([m for _, m in matrices])
    if r.shape[0] == 0:
        raise RuntimeError("全部因子计算失败，无矩阵可算")

    # 全部股票都计算失败的因子：回标 status=error（单因子不拖垮整体）
    computed = len(codes) - skipped_stocks
    for st in factor_status:
        if st["status"] != "ok":
            continue
        count = error_counts.get(st["name"], [0])[0]
        if computed > 0 and count >= computed:
            st["status"] = "error"
            st["error"] = error_counts[st["name"]][1]
        elif st["name"] not in r.columns:
            st["status"] = "error"
            st["error"] = "所有截面均无有效值"

    corr_dict = {
        a: {b: round(float(r.loc[a, b]), 6) for b in r.columns} for a in r.index
    }
    return {
        "ok": True,
        "caveat": CAVEAT,
        "backtest_name": extracted.get("backtest_name"),
        "sections_used": len(matrices),
        "section_dates": [d.strftime("%Y-%m-%d") for d, _ in matrices],
        "stocks_per_section_median": int(np.median([len(m) for _, m in matrices])),
        "stocks_skipped": skipped_stocks,
        "factors": factor_status,
        "unresolved_factors": unresolved,
        "skipped_cross_factors": cross_names,
        "correlation_matrix": corr_dict,
        "high_corr_pairs": high_corr_pairs(r, corr_threshold),
        "vif": compute_vif(r),
        "effective_complexity": round(effective_complexity_from_corr(r), 6),
        "max_abs_rho": max_abs_rho(r),
        "factor_redundancy_rank": factor_redundancy_rank(r),
        "duration_ms": int((time.time() - t0) * 1000),
    }


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "用法: factor_collinearity.py <params_json_path>"})
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        params = json.load(f)
    result = analyze_or_error(params)
    emit(result)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 跑测试确认通过**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
```

预期全部 20+ 个测试通过（含 subprocess 冒烟）。

- [ ] **Step 5: commit**

```bash
git add resources/factor_collinearity.py tests/python/test_factor_collinearity.py
git commit -m "feat(mcp): 共线性统计、有效复杂度与 JSON 报告输出"
```

---

### Task 5: TS 层 factor-collinearity.ts（异步 execFile + brief 读取 + 错误处理）

**Files:**
- Create: `src/mcp-server/factor-collinearity.ts`
- Test: `tests/mcp-server/factor-collinearity.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/mcp-server/factor-collinearity.test.ts`，完整内容：

```ts
import assert from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const TMP = mkdtempSync(join(tmpdir(), "qc-collinearity-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP
// 固定 dataDir 缺省值，避免宿主机 ALL_DATA_PATH 影响断言
delete process.env.ALL_DATA_PATH

const { createResearchRun } = await import(
	"../../src/mcp-server/research-run.ts"
)
const {
	DEFAULT_CORR_THRESHOLD,
	DEFAULT_MAX_SECTIONS,
	analyzeFactorCollinearity,
	buildCollinearityParams,
	summarizeCollinearity,
} = await import("../../src/mcp-server/factor-collinearity.ts")
const { getResearchBrief } = await import(
	"../../src/mcp-server/research-run.ts"
)
type CollinearityReport =
	import("../../src/mcp-server/factor-collinearity.ts").CollinearityReport

const BRIEF = {
	goal: "共线性测试",
	thresholds: { annual_return_pct: 15 },
	backtest: {
		start_date: "2023-01-01",
		end_date: "2025-12-31",
		filter_kcb: "1",
		filter_cyb: "0",
		filter_bj: "1",
	},
}

const REPORT: CollinearityReport = {
	ok: true,
	caveat: "研究用近似口径",
	backtest_name: "toy",
	sections_used: 12,
	section_dates: ["2024-01-02"],
	stocks_per_section_median: 100,
	stocks_skipped: 0,
	factors: [{ name: "a", kind: "custom", status: "ok" }],
	unresolved_factors: [],
	skipped_cross_factors: [],
	correlation_matrix: { a: { a: 1, b: 0.9 }, b: { a: 0.9, b: 1 } },
	high_corr_pairs: [{ a: "a", b: "b", rho: 0.9 }],
	vif: { a: 5.2, b: 5.2 },
	effective_complexity: 1.5,
	max_abs_rho: 0.9,
	factor_redundancy_rank: [{ name: "b", mean_abs_rho: 0.9 }],
	duration_ms: 10,
}

function writeVariant(runId: string, variantId: string): void {
	const dir = join(TMP, runId, variantId)
	mkdirSync(join(dir, "因子库"), { recursive: true })
	writeFileSync(
		join(dir, "config.py"),
		'backtest_name = "toy"\nstrategy_list = []\n',
		"utf-8",
	)
}

describe("factor-collinearity", () => {
	after(() => {
		rmSync(TMP, { recursive: true, force: true })
	})

	it("buildCollinearityParams maps brief window and filters", () => {
		createResearchRun("run-c0", BRIEF)
		const params = buildCollinearityParams({
			configPath: "/x/config.py",
			factorDir: "/x/因子库",
			dataDir: "/data",
			brief: getResearchBrief("run-c0"),
			maxSections: 60,
			corrThreshold: 0.8,
		})
		assert.strictEqual(params.start_date, "2023-01-01")
		assert.strictEqual(params.end_date, "2025-12-31")
		assert.deepStrictEqual(params.filters, { kcb: "1", cyb: "0", bj: "1" })
		assert.strictEqual(params.max_sections, 60)
		assert.strictEqual(params.corr_threshold, 0.8)
	})

	it("buildCollinearityParams falls back when brief is null", () => {
		const params = buildCollinearityParams({
			configPath: "/x/config.py",
			factorDir: "/x/因子库",
			dataDir: "/data",
			brief: null,
			maxSections: 10,
			corrThreshold: 0.7,
		})
		assert.strictEqual(params.start_date, "2015-01-01")
		assert.strictEqual(params.end_date, null)
		assert.deepStrictEqual(params.filters, { kcb: "0", cyb: "0", bj: "0" })
		assert.strictEqual(params.max_sections, 10)
		assert.strictEqual(params.corr_threshold, 0.7)
	})

	it("assembles params from brief and parses python output", async () => {
		createResearchRun("run-c1", BRIEF)
		writeVariant("run-c1", "v1")
		let captured: unknown = null
		const result = await analyzeFactorCollinearity("run-c1", "v1", {}, async (p) => {
			captured = p
			return JSON.stringify(REPORT)
		})
		assert.strictEqual(result.ok, true)
		if (!result.ok) return
		const params = captured as Record<string, unknown>
		assert.strictEqual(params.start_date, "2023-01-01")
		assert.strictEqual(params.end_date, "2025-12-31")
		assert.deepStrictEqual(params.filters, { kcb: "1", cyb: "0", bj: "1" })
		assert.strictEqual(params.max_sections, DEFAULT_MAX_SECTIONS)
		assert.strictEqual(params.corr_threshold, DEFAULT_CORR_THRESHOLD)
		assert.strictEqual(params.data_dir, "D:/QuantClassSpace/QuantData")
		assert.ok(String(params.config_path).endsWith("config.py"))
		assert.ok(String((params.factor_dirs as string[])[0]).endsWith("因子库"))
		assert.strictEqual(result.effective_complexity, 1.5)
		assert.strictEqual(result.max_abs_rho, 0.9)
	})

	it("returns ok:false when config.py is missing", async () => {
		const result = await analyzeFactorCollinearity(
			"run-nothing",
			"v9",
			{},
			async () => {
				throw new Error("runner 不应被调用")
			},
		)
		assert.strictEqual(result.ok, false)
		if (result.ok) return
		assert.match(result.error, /config\.py 不存在/)
	})

	it("passes through python ok:false output", async () => {
		writeVariant("run-c1", "v2")
		const result = await analyzeFactorCollinearity(
			"run-c1",
			"v2",
			{},
			async () => JSON.stringify({ ok: false, error: "行情数据目录不存在: x" }),
		)
		assert.strictEqual(result.ok, false)
		if (result.ok) return
		assert.match(result.error, /行情数据目录不存在/)
	})

	it("maps python timeout to error=timeout", async () => {
		writeVariant("run-c1", "v3")
		const err = Object.assign(new Error("Command timed out"), {
			killed: true,
			signal: "SIGTERM",
		})
		const result = await analyzeFactorCollinearity(
			"run-c1",
			"v3",
			{},
			async () => {
				throw err
			},
		)
		assert.strictEqual(result.ok, false)
		if (result.ok) return
		assert.strictEqual(result.error, "timeout")
	})

	it("wraps ENOENT with actionable python hint", async () => {
		writeVariant("run-c1", "v4")
		const result = await analyzeFactorCollinearity(
			"run-c1",
			"v4",
			{},
			async () => {
				throw new Error("spawn python ENOENT")
			},
		)
		assert.strictEqual(result.ok, false)
		if (result.ok) return
		assert.match(result.error, /Python 不可达/)
	})

	it("wraps non-JSON stdout as execution failure", async () => {
		writeVariant("run-c1", "v5")
		const result = await analyzeFactorCollinearity(
			"run-c1",
			"v5",
			{},
			async () => "not-json",
		)
		assert.strictEqual(result.ok, false)
		if (result.ok) return
		assert.match(result.error, /共线性分析执行失败/)
	})

	it("summarizeCollinearity extracts trace summary fields", () => {
		assert.deepStrictEqual(summarizeCollinearity(REPORT), {
			max_abs_rho: 0.9,
			high_corr_pairs_count: 1,
			effective_complexity: 1.5,
			sections_used: 12,
		})
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test --experimental-strip-types tests/mcp-server/factor-collinearity.test.ts
```

预期：import `../../src/mcp-server/factor-collinearity.ts` 失败，全红。

- [ ] **Step 3: 最小实现 — 创建 src/mcp-server/factor-collinearity.ts**

完整内容：

```ts
/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { pythonErrorHint, resolvePythonCmd, resourceScript } from "./paths.ts"
import { type BriefFile, getResearchBrief } from "./research-run.ts"
import {
	assertInsideWorkspace,
	assertSafePathComponent,
	getWorkspaceRoot,
} from "./strategy-files.ts"

const execFileAsync = promisify(execFile)

export const DEFAULT_COLLINEARITY_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_MAX_SECTIONS = 60
export const DEFAULT_CORR_THRESHOLD = 0.8
/** brief 缺失时的兜底回测起点（单份事实源是 brief.backtest，见 spec §4.2） */
const FALLBACK_START_DATE = "2015-01-01"

export interface CollinearityFactorStatus {
	name: string
	kind: "builtin" | "custom"
	status: "ok" | "error"
	error?: string
}

/** resources/factor_collinearity.py 的 stdout 报告（ok:true 分支） */
export interface CollinearityReport {
	ok: true
	caveat: string
	backtest_name: string | null
	sections_used: number
	section_dates: string[]
	stocks_per_section_median: number
	stocks_skipped: number
	factors: CollinearityFactorStatus[]
	unresolved_factors: string[]
	skipped_cross_factors: string[]
	correlation_matrix: Record<string, Record<string, number>>
	high_corr_pairs: Array<{ a: string; b: string; rho: number }>
	vif: Record<string, number>
	effective_complexity: number
	max_abs_rho: number
	factor_redundancy_rank: Array<{ name: string; mean_abs_rho: number }>
	duration_ms: number
}

export interface CollinearityFailure {
	ok: false
	error: string
	caveat?: string
}

export type CollinearityResult = CollinearityReport | CollinearityFailure

export interface AnalyzeCollinearityOptions {
	maxSections?: number
	corrThreshold?: number
	timeoutMs?: number
	/** 缺省读 ALL_DATA_PATH，再缺省 D:/QuantClassSpace/QuantData */
	dataDir?: string
}

/** 传给 factor_collinearity.py 的 params JSON（snake_case 与脚本约定一致） */
export interface CollinearityPythonParams {
	config_path: string
	factor_dirs: string[]
	data_dir: string
	start_date: string
	end_date: string | null
	filters: { kcb: string; cyb: string; bj: string }
	max_sections: number
	corr_threshold: number
}

/** 注入点：单测用假 runner 替代真实 Python 子进程 */
export type CollinearityRunner = (
	params: CollinearityPythonParams,
	timeoutMs: number,
) => Promise<string>

/**
 * 组装 Python params。回测区间与板块过滤的单份事实源是 run 的 brief.json
 * （brief.backtest）；brief 缺失时用宽默认值并交给 Python 侧裁剪。
 */
export function buildCollinearityParams(args: {
	configPath: string
	factorDir: string
	dataDir: string
	brief: BriefFile | null
	maxSections: number
	corrThreshold: number
}): CollinearityPythonParams {
	const bt = args.brief?.backtest
	return {
		config_path: args.configPath,
		factor_dirs: [args.factorDir],
		data_dir: args.dataDir,
		start_date: bt?.start_date ?? FALLBACK_START_DATE,
		end_date: bt?.end_date ?? null,
		filters: {
			kcb: bt?.filter_kcb ?? "0",
			cyb: bt?.filter_cyb ?? "0",
			bj: bt?.filter_bj ?? "0",
		},
		max_sections: args.maxSections,
		corr_threshold: args.corrThreshold,
	}
}

/**
 * 真实 runner：内嵌 Python + 临时文件传参，异步 execFile
 * （分析为分钟级长任务，不用 factor-check.ts 的 10s sync 模式）。
 * 脚本业务错误以 ok:false JSON + 非零退出码返回，这里从 error.stdout 捞回 JSON。
 */
export const runCollinearityPython: CollinearityRunner = async (
	params,
	timeoutMs,
) => {
	const tmpDir = mkdtempSync(join(tmpdir(), "qc-collinearity-"))
	try {
		const paramsPath = join(tmpDir, "params.json")
		writeFileSync(paramsPath, JSON.stringify(params), "utf-8")
		const python = resolvePythonCmd()
		const script = resourceScript("factor_collinearity.py")
		try {
			const { stdout } = await execFileAsync(
				python.cmd,
				[script, paramsPath],
				{
					encoding: "utf-8",
					timeout: timeoutMs,
					maxBuffer: 64 * 1024 * 1024,
					windowsHide: true,
				},
			)
			return stdout
		} catch (error) {
			const e = error as { stdout?: unknown }
			if (typeof e?.stdout === "string" && e.stdout.trim().startsWith("{")) {
				return e.stdout
			}
			throw error
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
}

function mapCollinearityError(error: unknown): string {
	const err = error as NodeJS.ErrnoException & {
		killed?: boolean
		signal?: string
	}
	if (
		err?.killed === true ||
		err?.signal === "SIGTERM" ||
		String(err?.message).includes("ETIMEDOUT")
	) {
		return "timeout"
	}
	const msg = error instanceof Error ? error.message : String(error)
	if (msg.includes("ENOENT")) {
		return `Python 不可达: ${msg}${pythonErrorHint(resolvePythonCmd(), msg)}`
	}
	return `共线性分析执行失败: ${msg}`
}

/**
 * 对指定 run/variant 做值级因子共线性分析。
 * 任何失败都返回 {ok:false, error}，由调用方决定呈现（不抛异常）。
 */
export async function analyzeFactorCollinearity(
	runId: string,
	variantId: string,
	opts: AnalyzeCollinearityOptions = {},
	runner: CollinearityRunner = runCollinearityPython,
): Promise<CollinearityResult> {
	try {
		assertSafePathComponent(runId, "runId")
		assertSafePathComponent(variantId, "variantId")
		const variantDir = assertInsideWorkspace(
			join(getWorkspaceRoot(), runId, variantId),
		)
		const configPath = join(variantDir, "config.py")
		if (!existsSync(configPath)) {
			return { ok: false, error: `config.py 不存在: ${configPath}` }
		}
		const dataDir =
			opts.dataDir ??
			process.env.ALL_DATA_PATH ??
			"D:/QuantClassSpace/QuantData"
		const params = buildCollinearityParams({
			configPath,
			factorDir: join(variantDir, "因子库"),
			dataDir,
			brief: getResearchBrief(runId),
			maxSections: opts.maxSections ?? DEFAULT_MAX_SECTIONS,
			corrThreshold: opts.corrThreshold ?? DEFAULT_CORR_THRESHOLD,
		})
		const stdout = await runner(
			params,
			opts.timeoutMs ?? DEFAULT_COLLINEARITY_TIMEOUT_MS,
		)
		return JSON.parse(stdout) as CollinearityResult
	} catch (error) {
		return { ok: false, error: mapCollinearityError(error) }
	}
}

/** 报告 → trace entry 的浓缩摘要（与 research-run.ts 的 collinearitySummarySchema 同构） */
export interface CollinearitySummary {
	max_abs_rho: number
	high_corr_pairs_count: number
	effective_complexity: number
	sections_used: number
}

export function summarizeCollinearity(
	report: CollinearityReport,
): CollinearitySummary {
	return {
		max_abs_rho: report.max_abs_rho,
		high_corr_pairs_count: report.high_corr_pairs.length,
		effective_complexity: report.effective_complexity,
		sections_used: report.sections_used,
	}
}
```

注意：本模块 import `getResearchBrief` 自 `./research-run.ts`，而 `research-run.ts` **不** import 本模块（withCollinearity 编排在 tools.ts handler 层），依赖单向、无循环。

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

```bash
node --test --experimental-strip-types tests/mcp-server/factor-collinearity.test.ts
npx tsc --noEmit -p tsconfig.mcp.json
npx biome check src/mcp-server/factor-collinearity.ts tests/mcp-server/factor-collinearity.test.ts
```

预期全部通过（biome 若报格式问题，用 `npx biome check --write <files>` 修复后再跑测试）。

- [ ] **Step 5: commit**

```bash
git add src/mcp-server/factor-collinearity.ts tests/mcp-server/factor-collinearity.test.ts
git commit -m "feat(mcp): 共线性分析 TS 层（异步 execFile、brief 窗口、错误映射）"
```

---

### Task 6: tools.ts 注册 analyze_factor_collinearity + e2e 工具清单

**Files:**
- Modify: `src/mcp-server/tools.ts`（import 区 :26 之后；`get_backtest_diagnostics` 注册块 :1708 之前插入）
- Test: `tests/mcp-server/tools.test.ts`（"exposes research workflow tools" 用例 :124-131）

- [ ] **Step 1: 写失败测试（e2e 工具名清单）**

修改 `tests/mcp-server/tools.test.ts`（old_string）：

```ts
		assert.ok(names.includes("create_research_run"))
		assert.ok(names.includes("record_experiment"))
		assert.ok(names.includes("get_experiment_trace"))
		assert.ok(names.includes("get_run_summary"))
```

new_string：

```ts
		assert.ok(names.includes("create_research_run"))
		assert.ok(names.includes("record_experiment"))
		assert.ok(names.includes("get_experiment_trace"))
		assert.ok(names.includes("get_run_summary"))
		assert.ok(names.includes("analyze_factor_collinearity"))
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm build:mcp && node --test --experimental-strip-types tests/mcp-server/tools.test.ts
```

预期：`analyze_factor_collinearity` 断言失败（工具未注册）。

- [ ] **Step 3: 最小实现**

修改 `src/mcp-server/tools.ts` import 区（old_string）：

```ts
import { checkFactorSource } from "./factor-check.js"
```

new_string：

```ts
import { checkFactorSource } from "./factor-check.js"
import { analyzeFactorCollinearity } from "./factor-collinearity.js"
```

在 `get_run_summary` 注册块之后、`get_backtest_diagnostics` 注册块之前插入新工具（old_string 锚点）：

```ts
	server.tool(
		"get_backtest_diagnostics",
```

new_string：

```ts
	server.tool(
		"analyze_factor_collinearity",
		"对指定 run/variant 做值级因子共线性分析（研究用近似口径，报告自带 caveat）：解析 config.py 收集时序因子引用，按 run 的 brief.backtest 回测区间抽取调仓日截面（默认最多 60 个），计算跨截面 Spearman 中位数相关矩阵，输出高相关对（|ρ|≥corrThreshold）、VIF、有效复杂度 effective_complexity（相关矩阵特征值参与比）与冗余因子排名。内置不可枚举因子列入 unresolved_factors；截面因子（cross_sections 产出）不计算，其输入时序因子纳入分析、产出名列入 skipped_cross_factors。分钟级耗时，默认超时 10 分钟。ok:false 时 error 为可读原因（timeout/config 缺失/行情目录缺失等）。",
		{
			runId: z.string().describe("Run ID"),
			variantId: z.string().describe("Variant ID，例如 v1"),
			maxSections: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("调仓日截面抽样上限，默认 60"),
			corrThreshold: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("高相关对阈值 |ρ|，默认 0.8"),
		},
		async ({ runId, variantId, maxSections, corrThreshold }) => {
			try {
				const result = await analyzeFactorCollinearity(runId, variantId, {
					maxSections,
					corrThreshold,
				})
				// ok:false 是结构化业务结果（与 validate_strategy 的 valid:false 同款），
				// 不带 isError，便于调用方解析
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `共线性分析失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		},
	)

	server.tool(
		"get_backtest_diagnostics",
```

- [ ] **Step 4: 重新打包 + 跑测试确认通过**

```bash
pnpm build:mcp && node --test --experimental-strip-types tests/mcp-server/tools.test.ts
npx tsc --noEmit -p tsconfig.mcp.json
```

预期 tools.test.ts 全部通过（含新工具名断言）。

- [ ] **Step 5: commit**

`resources/mcp-server/index.js` 是构建产物且已 gitignore（.gitignore:107），不要加入提交：

```bash
git add src/mcp-server/tools.ts tests/mcp-server/tools.test.ts
git commit -m "feat(mcp): 注册 analyze_factor_collinearity 工具"
```

---

### Task 7: research-run.ts 集成 + record_experiment withCollinearity 编排

**Files:**
- Modify: `src/mcp-server/research-run.ts`（:51 后插 entryMetricsSchema；:121 前插 collinearitySummarySchema；:150-156 metrics 字段换 entryMetricsSchema；:172-180 complexity 后加 collinearity 字段；:469 后插 attachCollinearity；:526-546 RunSummary 接口；:598 与 :617-640 getRunSummary 函数体）
- Modify: `src/mcp-server/tools.ts`（record_experiment 描述 :1594、参数 :1598-1604、handler 返回块 :1632-1635；两处 import）
- Test: `tests/mcp-server/factor-collinearity.test.ts`（import 行扩展 + 文件末尾追加 describe）

- [ ] **Step 1: 写失败测试**

先扩展 `tests/mcp-server/factor-collinearity.test.ts` 的 import（old_string）：

```ts
const { createResearchRun } = await import(
	"../../src/mcp-server/research-run.ts"
)
```

new_string：

```ts
const {
	attachCollinearity,
	createResearchRun,
	getExperimentTrace,
	getRunSummary,
	recordExperiment,
} = await import("../../src/mcp-server/research-run.ts")
```

注意：文件中原有的第二个 research-run 动态 import（`const { getResearchBrief } = await import(...)`）保留不动。

然后在文件末尾追加：

```ts

describe("record_experiment withCollinearity（trace/summary 集成层）", () => {
	it("attaches collinearity summary to the latest trace entry", () => {
		createResearchRun("run-c2", BRIEF)
		recordExperiment("run-c2", {
			variantId: "v1",
			hypothesis: "h1",
			metrics: { annual_return_pct: 10 },
			evaluation: { passed: true, score: 1 },
		})
		const { entry } = attachCollinearity("run-c2", {
			max_abs_rho: 0.9,
			high_corr_pairs_count: 2,
			effective_complexity: 2.5,
			sections_used: 30,
		})
		assert.strictEqual(entry.collinearity?.max_abs_rho, 0.9)
		assert.strictEqual(entry.metrics?.effective_complexity, 2.5)
		// 落盘后重读仍在（持久化）
		const trace = getExperimentTrace("run-c2")
		assert.strictEqual(trace.entries[0].collinearity?.effective_complexity, 2.5)
		const summary = getRunSummary("run-c2")
		assert.strictEqual(summary.collinearity?.variantId, "v1")
		assert.strictEqual(summary.collinearity?.max_abs_rho, 0.9)
		assert.strictEqual(summary.collinearity?.effective_complexity, 2.5)
	})

	it("keeps original metrics when attaching collinearity", () => {
		const trace = getExperimentTrace("run-c2")
		assert.strictEqual(trace.entries[0].metrics?.annual_return_pct, 10)
	})

	it("accepts collinearity as optional entry field, rejects malformed", () => {
		createResearchRun("run-c3", BRIEF)
		const { entry } = recordExperiment("run-c3", {
			variantId: "v1",
			hypothesis: "h",
			collinearity: {
				max_abs_rho: 0.5,
				high_corr_pairs_count: 0,
				effective_complexity: 3.2,
				sections_used: 10,
			},
		})
		assert.strictEqual(entry.collinearity?.effective_complexity, 3.2)
		assert.throws(
			() =>
				recordExperiment("run-c3", {
					variantId: "v2",
					hypothesis: "h",
					collinearity: { max_abs_rho: 0.5 },
				}),
			/校验失败/,
		)
	})

	it("getRunSummary returns null collinearity when no entry carries it", () => {
		createResearchRun("run-c4", BRIEF)
		recordExperiment("run-c4", { variantId: "v1", hypothesis: "h" })
		assert.strictEqual(getRunSummary("run-c4").collinearity, null)
	})

	it("attachCollinearity throws when trace is missing", () => {
		createResearchRun("run-c5", BRIEF)
		assert.throws(
			() =>
				attachCollinearity("run-c5", {
					max_abs_rho: 0.1,
					high_corr_pairs_count: 0,
					effective_complexity: 1,
					sections_used: 1,
				}),
			/trace\.jsonl 不存在/,
		)
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test --experimental-strip-types tests/mcp-server/factor-collinearity.test.ts
```

预期：import `attachCollinearity` 失败（模块无此导出），全红。

- [ ] **Step 3: 最小实现 — research-run.ts 六处修改**

**R1** — 在 `metricsSchema` 之后插入 `entryMetricsSchema`（old_string）：

```ts
const backtestWindowSchema = z.object({
```

new_string：

```ts
/**
 * trace 条目绩效：在标准口径外允许 effective_complexity（因子共线性的
 * 有效复杂度，参与比口径）。与 complexity 条目数双口径并存；仅供展示，
 * 不进 trends/thresholdGaps（两者仍按 METRIC_KEYS 迭代），不参与 SOTA 排序。
 */
const entryMetricsSchema = metricsSchema.extend({
	effective_complexity: z.number().nonnegative().optional(),
})

const backtestWindowSchema = z.object({
```

**R2** — 在 `experimentEntrySchema` 之前插入 `collinearitySummarySchema`（old_string）：

```ts
export const experimentEntrySchema = z.object({
```

new_string：

```ts
/** record_experiment withCollinearity 写入 trace 的共线性摘要（analyze_factor_collinearity 的浓缩口径） */
const collinearitySummarySchema = z.object({
	max_abs_rho: z.number(),
	high_corr_pairs_count: z.number().int().nonnegative(),
	effective_complexity: z.number().nonnegative(),
	sections_used: z.number().int().nonnegative(),
})

export type CollinearitySummary = z.infer<typeof collinearitySummarySchema>

export const experimentEntrySchema = z.object({
```

**R3** — 条目 metrics 换用 `entryMetricsSchema`（old_string，注意锚定 worstWindow 后的那一处，windows 内的 `metrics: metricsSchema.optional()` 不动）：

```ts
	worstWindow: z
		.object({
			start_date: z.string(),
			end_date: z.string().nullable().optional(),
		})
		.optional(),
	metrics: metricsSchema.optional(),
```

new_string：

```ts
	worstWindow: z
		.object({
			start_date: z.string(),
			end_date: z.string().nullable().optional(),
		})
		.optional(),
	metrics: entryMetricsSchema.optional(),
```

**R4** — complexity 字段后加 `collinearity`（old_string）：

```ts
	complexity: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			"旋钮计数（factor_list+filter_list+filter_list_post+cross_sections 条目数）。缺省时自动从 variant 的 config.py 统计",
		),
})
```

new_string：

```ts
	complexity: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			"旋钮计数（factor_list+filter_list+filter_list_post+cross_sections 条目数）。缺省时自动从 variant 的 config.py 统计",
		),
	/**
	 * 共线性摘要（record_experiment withCollinearity 分析成功后由
	 * attachCollinearity 补写；也可由调用方直接传入）。仅供展示，不参与 SOTA。
	 */
	collinearity: collinearitySummarySchema.optional(),
})
```

**R5** — 在 `recordExperiment` 之后插入 `attachCollinearity`（old_string）：

```ts
	return { runId, tracePath: path, entry: full, budget }
}
```

new_string：

```ts
	return { runId, tracePath: path, entry: full, budget }
}

/**
 * 把共线性摘要补写到最近一次 trace 条目，并同步回填
 * metrics.effective_complexity（与 complexity 条目数双口径并存，不替换）。
 * 供 record_experiment 的 withCollinearity 流程在分析成功后调用；
 * 分析失败时不调用本函数，原记录不受影响（软警告语义）。
 * schema 变更为纯新增可选字段，旧条目读取向后兼容。
 */
export function attachCollinearity(
	runId: string,
	summary: CollinearitySummary,
): { runId: string; entry: ExperimentEntry } {
	const path = tracePath(runId)
	if (!existsSync(path)) {
		throw new Error(`trace.jsonl 不存在: ${path}`)
	}
	const lines = readFileSync(path, "utf-8").split(/\r?\n/)
	let lastIdx = -1
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim()) {
			lastIdx = i
			break
		}
	}
	if (lastIdx < 0) {
		throw new Error(`trace.jsonl 为空: ${path}`)
	}
	const parsed = JSON.parse(lines[lastIdx]) as Record<string, unknown>
	const existingMetrics = (parsed.metrics ?? {}) as Record<string, unknown>
	parsed.collinearity = summary
	parsed.metrics = {
		...existingMetrics,
		effective_complexity: summary.effective_complexity,
	}
	const entry = parseWith(experimentEntrySchema, parsed, "trace.jsonl 最新条目")
	lines[lastIdx] = JSON.stringify(entry)
	writeFileSync(path, lines.join("\n"), "utf-8")
	return { runId, entry: { ...entry, type: entry.type ?? "dev" } }
}
```

**R6** — `RunSummary` 接口与 `getRunSummary` 函数体。接口（old_string）：

```ts
	thresholdGaps: Partial<Record<MetricKey, ThresholdGap>> | null
	trends: Record<MetricKey, Array<{ variantId: string; value: number }>>
}
```

new_string：

```ts
	thresholdGaps: Partial<Record<MetricKey, ThresholdGap>> | null
	trends: Record<MetricKey, Array<{ variantId: string; value: number }>>
	/** 最近一次带共线性摘要的条目（无则 null）；仅供展示，不影响 SOTA 排序 */
	collinearity: {
		variantId: string
		ts?: string
		effective_complexity: number
		max_abs_rho: number
	} | null
}
```

函数体（old_string）：

```ts
	const lastValidation = entries.findLast((e) => e.type === "validation")
```

new_string：

```ts
	const lastValidation = entries.findLast((e) => e.type === "validation")
	const lastCollinearity = entries.findLast((e) => e.collinearity !== undefined)
```

返回对象（old_string）：

```ts
		thresholdGaps,
		trends,
	}
}
```

new_string：

```ts
		collinearity: lastCollinearity?.collinearity
			? {
					variantId: lastCollinearity.variantId,
					ts: lastCollinearity.ts,
					effective_complexity:
						lastCollinearity.collinearity.effective_complexity,
					max_abs_rho: lastCollinearity.collinearity.max_abs_rho,
				}
			: null,
		thresholdGaps,
		trends,
	}
}
```

- [ ] **Step 4: tools.ts — record_experiment 加 withCollinearity 编排（四处修改）**

**T1** — import（old_string）：

```ts
import { analyzeFactorCollinearity } from "./factor-collinearity.js"
```

new_string：

```ts
import {
	analyzeFactorCollinearity,
	summarizeCollinearity,
} from "./factor-collinearity.js"
```

**T2** — research-run import 加 `attachCollinearity`（old_string）：

```ts
import {
	createResearchRun,
	experimentEntrySchema,
```

new_string：

```ts
import {
	attachCollinearity,
	createResearchRun,
	experimentEntrySchema,
```

**T3** — 工具描述尾部（old_string，line 1594 长行的结尾）：

```ts
本工具仅放行无绩效的失败记录。",
```

new_string：

```ts
本工具仅放行无绩效的失败记录。withCollinearity=true 时记录完成后自动附带因子共线性分析（分钟级耗时）：成功则把共线性摘要与 metrics.effective_complexity 补写进本条 trace，max_abs_rho≥0.8 时响应附 collinearityWarning 软警告（仅提示不拦截）；分析失败不影响记录本身。",
```

**T4** — 参数与 handler（old_string）：

```ts
			fromLatestBacktest: z
				.boolean()
				.optional()
				.describe(
					"true 时自动抓取最近一次回测绩效到 metrics、内核版本到 kernelVersion（仅在对应字段缺省时生效）",
				),
		},
		async ({ runId, entry, fromLatestBacktest }) => {
```

new_string：

```ts
			fromLatestBacktest: z
				.boolean()
				.optional()
				.describe(
					"true 时自动抓取最近一次回测绩效到 metrics、内核版本到 kernelVersion（仅在对应字段缺省时生效）",
				),
			withCollinearity: z
				.boolean()
				.optional()
				.describe(
					"true 时在记录完成后附带因子共线性分析（分钟级耗时，默认 false）：成功则把 {max_abs_rho, high_corr_pairs_count, effective_complexity, sections_used} 摘要与 metrics.effective_complexity 补写进本条 trace；max_abs_rho≥0.8 时响应附 collinearityWarning 软警告（仅提示不拦截）。分析失败/超时不影响记录本身，仅在响应附降级说明",
				),
		},
		async ({ runId, entry, fromLatestBacktest, withCollinearity }) => {
```

**T5** — handler 返回块（old_string）：

```ts
				const result = recordExperiment(runId, merged)
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}
```

new_string：

```ts
				const result = recordExperiment(runId, merged)
				const payload: Record<string, unknown> = { ...result }
				if (withCollinearity) {
					// 软警告语义：先完成 trace 写入再分析；分析失败只降级为 warning
					try {
						const report = await analyzeFactorCollinearity(
							runId,
							entry.variantId,
						)
						if (report.ok) {
							const attached = attachCollinearity(
								runId,
								summarizeCollinearity(report),
							)
							payload.entry = attached.entry
							if (report.max_abs_rho >= 0.8) {
								const pairs = report.high_corr_pairs
									.slice(0, 5)
									.map((p) => `${p.a}~${p.b}(ρ=${p.rho})`)
									.join("、")
								payload.collinearityWarning = `检测到高相关因子对（max_abs_rho=${report.max_abs_rho}）：${pairs}。建议精简冗余因子；本提示不拦截任何流程。`
							}
						} else {
							payload.collinearityWarning = `共线性分析未完成（不影响本次记录）: ${report.error}`
						}
					} catch (error) {
						payload.collinearityWarning = `共线性分析异常（不影响本次记录）: ${error instanceof Error ? error.message : String(error)}`
					}
				}
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				}
```

- [ ] **Step 5: 跑测试确认通过 + 类型/风格检查**

```bash
node --test --experimental-strip-types tests/mcp-server/factor-collinearity.test.ts
node --test --experimental-strip-types tests/mcp-server/research-run.test.ts
npx tsc --noEmit -p tsconfig.mcp.json
npx biome check src/mcp-server/research-run.ts src/mcp-server/tools.ts
```

预期全部通过（既有 research-run.test.ts 不受 schema 新增可选字段影响——向后兼容）。

说明：withCollinearity 的 handler 编排是薄壳（记录 → analyze → attach/warning），其组成件均已单测覆盖；不在 tools.test.ts 做真实 e2e——该路径会触发真实 Python 分析（分钟级）且默认 dataDir 指向宿主机真实行情库，不适合进测试套件。

- [ ] **Step 6: commit**

```bash
git add src/mcp-server/research-run.ts src/mcp-server/tools.ts tests/mcp-server/factor-collinearity.test.ts
git commit -m "feat(mcp): record_experiment withCollinearity 软警告与 run summary 共线性展示"
```

---

### Task 8: 文档 + 全量验证 + 收尾

**Files:**
- Modify: `docs/quantclass-工作流.md`（§1 阶段与工具对照表，:44 评估行之后插入一行）

- [ ] **Step 1: 文档补行**

修改 `docs/quantclass-工作流.md`（old_string）：

```md
| 评估 | `evaluate_backtest` / `compare_backtest_variants` / `get_run_summary` / `get_experiment_trace` | SOTA 口径统一：先比达标率 score → 同分比年化 → 再比低复杂度 |
| 样本外闸门 | `run_validation` → `complete_validation` | 切到 brief.validation 窗口异步回测，完成后恢复配置并记录 type=validation 条目 |
```

new_string：

```md
| 评估 | `evaluate_backtest` / `compare_backtest_variants` / `get_run_summary` / `get_experiment_trace` | SOTA 口径统一：先比达标率 score → 同分比年化 → 再比低复杂度 |
| 共线性 | `analyze_factor_collinearity` | 值级共线性报告：调仓日截面 Spearman 中位数相关矩阵、高相关对、VIF、有效复杂度（近似口径，报告自带 caveat）；`record_experiment withCollinearity=true` 可自动附摘要进 trace（软警告不拦截） |
| 样本外闸门 | `run_validation` → `complete_validation` | 切到 brief.validation 窗口异步回测，完成后恢复配置并记录 type=validation 条目 |
```

- [ ] **Step 2: 全量验证**

```bash
resources/python/x64/python.exe -m unittest discover -s tests/python -v
npx tsc --noEmit -p tsconfig.mcp.json
npx biome check src/mcp-server/factor-collinearity.ts src/mcp-server/research-run.ts src/mcp-server/tools.ts tests/mcp-server/factor-collinearity.test.ts tests/mcp-server/tools.test.ts scripts/download-python.cjs
pnpm build:mcp
npm run test:mcp
```

预期：Python unittest 全过；tsc/biome 无错误；`npm run test:mcp` 全套通过（含 tools.test.ts 新工具名断言）。

- [ ] **Step 3:（可选，分钟级）真实数据手动冒烟**

对一个真实 variant 跑一次端到端（用内嵌 Python 直跑脚本，不经过 MCP）：

```bash
# 用任意文本编辑器把下面的 params 存为 %TEMP%\coll-params.json 后执行
resources/python/x64/python.exe resources/factor_collinearity.py %TEMP%\coll-params.json
```

params 内容（按实际 run/variant 调整）：

```json
{
  "config_path": "D:/QuantClassSpace/quantclass-client-pro/workspace/agent-strategies/run-momentum-001/v10/config.py",
  "factor_dirs": ["D:/QuantClassSpace/quantclass-client-pro/workspace/agent-strategies/run-momentum-001/v10/因子库"],
  "data_dir": "D:/QuantClassSpace/QuantData",
  "start_date": "2023-01-01",
  "end_date": "2025-12-31",
  "filters": {"kcb": "1", "cyb": "0", "bj": "1"},
  "max_sections": 20,
  "corr_threshold": 0.8
}
```

预期：stdout 为 `ok:true` JSON，`sections_used ≤ 20`，`effective_complexity ≤ 因子数`，`duration_ms` 在分钟级以内（性能预算：默认 maxSections=60、股票池 ~5000、因子 ~10 时 Python 预估分钟级，超时上限 10 分钟）。

- [ ] **Step 4: commit**

```bash
git add docs/quantclass-工作流.md
git commit -m "docs: 工作流阶段表补充 analyze_factor_collinearity 工具"
```

---

## spec 覆盖自查表

| spec 章节 | 覆盖位置 |
|-----------|----------|
| §4.1 factor_collinearity.py（输入 JSON、五步流程、输出字段含 caveat/sections_used/factors/unresolved/skipped_cross/correlation_matrix/high_corr_pairs/vif/effective_complexity/redundancy/duration_ms） | Task 1-4（输出另加 `max_abs_rho`/`backtest_name`/`section_dates`/`stocks_skipped`——TS 摘要与排查需要，增量字段不改 spec 语义） |
| §4.2 factor-collinearity.ts（brief 单份事实源、异步 execFile 10min、ok:false 不抛异常） | Task 5 |
| §4.3 工具注册 + tools.test.ts 清单 | Task 6 |
| §4.4 record_experiment withCollinearity（默认 false、先写 trace 再分析、失败降级、collinearity 摘要字段、metrics.effective_complexity 双口径、max_abs_rho≥0.8 软警告） | Task 7 |
| §4.5 get_run_summary 展示（不改 SOTA 排序） | Task 7 R6 |
| §5 错误处理表六行 | 见文首「错误处理表 → 实现位置映射」，逐行有落点 |
| §6 口径限制 caveat | Python `CAVEAT` 常量随 ok:true/ok:false 报告携带（Task 1）；工具描述同步注明（Task 6） |
| §7 测试（Python 玩具数据单测 / TS mock 单测 / e2e 注册断言） | Task 1-4 unittest（tmp 动态生成 GBK fixture，不进仓库）、Task 5/7 TS 单测、Task 6 e2e |
| §8 改动文件清单 | 全覆盖；**新增两个**：`scripts/download-python.cjs`（内嵌 Python 缺 pandas 的必要修正）、`tests/python/`（unittest 落地处；spec 的 `tests/mcp-server/fixtures/` 按「fixture 动态生成不进仓库」决定不建） |
| §9 性能预算（maxSections=60 默认、10min 超时、withCollinearity 默认关） | Task 5 常量 + Task 6/7 工具参数默认；Task 8 Step 3 手动冒烟核对 |

## 执行时注意

- TDD 顺序不要颠倒：每个 Task 都是「写测试 → 确认红 → 实现 → 确认绿 → commit」。
- Python 侧数值库只用 pandas/numpy（Spearman = pandas rank + corr；VIF = numpy.linalg.inv/pinv；特征值 = eigvalsh），**禁止 scipy**。
- 不要做 spec 的非目标：不改 SOTA 选择语义、不做 AST 结构级分析、不算截面因子值、不做磁盘缓存、不拦截任何现有流程。
- 每个 commit 前确认只 add 本任务文件；构建产物（`resources/mcp-server/`、`resources/python/`、`dist/`）均已 gitignore。
